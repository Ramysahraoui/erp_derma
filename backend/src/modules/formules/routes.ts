import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, query, queryOne, transaction } from '../../db/pool.js';
import { ErreurMetier, introuvable } from '../../core/erreurs.js';
import { exige } from '../../core/auth.js';
import { tracer } from '../../core/audit.js';
import { controlerSommePonderale, lignesDeFormule, miseAEchelle, remplacerLignes } from './service.js';

const schemaLigne = z.object({
  article_id: z.coerce.number().int(),
  phase: z.enum(['A', 'B', 'C', 'D', 'E']),
  pourcentage_w_w: z.coerce
    .number()
    .gt(0, 'Le pourcentage doit etre strictement superieur a 0.')
    .max(100, 'Le pourcentage ne peut exceder 100 %.'),
  consigne: z.string().optional().nullable(),
  ordre: z.coerce.number().int().optional(),
});

const schemaFormule = z.object({
  code_formule: z.string().min(2).max(40),
  nom_produit: z.string().min(2),
  densite: z.coerce.number().gt(0).max(5),
  article_pf_id: z.coerce.number().int().optional().nullable(),
  perte_process_pct: z.coerce.number().min(0).max(50).default(0),
  ph_min: z.coerce.number().min(0).max(14).optional().nullable(),
  ph_max: z.coerce.number().min(0).max(14).optional().nullable(),
  viscosite_min: z.coerce.number().min(0).optional().nullable(),
  viscosite_max: z.coerce.number().min(0).optional().nullable(),
  commentaire: z.string().optional().nullable(),
  lignes: z.array(schemaLigne).optional(),
});

