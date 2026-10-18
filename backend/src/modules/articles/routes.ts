import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { booleenRequete } from '../../core/requete.js';
import { pool, query, queryOne, transaction } from '../../db/pool.js';
import { ErreurMetier, introuvable } from '../../core/erreurs.js';
import { exige } from '../../core/auth.js';
import { tracer } from '../../core/audit.js';

import { schemaArticle } from './schema.js';
import { creerArticle } from './service.js';

export async function routesArticles(app: FastifyInstance): Promise<void> {
  // ---------------------------- Articles ----------------------------
  app.get('/articles', { preHandler: exige('article:lire') }, async (req) => {
    const f = z
      .object({
        type: z.enum(['MP', 'AC', 'PF']).optional(),
        recherche: z.string().optional(),
        actif: booleenRequete().optional(),
        avec_stock: booleenRequete().optional(),
      })
      .parse(req.query);
    return query(
      pool,
      `SELECT a.*, s.qte_disponible, s.qte_quarantaine, s.valeur_stock,
              (s.qte_disponible < a.seuil_critique) AS sous_seuil
         FROM articles_catalogue a
         JOIN v_stock_disponible s ON s.article_id = a.id
        WHERE ($1::text IS NULL OR a.type = $1::type_article)
          AND ($2::text IS NULL OR a.code_sku ILIKE '%'||$2||'%' OR a.designation ILIKE '%'||$2||'%')
          AND ($3::boolean IS NULL OR a.actif = $3)
          AND ($4::boolean IS NOT TRUE OR s.qte_disponible > 0)
        ORDER BY a.type, a.code_sku`,
      [f.type ?? null, f.recherche ?? null, f.actif ?? null, f.avec_stock ?? null],
    );
  });

  app.get('/articles/:id', { preHandler: exige('article:lire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const article = await queryOne(
      pool,
      `SELECT a.*, s.qte_disponible, s.qte_quarantaine, s.qte_bloquee, s.qte_perimee, s.valeur_stock
         FROM articles_catalogue a JOIN v_stock_disponible s ON s.article_id = a.id WHERE a.id = $1`,
      [id],
    );
    if (!article) throw introuvable('Article', id);
    const lots = await query(
      pool,
      `SELECT l.*, f.raison_sociale AS fournisseur
         FROM lots_stock l LEFT JOIN fournisseurs f ON f.id = l.fournisseur_id
        WHERE l.article_id = $1 AND l.qte_actuelle > 0
        ORDER BY l.dluo NULLS LAST, l.id`,
      [id],
    );
    const nomenclature = article.type === 'PF'
      ? await query(
          pool,
          `SELECT n.*, a.code_sku, a.designation FROM nomenclature_ac n
             JOIN articles_catalogue a ON a.id = n.article_ac_id
            WHERE n.article_pf_id = $1 ORDER BY a.code_sku`,
          [id],
        )
      : [];
    const modifications = await query(
      pool,
      `SELECT m.*, u.nom_complet AS utilisateur FROM articles_modifications m
         LEFT JOIN utilisateurs u ON u.id = m.utilisateur_id
        WHERE m.article_id = $1 ORDER BY m.cree_le DESC, m.id DESC LIMIT 200`,
      [id],
    );
    const activite = await queryOne(
      pool,
      `SELECT (SELECT COUNT(*) FROM lots_stock WHERE article_id = $1)::int AS lots,
              (SELECT COUNT(*) FROM mouvements_stock m JOIN lots_stock l ON l.id = m.lot_stock_id
                WHERE l.article_id = $1)::int AS mouvements,
              (SELECT COUNT(DISTINCT document_id) FROM ventes_lignes WHERE article_id = $1)::int AS documents_vente,
              (SELECT COUNT(DISTINCT formule_id) FROM formule_lignes WHERE article_id = $1)::int AS formules`,
      [id],
    );
    return { ...article, lots, nomenclature, modifications, activite };
  });

  app.post('/articles', { preHandler: exige('article:ecrire') }, async (req, rep) => {
    const b = schemaArticle.parse(req.body);
    const a = await creerArticle(pool, req.utilisateur.id, b);
    return rep.status(201).send(a);
  });

  /**
   * Modification d'un article (CDCF V2 2.1) : code, disponibilite, prix de
   * vente et attributs descriptifs. Chaque champ reellement modifie est
   * historise (ancienne et nouvelle valeur, utilisateur, date). Le code peut
   * changer sans rien rompre : mouvements, lots, formules et documents sont
   * rattaches a l'identifiant interne de l'article, jamais a son code.
   */
  app.patch('/articles/:id', { preHandler: exige('article:ecrire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z
      .object({
        code_sku: z.string().trim().min(2).max(40).regex(/^[A-Z0-9._-]+$/i, 'Code SKU alphanumerique attendu.').optional(),
        designation: z.string().min(2).optional(),
        nom_inci: z.string().nullable().optional(),
        seuil_critique: z.coerce.number().min(0).optional(),
        prix_vente_ht: z.coerce.number().min(0).optional(),
        tva_pct: z.coerce.number().min(0).max(100).optional(),
        contenance_ml: z.coerce.number().positive().nullable().optional(),
        densite: z.coerce.number().positive().max(5).nullable().optional(),
        actif: z.boolean().optional(),
      })
      .parse(req.body);

    return transaction(async (client) => {
      const avant = await queryOne(client, 'SELECT * FROM articles_catalogue WHERE id = $1 FOR UPDATE', [id]);
      if (!avant) throw introuvable('Article', id);

      const demandes: Record<string, unknown> = { ...b };
      if (b.code_sku !== undefined) demandes.code_sku = b.code_sku.toUpperCase();
      if (demandes.code_sku && demandes.code_sku !== avant.code_sku) {
        const doublon = await queryOne(
          client, 'SELECT id FROM articles_catalogue WHERE UPPER(code_sku) = $1 AND id <> $2', [demandes.code_sku, id],
        );
        if (doublon) {
          throw new ErreurMetier('CODE_DEJA_UTILISE', `Le code ${demandes.code_sku} est deja attribue a un autre article.`, 409);
        }
      }
      if (b.contenance_ml && avant.type !== 'PF') {
        throw new ErreurMetier('CHAMP_INAPPLICABLE', 'La contenance ne concerne que les produits finis.', 422);
      }

      // Seuls les champs dont la valeur change sont ecrits et historises.
      const normaliser = (v: unknown) => (v === null || v === undefined ? null : String(v));
      const egal = (champ: string, nouvelle: unknown) => {
        const ancienne = avant[champ];
        // Les colonnes NUMERIC reviennent en chaine : comparaison numerique.
        if (typeof nouvelle === 'number') return ancienne !== null && Number(ancienne) === nouvelle;
        return normaliser(ancienne) === normaliser(nouvelle);
      };
      const changements = Object.entries(demandes).filter(([champ, valeur]) => valeur !== undefined && !egal(champ, valeur));
      if (changements.length === 0) return { ...avant, modifications_enregistrees: 0 };

      const colonnes = changements.map(([champ], i) => `${champ} = $${i + 2}`).join(', ');
      const maj = await queryOne(
        client,
        `UPDATE articles_catalogue SET ${colonnes} WHERE id = $1 RETURNING *`,
        [id, ...changements.map(([, valeur]) => valeur)],
      );
      for (const [champ, valeur] of changements) {
        await client.query(
          `INSERT INTO articles_modifications (article_id, champ, ancienne_valeur, nouvelle_valeur, utilisateur_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, champ, normaliser(avant[champ]), normaliser(valeur), req.utilisateur.id],
        );
      }
      await tracer(client, req.utilisateur.id, 'MAJ_ARTICLE', 'articles_catalogue', id, {
        changements: Object.fromEntries(changements.map(([c, v]) => [c, { ancien: normaliser(avant[c]), nouveau: normaliser(v) }])),
      });
      return { ...maj, modifications_enregistrees: changements.length };
    });
  });

  app.get('/articles/:id/modifications', { preHandler: exige('article:lire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    return query(
      pool,
      `SELECT m.*, u.nom_complet AS utilisateur
         FROM articles_modifications m LEFT JOIN utilisateurs u ON u.id = m.utilisateur_id
        WHERE m.article_id = $1 ORDER BY m.cree_le DESC, m.id DESC`,
      [id],
    );
  });

  // ------------------------ Nomenclature AC -------------------------
  app.put('/articles/:id/nomenclature', { preHandler: exige('article:ecrire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const lignes = z
      .array(
        z.object({
          article_ac_id: z.coerce.number().int(),
          qte_par_unite: z.coerce.number().positive(),
          obligatoire: z.boolean().default(true),
        }),
      )
      .parse(req.body);
    const pf = await queryOne(pool, 'SELECT id, type FROM articles_catalogue WHERE id = $1', [id]);
    if (!pf) throw introuvable('Article', id);
    if (pf.type !== 'PF') throw new ErreurMetier('TYPE_INVALIDE', 'La nomenclature de conditionnement ne concerne que les produits finis.', 422);
    const types = await query(pool, 'SELECT id, type FROM articles_catalogue WHERE id = ANY($1::bigint[])', [lignes.map((l) => l.article_ac_id)]);
    for (const l of lignes) {
      const t = types.find((x) => x.id === l.article_ac_id);
      if (!t) throw introuvable('Article de conditionnement', l.article_ac_id);
      if (t.type !== 'AC') throw new ErreurMetier('TYPE_INVALIDE', `L'article ${l.article_ac_id} n'est pas un article de conditionnement.`, 422);
    }
    await pool.query('BEGIN');
    try {
      await pool.query('DELETE FROM nomenclature_ac WHERE article_pf_id = $1', [id]);
      for (const l of lignes) {
        await pool.query(
          'INSERT INTO nomenclature_ac (article_pf_id, article_ac_id, qte_par_unite, obligatoire) VALUES ($1,$2,$3,$4)',
          [id, l.article_ac_id, l.qte_par_unite, l.obligatoire],
        );
      }
      await tracer(pool, req.utilisateur.id, 'MAJ_NOMENCLATURE', 'articles_catalogue', id, { lignes: lignes.length });
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }
    return query(
      pool,
      `SELECT n.*, a.code_sku, a.designation FROM nomenclature_ac n
         JOIN articles_catalogue a ON a.id = n.article_ac_id WHERE n.article_pf_id = $1 ORDER BY a.code_sku`,
      [id],
    );
  });

  // ---------------------------- Fournisseurs ------------------------
  app.get('/fournisseurs', { preHandler: exige('article:lire') }, async () =>
    query(pool, 'SELECT * FROM fournisseurs ORDER BY raison_sociale'),
  );

  app.post('/fournisseurs', { preHandler: exige('achat:ecrire') }, async (req, rep) => {
    const b = z
      .object({
        code: z.string().min(2),
        raison_sociale: z.string().min(2),
        contact: z.string().optional().nullable(),
        telephone: z.string().optional().nullable(),
        email: z.string().email().optional().nullable(),
        adresse: z.string().optional().nullable(),
      })
      .parse(req.body);
    const f = await queryOne(
      pool,
      `INSERT INTO fournisseurs (code, raison_sociale, contact, telephone, email, adresse)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.code.toUpperCase(), b.raison_sociale, b.contact ?? null, b.telephone ?? null, b.email ?? null, b.adresse ?? null],
    );
    return rep.status(201).send(f);
  });
}
