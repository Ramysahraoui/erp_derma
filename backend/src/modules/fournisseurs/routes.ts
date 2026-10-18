import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { booleenRequete } from '../../core/requete.js';
import { pool, query, queryOne, transaction, type Db } from '../../db/pool.js';
import { ErreurMetier, introuvable } from '../../core/erreurs.js';
import { exigeUne } from '../../core/auth.js';
import { aLaPermission } from '../../core/rbac.js';
import { tracer } from '../../core/audit.js';

// Le referentiel fournisseurs sert aux achats, aux receptions et aux depenses.
const LECTURE = ['article:lire', 'achat:lire', 'depense:lire'];
const ECRITURE = ['achat:ecrire', 'depense:ecrire'];

const texte = z.string().trim().max(500).optional().nullable().transform((v) => (v ? v : null));
const champs = {
  code: z.string().trim().min(2, 'Code : 2 caracteres minimum.').max(30).transform((v) => v.toUpperCase()),
  raison_sociale: z.string().trim().min(2, 'Raison sociale : 2 caracteres minimum.').max(200),
  contact: texte,
  telephone: texte,
  email: z.string().trim().optional().nullable()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || z.string().email().safeParse(v).success, 'Adresse e-mail invalide.'),
  adresse: texte,
};

const schemaCreation = z.object({ ...champs, actif: z.boolean().default(true) });
const schemaModification = z.object({
  ...Object.fromEntries(Object.entries(champs).map(([k, v]) => [k, v.optional()])),
  actif: z.boolean().optional(),
}) as z.ZodType<Partial<z.infer<typeof schemaCreation>>>;

async function verifierCodeLibre(db: Db, code: string, saufId?: number): Promise<void> {
  const doublon = await queryOne(db, 'SELECT id, raison_sociale FROM fournisseurs WHERE UPPER(code) = $1 AND id <> $2',
    [code, saufId ?? 0]);
  if (doublon) {
    throw new ErreurMetier('CODE_DEJA_UTILISE', `Le code ${code} est deja attribue au fournisseur ${doublon.raison_sociale}.`, 409);
  }
}

