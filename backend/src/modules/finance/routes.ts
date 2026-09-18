import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, query, queryOne } from '../../db/pool.js';
import { introuvable } from '../../core/erreurs.js';
import { exige } from '../../core/auth.js';
import { tracer } from '../../core/audit.js';
import { genererNumero } from '../../core/numerotation.js';
import { d, m2 } from '../../core/nombres.js';
import { PARAMETRES_DEFAUT } from '../../core/parametres.js';

export async function routesFinance(app: FastifyInstance): Promise<void> {
  // -------------------- Journal des depenses -------------------------
  app.get('/depenses/categories', { preHandler: exige('depense:lire') }, async () =>
    query(pool, 'SELECT * FROM depenses_categories ORDER BY type, libelle'),
  );

  app.post('/depenses/categories', { preHandler: exige('depense:ecrire') }, async (req, rep) => {
    const b = z
      .object({ code: z.string().min(2), libelle: z.string().min(2), type: z.enum(['DIRECTE', 'INDIRECTE']) })
      .parse(req.body);
    const c = await queryOne(
      pool, 'INSERT INTO depenses_categories (code, libelle, type) VALUES ($1,$2,$3) RETURNING *',
      [b.code.toUpperCase(), b.libelle, b.type],
    );
    return rep.status(201).send(c);
  });

  app.get('/depenses', { preHandler: exige('depense:lire') }, async (req) => {
    const f = z
      .object({
        categorie_id: z.coerce.number().int().optional(),
        type: z.enum(['DIRECTE', 'INDIRECTE']).optional(),
        depuis: z.string().date().optional(),
        jusqua: z.string().date().optional(),
        rapproche: z.coerce.boolean().optional(),
      })
      .parse(req.query);
    return query(
      pool,
      `SELECT dp.*, dc.libelle AS categorie, dc.type AS type_charge, f.raison_sociale AS fournisseur, o.code_of
         FROM depenses dp
         JOIN depenses_categories dc ON dc.id = dp.categorie_id
         LEFT JOIN fournisseurs f ON f.id = dp.fournisseur_id
         LEFT JOIN ordres_fabrication o ON o.id = dp.of_id
        WHERE ($1::bigint IS NULL OR dp.categorie_id = $1)
          AND ($2::text IS NULL OR dc.type = $2::type_charge)
          AND ($3::date IS NULL OR dp.date_depense >= $3::date)
          AND ($4::date IS NULL OR dp.date_depense <= $4::date)
          AND ($5::boolean IS NULL OR dp.rapproche = $5)
        ORDER BY dp.date_depense DESC, dp.id DESC LIMIT 500`,
      [f.categorie_id ?? null, f.type ?? null, f.depuis ?? null, f.jusqua ?? null, f.rapproche ?? null],
    );
  });

  app.post('/depenses', { preHandler: exige('depense:ecrire') }, async (req, rep) => {
    const b = z
      .object({
        categorie_id: z.coerce.number().int(),
        libelle: z.string().min(2),
        date_depense: z.string().date().optional().nullable(),
        montant_ht: z.coerce.number().min(0),
        tva_pct: z.coerce.number().min(0).max(100).default(19),
        mode_paiement: z.enum(['ESPECES', 'CHEQUE', 'VIREMENT']).optional().nullable(),
        fournisseur_id: z.coerce.number().int().optional().nullable(),
        of_id: z.coerce.number().int().optional().nullable(),
        piece_jointe: z.string().optional().nullable(),
      })
      .parse(req.body);
    const numero = await genererNumero(pool, 'DEP');
    const ttc = d(b.montant_ht).times(d(100).plus(b.tva_pct).dividedBy(100));
    const dep = await queryOne(
      pool,
      `INSERT INTO depenses (numero, categorie_id, libelle, date_depense, montant_ht, tva_pct, montant_ttc,
                             mode_paiement, fournisseur_id, of_id, piece_jointe, cree_par)
       VALUES ($1,$2,$3,COALESCE($4::date,CURRENT_DATE),$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [numero, b.categorie_id, b.libelle, b.date_depense ?? null, m2(b.montant_ht), b.tva_pct, m2(ttc),
       b.mode_paiement ?? null, b.fournisseur_id ?? null, b.of_id ?? null, b.piece_jointe ?? null, req.utilisateur.id],
    );
    await tracer(pool, req.utilisateur.id, 'CREATION_DEPENSE', 'depenses', dep!.id, { numero, montant_ht: m2(b.montant_ht) });
    return rep.status(201).send(dep);
  });

  app.post('/depenses/:id/rapprochement', { preHandler: exige('depense:ecrire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z.object({ rapproche: z.boolean() }).parse(req.body);
    const dep = await queryOne(pool, 'UPDATE depenses SET rapproche = $2 WHERE id = $1 RETURNING *', [id, b.rapproche]);
    if (!dep) throw introuvable('Depense', id);
    return dep;
  });

  // Rapprochement bancaire simplifie : recettes encaissees vs depenses payees.
  app.get('/tresorerie', { preHandler: exige('finance:lire') }, async (req) => {
    const f = z.object({ depuis: z.string().date().optional(), jusqua: z.string().date().optional() }).parse(req.query);
    const recettes = await query(
      pool,
      `SELECT date_trunc('month', date_reglement)::date AS mois, mode_reglement,
              SUM(montant_verse) AS total, COUNT(*) AS nombre
         FROM encaissements
        WHERE ($1::date IS NULL OR date_reglement >= $1::date)
          AND ($2::date IS NULL OR date_reglement <= $2::date)
          AND (mode_reglement <> 'CHEQUE' OR cheque_statut = 'ENCAISSE')
        GROUP BY 1, 2 ORDER BY 1 DESC`,
      [f.depuis ?? null, f.jusqua ?? null],
    );
    const depenses = await query(
      pool,
      `SELECT date_trunc('month', dp.date_depense)::date AS mois, dc.type AS type_charge,
              SUM(dp.montant_ttc) AS total, COUNT(*) AS nombre
         FROM depenses dp JOIN depenses_categories dc ON dc.id = dp.categorie_id
        WHERE ($1::date IS NULL OR dp.date_depense >= $1::date)
          AND ($2::date IS NULL OR dp.date_depense <= $2::date)
        GROUP BY 1, 2 ORDER BY 1 DESC`,
      [f.depuis ?? null, f.jusqua ?? null],
    );
    const totalRecettes = recettes.reduce((a, r) => a.plus(r.total), d(0));
    const totalDepenses = depenses.reduce((a, r) => a.plus(r.total), d(0));
    return {
      recettes, depenses,
      synthese: {
        total_recettes: m2(totalRecettes),
        total_depenses: m2(totalDepenses),
        solde: m2(totalRecettes.minus(totalDepenses)),
      },
    };
  });

  // ------------------------------- RH --------------------------------
  app.get('/salaries', { preHandler: exige('rh:lire') }, async () =>
    query(pool, 'SELECT * FROM salaries ORDER BY nom, prenom'),
  );

  app.post('/salaries', { preHandler: exige('rh:lire') }, async (req, rep) => {
    const b = z
      .object({
        matricule: z.string().min(1),
        nom: z.string().min(1),
        prenom: z.string().min(1),
        date_naissance: z.string().date().optional().nullable(),
        fonction: z.string().min(2),
        departement: z.string().min(2),
        type_contrat: z.string().min(2),
        date_embauche: z.string().date().optional().nullable(),
        salaire_base: z.coerce.number().min(0).default(0),
        taux_horaire: z.coerce.number().min(0).default(0),
      })
      .parse(req.body);
    const s = await queryOne(
      pool,
      `INSERT INTO salaries (matricule, nom, prenom, date_naissance, fonction, departement, type_contrat,
                             date_embauche, salaire_base, taux_horaire)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8::date,$9,$10) RETURNING *`,
      [b.matricule.toUpperCase(), b.nom, b.prenom, b.date_naissance ?? null, b.fonction, b.departement,
       b.type_contrat, b.date_embauche ?? null, b.salaire_base, b.taux_horaire],
    );
    return rep.status(201).send(s);
  });

  app.patch('/salaries/:id', { preHandler: exige('rh:lire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z
      .object({
        fonction: z.string().optional(), departement: z.string().optional(), type_contrat: z.string().optional(),
        salaire_base: z.coerce.number().min(0).optional(), taux_horaire: z.coerce.number().min(0).optional(),
        actif: z.boolean().optional(),
      })
      .parse(req.body);
    const s = await queryOne(
      pool,
      `UPDATE salaries SET fonction = COALESCE($2, fonction), departement = COALESCE($3, departement),
              type_contrat = COALESCE($4, type_contrat), salaire_base = COALESCE($5, salaire_base),
              taux_horaire = COALESCE($6, taux_horaire), actif = COALESCE($7, actif)
        WHERE id = $1 RETURNING *`,
      [id, b.fonction ?? null, b.departement ?? null, b.type_contrat ?? null, b.salaire_base ?? null,
       b.taux_horaire ?? null, b.actif ?? null],
    );
    if (!s) throw introuvable('Salarie', id);
    return s;
  });

  app.get('/pointages', { preHandler: exige('rh:lire') }, async (req) => {
    const f = z
      .object({
        salarie_id: z.coerce.number().int().optional(),
        of_id: z.coerce.number().int().optional(),
        depuis: z.string().date().optional(),
        jusqua: z.string().date().optional(),
      })
      .parse(req.query);
    return query(
      pool,
      `SELECT p.*, s.matricule, s.nom, s.prenom, s.taux_horaire, o.code_of,
              (p.heures * s.taux_horaire) AS cout_main_oeuvre
         FROM pointages p JOIN salaries s ON s.id = p.salarie_id
         LEFT JOIN ordres_fabrication o ON o.id = p.of_id
        WHERE ($1::bigint IS NULL OR p.salarie_id = $1)
          AND ($2::bigint IS NULL OR p.of_id = $2)
          AND ($3::date IS NULL OR p.date_jour >= $3::date)
          AND ($4::date IS NULL OR p.date_jour <= $4::date)
        ORDER BY p.date_jour DESC, p.id DESC LIMIT 500`,
      [f.salarie_id ?? null, f.of_id ?? null, f.depuis ?? null, f.jusqua ?? null],
    );
  });

  app.post('/pointages', { preHandler: exige('rh:lire') }, async (req, rep) => {
    const b = z
      .object({
        salarie_id: z.coerce.number().int(),
        date_jour: z.string().date(),
        heures: z.coerce.number().positive().max(24),
        departement: z.string().min(2),
        of_id: z.coerce.number().int().optional().nullable(),
        commentaire: z.string().optional().nullable(),
      })
      .parse(req.body);
    const p = await queryOne(
      pool,
      `INSERT INTO pointages (salarie_id, date_jour, heures, departement, of_id, commentaire)
       VALUES ($1,$2::date,$3,$4,$5,$6) RETURNING *`,
      [b.salarie_id, b.date_jour, b.heures, b.departement, b.of_id ?? null, b.commentaire ?? null],
    );
    return rep.status(201).send(p);
  });

  app.get('/rh/synthese', { preHandler: exige('rh:lire') }, async (req) => {
    const f = z.object({ depuis: z.string().date().optional(), jusqua: z.string().date().optional() }).parse(req.query);
    return query(
      pool,
      `SELECT p.departement, COUNT(DISTINCT p.salarie_id) AS effectif, SUM(p.heures) AS heures,
              SUM(p.heures * s.taux_horaire) AS cout_main_oeuvre
         FROM pointages p JOIN salaries s ON s.id = p.salarie_id
        WHERE ($1::date IS NULL OR p.date_jour >= $1::date)
          AND ($2::date IS NULL OR p.date_jour <= $2::date)
        GROUP BY p.departement ORDER BY p.departement`,
      [f.depuis ?? null, f.jusqua ?? null],
    );
  });

  // ------------------------- Parametrage -----------------------------
  app.get('/parametres', { preHandler: exige('finance:lire') }, async () => {
    const enBase = await query(pool, 'SELECT * FROM parametres ORDER BY cle');
    const connus = new Map(enBase.map((p) => [p.cle, p]));
    return Object.entries(PARAMETRES_DEFAUT).map(([cle, def]) =>
      connus.get(cle) ?? { cle, valeur: def.valeur, libelle: def.libelle, maj_le: null },
    );
  });

  app.put('/parametres/:cle', { preHandler: exige('*') }, async (req) => {
    const { cle } = z.object({ cle: z.string().min(2) }).parse(req.params);
    const b = z.object({ valeur: z.string().min(1) }).parse(req.body);
    const p = await queryOne(
      pool,
      `INSERT INTO parametres (cle, valeur, libelle) VALUES ($1,$2,$3)
       ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur, maj_le = NOW() RETURNING *`,
      [cle, b.valeur, PARAMETRES_DEFAUT[cle]?.libelle ?? cle],
    );
    await tracer(pool, req.utilisateur.id, 'MAJ_PARAMETRE', 'parametres', cle, { valeur: b.valeur });
    return p;
  });

  // --------------------- Analyse de rentabilite ----------------------
  app.get('/analyse/rentabilite', { preHandler: exige('finance:lire') }, async (req) => {
    const f = z.object({ depuis: z.string().date().optional(), jusqua: z.string().date().optional() }).parse(req.query);
    const parProduit = await query(
      pool,
      `SELECT a.id AS article_id, a.code_sku, a.designation, a.pamp AS cout_moyen, a.prix_vente_ht,
              COALESCE(SUM(vl.quantite), 0) AS quantite_vendue,
              COALESCE(SUM(vl.quantite * vl.prix_unitaire * (100 - vl.remise_pct) / 100), 0) AS ca_ht,
              COALESCE(SUM(vl.quantite * vl.cout_unitaire), 0) AS cout_revient_total,
              COALESCE(SUM(vl.quantite * vl.prix_unitaire * (100 - vl.remise_pct) / 100
                           - vl.quantite * vl.cout_unitaire), 0) AS marge_brute
         FROM articles_catalogue a
         LEFT JOIN ventes_lignes vl ON vl.article_id = a.id
         LEFT JOIN ventes_documents vd ON vd.id = vl.document_id
              AND vd.statut = 'VALIDE' AND vd.type_doc = 'FACTURE'
              AND ($1::date IS NULL OR vd.date_doc >= $1::date)
              AND ($2::date IS NULL OR vd.date_doc <= $2::date)
        WHERE a.type = 'PF'
        GROUP BY a.id ORDER BY marge_brute DESC`,
      [f.depuis ?? null, f.jusqua ?? null],
    );
    const parOf = await query(
      pool,
      `SELECT o.id, o.code_of, o.statut_of, o.date_cloture, o.unites_produites, o.rendement_pct,
              o.cout_mp, o.cout_ac, o.cout_main_oeuvre, o.cout_charges_indirectes, o.cru,
              f.nom_produit, a.code_sku, a.prix_vente_ht,
              (a.prix_vente_ht - o.cru) AS marge_unitaire
         FROM ordres_fabrication o
         JOIN formules f ON f.id = o.formule_id
         LEFT JOIN articles_catalogue a ON a.id = o.article_pf_id
        WHERE o.statut_of = 'CLOTURE'
          AND ($1::date IS NULL OR o.date_cloture >= $1::date)
          AND ($2::date IS NULL OR o.date_cloture <= $2::date)
        ORDER BY o.date_cloture DESC LIMIT 200`,
      [f.depuis ?? null, f.jusqua ?? null],
    );
    return { par_produit: parProduit, par_ordre_fabrication: parOf };
  });

  // -------------------- Tableau de bord direction --------------------
  app.get('/tableau-de-bord', { preHandler: exige('stock:lire') }, async (req) => {
    const ventes = await queryOne(
      pool,
      `SELECT COALESCE(SUM(total_ht),0) AS ca_ht_mois, COALESCE(SUM(marge_brute),0) AS marge_mois, COUNT(*) AS nb_factures
         FROM ventes_documents
        WHERE type_doc = 'FACTURE' AND statut = 'VALIDE' AND date_doc >= date_trunc('month', CURRENT_DATE)`,
    );
    const creances = await queryOne(
      pool, 'SELECT COALESCE(SUM(solde_du),0) AS total, COUNT(*) AS nombre FROM v_balance_agee',
    );
    const production = await queryOne(
      pool,
      `SELECT COUNT(*) FILTER (WHERE statut_of NOT IN ('CLOTURE','ANNULE')) AS of_en_cours,
              COUNT(*) FILTER (WHERE statut_of = 'CLOTURE' AND date_cloture >= date_trunc('month', CURRENT_DATE)) AS of_clotures_mois,
              COALESCE(AVG(rendement_pct) FILTER (WHERE statut_of = 'CLOTURE'), 0) AS rendement_moyen
         FROM ordres_fabrication`,
    );
    const stock = await queryOne(
      pool,
      `SELECT COALESCE(SUM(valeur_stock),0) AS valeur_totale,
              COUNT(*) FILTER (WHERE qte_disponible < seuil_critique AND seuil_critique > 0) AS articles_sous_seuil
         FROM v_stock_disponible`,
    );
    const depenses = await queryOne(
      pool,
      `SELECT COALESCE(SUM(montant_ht),0) AS total_mois FROM depenses WHERE date_depense >= date_trunc('month', CURRENT_DATE)`,
    );
    const alertesQualite = await queryOne(
      pool,
      `SELECT COUNT(*) FILTER (WHERE statut = 'QUARANTAINE') AS lots_quarantaine,
              COUNT(*) FILTER (WHERE dluo IS NOT NULL AND dluo < CURRENT_DATE AND qte_actuelle > 0) AS lots_perimes
         FROM lots_stock`,
    );
    return { ventes, creances, production, stock, depenses, qualite: alertesQualite };
  });
}