export async function routesFormules(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: exige('formule:lire') }, async (req) => {
    const f = z
      .object({
        recherche: z.string().optional(),
        statut: z.enum(['BROUILLON', 'VALIDEE', 'ARCHIVEE']).optional(),
        derniere_version: z.coerce.boolean().optional(),
      })
      .parse(req.query);
    return query(
      pool,
      `SELECT f.*, a.code_sku AS pf_code_sku, a.designation AS pf_designation,
              (SELECT COALESCE(SUM(pourcentage_w_w),0) FROM formule_lignes fl WHERE fl.formule_id = f.id) AS somme_ponderale,
              (SELECT COUNT(*) FROM formule_lignes fl WHERE fl.formule_id = f.id) AS nb_ingredients
         FROM formules f
         LEFT JOIN articles_catalogue a ON a.id = f.article_pf_id
        WHERE ($1::text IS NULL OR f.code_formule ILIKE '%'||$1||'%' OR f.nom_produit ILIKE '%'||$1||'%')
          AND ($2::text IS NULL OR f.statut = $2::statut_formule)
          AND ($3::boolean IS NOT TRUE OR f.version = (SELECT MAX(v.version) FROM formules v WHERE v.code_formule = f.code_formule))
        ORDER BY f.code_formule, f.version DESC`,
      [f.recherche ?? null, f.statut ?? null, f.derniere_version ?? null],
    );
  });

  app.get('/:id', { preHandler: exige('formule:lire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const formule = await queryOne(
      pool,
      `SELECT f.*, a.code_sku AS pf_code_sku, a.designation AS pf_designation, a.contenance_ml,
              u.nom_complet AS auteur
         FROM formules f
         LEFT JOIN articles_catalogue a ON a.id = f.article_pf_id
         LEFT JOIN utilisateurs u ON u.id = f.cree_par
        WHERE f.id = $1`,
      [id],
    );
    if (!formule) throw introuvable('Formule', id);
    const lignes = await lignesDeFormule(pool, id);
    const somme = lignes.reduce((acc, l) => acc + Number(l.pourcentage_w_w), 0);
    const versions = await query(
      pool,
      'SELECT id, version, statut, cree_le FROM formules WHERE code_formule = $1 ORDER BY version DESC',
      [formule.code_formule],
    );
    return { ...formule, lignes, somme_ponderale: somme.toFixed(3), versions };
  });

  // Creation : entete + tableau d'ingredients dans une seule transaction.
  app.post('/', { preHandler: exige('formule:ecrire') }, async (req, rep) => {
    const b = schemaFormule.parse(req.body);
    if (b.lignes?.length) controlerSommePonderale(b.lignes);
    const resultat = await transaction(async (client) => {
      const formule = await queryOne(
        client,
        `INSERT INTO formules (code_formule, version, nom_produit, densite, article_pf_id, perte_process_pct,
                               ph_min, ph_max, viscosite_min, viscosite_max, commentaire, cree_par)
         VALUES ($1,
                 COALESCE((SELECT MAX(version)+1 FROM formules WHERE code_formule = $1), 1),
                 $2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [b.code_formule.toUpperCase(), b.nom_produit, b.densite, b.article_pf_id ?? null, b.perte_process_pct,
         b.ph_min ?? null, b.ph_max ?? null, b.viscosite_min ?? null, b.viscosite_max ?? null,
         b.commentaire ?? null, req.utilisateur.id],
      );
      if (b.lignes?.length) await remplacerLignes(client, formule!.id, b.lignes);
      await tracer(client, req.utilisateur.id, 'CREATION_FORMULE', 'formules', formule!.id, {
        code_formule: formule!.code_formule, version: formule!.version,
      });
      return formule;
    });
    return rep.status(201).send(resultat);
  });

  app.patch('/:id', { preHandler: exige('formule:ecrire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = schemaFormule.partial().omit({ code_formule: true, lignes: true }).parse(req.body);
    const formule = await queryOne(pool, 'SELECT * FROM formules WHERE id = $1', [id]);
    if (!formule) throw introuvable('Formule', id);
    if (formule.statut !== 'BROUILLON') {
      throw new ErreurMetier('FORMULE_VERROUILLEE', 'Seule une formule en brouillon est modifiable. Creer une nouvelle version.', 422);
    }
    const maj = await queryOne(
      pool,
      `UPDATE formules SET
         nom_produit       = COALESCE($2, nom_produit),
         densite           = COALESCE($3, densite),
         article_pf_id     = COALESCE($4, article_pf_id),
         perte_process_pct = COALESCE($5, perte_process_pct),
         ph_min            = COALESCE($6, ph_min),
         ph_max            = COALESCE($7, ph_max),
         viscosite_min     = COALESCE($8, viscosite_min),
         viscosite_max     = COALESCE($9, viscosite_max),
         commentaire       = COALESCE($10, commentaire)
       WHERE id = $1 RETURNING *`,
      [id, b.nom_produit ?? null, b.densite ?? null, b.article_pf_id ?? null, b.perte_process_pct ?? null,
       b.ph_min ?? null, b.ph_max ?? null, b.viscosite_min ?? null, b.viscosite_max ?? null, b.commentaire ?? null],
    );
    await tracer(pool, req.utilisateur.id, 'MAJ_FORMULE', 'formules', id, b);
    return maj;
  });

  // Tableau d'ingredients : remplacement atomique + controle des 100,000 %.
  app.put('/:id/lignes', { preHandler: exige('formule:ecrire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const lignes = z.array(schemaLigne).parse(req.body);
    const resultat = await transaction(async (client) => {
      const out = await remplacerLignes(client, id, lignes);
      await tracer(client, req.utilisateur.id, 'MAJ_LIGNES_FORMULE', 'formules', id, { nb_lignes: lignes.length });
      return out;
    });
    return resultat;
  });

  // Validation R&D : la formule devient utilisable en production.
  app.post('/:id/valider', { preHandler: exige('formule:ecrire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const lignes = await lignesDeFormule(pool, id);
    if (lignes.length === 0) throw new ErreurMetier('FORMULE_VIDE', 'Impossible de valider une formule sans ingredient.', 422);
    controlerSommePonderale(lignes);
    const maj = await queryOne(pool, "UPDATE formules SET statut = 'VALIDEE' WHERE id = $1 RETURNING *", [id]);
    if (!maj) throw introuvable('Formule', id);
    await tracer(pool, req.utilisateur.id, 'VALIDATION_FORMULE', 'formules', id, {});
    return maj;
  });

  // Nouvelle version : duplication complete de la formule et de ses lignes.
  app.post('/:id/nouvelle-version', { preHandler: exige('formule:ecrire') }, async (req, rep) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const resultat = await transaction(async (client) => {
      const src = await queryOne(client, 'SELECT * FROM formules WHERE id = $1', [id]);
      if (!src) throw introuvable('Formule', id);
      const nouvelle = await queryOne(
        client,
        `INSERT INTO formules (code_formule, version, nom_produit, densite, article_pf_id, perte_process_pct,
                               ph_min, ph_max, viscosite_min, viscosite_max, commentaire, cree_par)
         SELECT code_formule, (SELECT MAX(version)+1 FROM formules WHERE code_formule = f.code_formule),
                nom_produit, densite, article_pf_id, perte_process_pct, ph_min, ph_max,
                viscosite_min, viscosite_max, commentaire, $2
           FROM formules f WHERE f.id = $1 RETURNING *`,
        [id, req.utilisateur.id],
      );
      await client.query(
        `INSERT INTO formule_lignes (formule_id, article_id, phase, pourcentage_w_w, consigne, ordre)
         SELECT $2, article_id, phase, pourcentage_w_w, consigne, ordre FROM formule_lignes WHERE formule_id = $1`,
        [id, nouvelle!.id],
      );
      await client.query("UPDATE formules SET statut = 'ARCHIVEE' WHERE id = $1 AND statut = 'VALIDEE'", [id]);
      await tracer(client, req.utilisateur.id, 'NOUVELLE_VERSION_FORMULE', 'formules', nouvelle!.id, { source: id });
      return nouvelle;
    });
    return rep.status(201).send(resultat);
  });

  // Simulateur de mise a l'echelle (batch scaling), sans effet de bord.
  app.post('/:id/mise-a-echelle', { preHandler: exige('formule:lire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z
      .object({
        masse_nette_kg: z.coerce.number().positive().optional().nullable(),
        unites_pf: z.coerce.number().int().positive().optional().nullable(),
        surdosage_pct: z.coerce.number().min(0).max(50).default(0),
      })
      .parse(req.body ?? {});
    return miseAEchelle(pool, id, b);
  });
}