export async function routesFournisseurs(app: FastifyInstance): Promise<void> {
  app.get('/fournisseurs', { preHandler: exigeUne(...LECTURE) }, async (req) => {
    const f = z.object({ recherche: z.string().optional(), actif: booleenRequete().optional() }).parse(req.query);
    return query(
      pool,
      `SELECT f.*,
              (SELECT COUNT(*)::int FROM receptions r WHERE r.fournisseur_id = f.id) AS nb_receptions,
              (SELECT MAX(r.date_reception) FROM receptions r WHERE r.fournisseur_id = f.id) AS derniere_reception,
              (SELECT COUNT(*)::int FROM lots_stock l WHERE l.fournisseur_id = f.id) AS nb_lots
         FROM fournisseurs f
        WHERE ($1::text IS NULL OR f.code ILIKE '%'||$1||'%' OR f.raison_sociale ILIKE '%'||$1||'%'
               OR f.contact ILIKE '%'||$1||'%')
          AND ($2::boolean IS NULL OR f.actif = $2)
        ORDER BY f.actif DESC, f.raison_sociale`,
      [f.recherche || null, f.actif ?? null],
    );
  });

  app.get('/fournisseurs/:id', { preHandler: exigeUne(...LECTURE) }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const fournisseur = await queryOne(pool, 'SELECT * FROM fournisseurs WHERE id = $1', [id]);
    if (!fournisseur) throw introuvable('Fournisseur', id);
    const role = req.utilisateur.role;
    const [receptions, lots, commandes, depenses, modifications] = await Promise.all([
      query(pool,
        `SELECT r.id, r.numero, r.date_reception, r.reference_bl_fournisseur,
                COUNT(l.id)::int AS nb_lots
           FROM receptions r LEFT JOIN lots_stock l ON l.reception_id = r.id
          WHERE r.fournisseur_id = $1 GROUP BY r.id ORDER BY r.date_reception DESC, r.id DESC LIMIT 100`, [id]),
      query(pool,
        `SELECT l.id, l.code_lot_interne, l.code_lot_fournisseur, l.statut, l.dluo, l.qte_actuelle,
                a.code_sku, a.designation, a.unite
           FROM lots_stock l JOIN articles_catalogue a ON a.id = l.article_id
          WHERE l.fournisseur_id = $1 ORDER BY l.id DESC LIMIT 100`, [id]),
      aLaPermission(role, 'achat:lire')
        ? query(pool, `SELECT id, numero, date_commande, statut, total_ht FROM commandes_achat
                        WHERE fournisseur_id = $1 ORDER BY date_commande DESC, id DESC LIMIT 100`, [id])
        : Promise.resolve(null),
      aLaPermission(role, 'depense:lire')
        ? query(pool, `SELECT id, numero, date_depense, libelle, montant_ttc FROM depenses
                        WHERE fournisseur_id = $1 ORDER BY date_depense DESC, id DESC LIMIT 100`, [id])
        : Promise.resolve(null),
      query(pool,
        `SELECT m.*, u.nom_complet AS utilisateur
           FROM fournisseurs_modifications m LEFT JOIN utilisateurs u ON u.id = m.utilisateur_id
          WHERE m.fournisseur_id = $1 ORDER BY m.cree_le DESC, m.id DESC`, [id]),
    ]);
    return { ...fournisseur, receptions, lots, commandes, depenses, modifications };
  });

  app.post('/fournisseurs', { preHandler: exigeUne(...ECRITURE) }, async (req, rep) => {
    const b = schemaCreation.parse(req.body);
    const f = await transaction(async (client) => {
      await verifierCodeLibre(client, b.code);
      const cree = await queryOne(
        client,
        `INSERT INTO fournisseurs (code, raison_sociale, contact, telephone, email, adresse, actif)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [b.code, b.raison_sociale, b.contact, b.telephone, b.email, b.adresse, b.actif],
      );
      await tracer(client, req.utilisateur.id, 'CREATION_FOURNISSEUR', 'fournisseurs', cree!.id, { code: b.code });
      return cree;
    });
    return rep.status(201).send(f);
  });

  app.patch('/fournisseurs/:id', { preHandler: exigeUne(...ECRITURE) }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const demandes = schemaModification.parse(req.body);
    return transaction(async (client) => {
      const avant = await queryOne(client, 'SELECT * FROM fournisseurs WHERE id = $1 FOR UPDATE', [id]);
      if (!avant) throw introuvable('Fournisseur', id);
      if (demandes.code !== undefined && demandes.code !== avant.code) await verifierCodeLibre(client, demandes.code, id);

      // Seuls les champs dont la valeur change sont ecrits et historises.
      const normaliser = (v: unknown) => (v === null || v === undefined ? null : String(v));
      const changements = Object.entries(demandes)
        .filter(([champ, valeur]) => valeur !== undefined && normaliser(avant[champ]) !== normaliser(valeur));
      if (changements.length === 0) return { ...avant, modifications_enregistrees: 0 };

      const colonnes = changements.map(([champ], i) => `${champ} = $${i + 2}`).join(', ');
      const maj = await queryOne(client, `UPDATE fournisseurs SET ${colonnes} WHERE id = $1 RETURNING *`,
        [id, ...changements.map(([, valeur]) => valeur)]);
      for (const [champ, valeur] of changements) {
        await client.query(
          `INSERT INTO fournisseurs_modifications (fournisseur_id, champ, ancienne_valeur, nouvelle_valeur, utilisateur_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, champ, normaliser(avant[champ]), normaliser(valeur), req.utilisateur.id],
        );
      }
      await tracer(client, req.utilisateur.id, 'MAJ_FOURNISSEUR', 'fournisseurs', id, {
        changements: Object.fromEntries(changements.map(([c, v]) => [c, { ancien: normaliser(avant[c]), nouveau: normaliser(v) }])),
      });
      return { ...maj, modifications_enregistrees: changements.length };
    });
  });
}
