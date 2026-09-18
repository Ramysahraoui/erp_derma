import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, query, queryOne } from '../../db/pool.js';
import { ErreurMetier, introuvable } from '../../core/erreurs.js';
import { exige } from '../../core/auth.js';
import { tracer } from '../../core/audit.js';

const UNITES_MP = ['g', 'kg', 'L', 'ml'] as const;

const schemaArticle = z
  .object({
    code_sku: z.string().min(2).max(40).regex(/^[A-Z0-9._-]+$/i, 'Code SKU alphanumerique attendu.'),
    designation: z.string().min(2),
    type: z.enum(['MP', 'AC', 'PF']),
    unite: z.string().min(1),
    nom_inci: z.string().optional().nullable(),
    seuil_critique: z.coerce.number().min(0).default(0),
    prix_vente_ht: z.coerce.number().min(0).default(0),
    tva_pct: z.coerce.number().min(0).max(100).default(19),
    contenance_ml: z.coerce.number().positive().optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'MP' && !UNITES_MP.includes(v.unite as (typeof UNITES_MP)[number])) {
      ctx.addIssue({ code: 'custom', path: ['unite'], message: "Une matiere premiere s'exprime en g, kg, L ou ml." });
    }
    if (v.type !== 'MP' && v.unite !== 'U') {
      ctx.addIssue({ code: 'custom', path: ['unite'], message: "Un AC ou un PF s'exprime en unites (U)." });
    }
    if (v.type !== 'PF' && v.contenance_ml) {
      ctx.addIssue({ code: 'custom', path: ['contenance_ml'], message: 'La contenance ne concerne que les produits finis.' });
    }
  });

export async function routesArticles(app: FastifyInstance): Promise<void> {
  // ---------------------------- Articles ----------------------------
  app.get('/articles', { preHandler: exige('article:lire') }, async (req) => {
    const f = z
      .object({
        type: z.enum(['MP', 'AC', 'PF']).optional(),
        recherche: z.string().optional(),
        actif: z.coerce.boolean().optional(),
        avec_stock: z.coerce.boolean().optional(),
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
    return { ...article, lots, nomenclature };
  });

  app.post('/articles', { preHandler: exige('article:ecrire') }, async (req, rep) => {
    const b = schemaArticle.parse(req.body);
    const a = await queryOne(
      pool,
      `INSERT INTO articles_catalogue (code_sku, designation, type, unite, nom_inci, seuil_critique, prix_vente_ht, tva_pct, contenance_ml)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [b.code_sku.toUpperCase(), b.designation, b.type, b.unite, b.nom_inci ?? null, b.seuil_critique,
       b.prix_vente_ht, b.tva_pct, b.contenance_ml ?? null],
    );
    await tracer(pool, req.utilisateur.id, 'CREATION_ARTICLE', 'articles_catalogue', a!.id, { code_sku: a!.code_sku });
    return rep.status(201).send(a);
  });

  app.patch('/articles/:id', { preHandler: exige('article:ecrire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z
      .object({
        designation: z.string().min(2).optional(),
        nom_inci: z.string().nullable().optional(),
        seuil_critique: z.coerce.number().min(0).optional(),
        prix_vente_ht: z.coerce.number().min(0).optional(),
        tva_pct: z.coerce.number().min(0).max(100).optional(),
        contenance_ml: z.coerce.number().positive().nullable().optional(),
        actif: z.boolean().optional(),
      })
      .parse(req.body);
    const a = await queryOne(
      pool,
      `UPDATE articles_catalogue SET
         designation    = COALESCE($2, designation),
         nom_inci       = COALESCE($3, nom_inci),
         seuil_critique = COALESCE($4, seuil_critique),
         prix_vente_ht  = COALESCE($5, prix_vente_ht),
         tva_pct        = COALESCE($6, tva_pct),
         contenance_ml  = COALESCE($7, contenance_ml),
         actif          = COALESCE($8, actif)
       WHERE id = $1 RETURNING *`,
      [id, b.designation ?? null, b.nom_inci ?? null, b.seuil_critique ?? null, b.prix_vente_ht ?? null,
       b.tva_pct ?? null, b.contenance_ml ?? null, b.actif ?? null],
    );
    if (!a) throw introuvable('Article', id);
    await tracer(pool, req.utilisateur.id, 'MAJ_ARTICLE', 'articles_catalogue', id, b);
    return a;
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
