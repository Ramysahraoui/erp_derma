import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, query, queryOne, transaction } from '../../db/pool.js';
import { ErreurMetier, introuvable } from '../../core/erreurs.js';
import { exige } from '../../core/auth.js';
import { tracer } from '../../core/audit.js';
import { miseAEchelle } from '../formules/service.js';
import {
  cloturerFabrication, cloturerOf, conditionner, controlerFaisabilite,
  creerOf, dossierDeLot, enregistrerPesee, libererVrac, propositionFefoLigne,
} from './service.js';

export async function routesProduction(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: exige('production:lire') }, async (req) => {
    const f = z
      .object({
        statut: z.string().optional(),
        recherche: z.string().optional(),
        limite: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    return query(
      pool,
      `SELECT o.*, f.code_formule, f.version AS formule_version, f.nom_produit,
              a.code_sku AS pf_code_sku, v.code_lot_vrac, v.statut AS statut_vrac,
              (SELECT COUNT(*) FROM of_lignes_theoriques l WHERE l.of_id = o.id) AS nb_lignes,
              (SELECT COUNT(*) FROM of_pesees_reelles p WHERE p.of_id = o.id AND p.valide) AS nb_pesees
         FROM ordres_fabrication o
         JOIN formules f ON f.id = o.formule_id
         LEFT JOIN articles_catalogue a ON a.id = o.article_pf_id
         LEFT JOIN lots_vrac v ON v.id = o.lot_vrac_id
        WHERE ($1::text IS NULL OR o.statut_of = $1::statut_of)
          AND ($2::text IS NULL OR o.code_of ILIKE '%'||$2||'%' OR f.nom_produit ILIKE '%'||$2||'%')
        ORDER BY o.id DESC LIMIT $3`,
      [f.statut ?? null, f.recherche ?? null, f.limite],
    );
  });

  app.get('/:id', { preHandler: exige('production:lire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    return dossierDeLot(pool, id);
  });

  // Simulation prealable : faisabilite + fiche de fabrication mise a l'echelle.
  app.post('/simulation', { preHandler: exige('production:lire') }, async (req) => {
    const b = z
      .object({
        formule_id: z.coerce.number().int(),
        masse_nette_kg: z.coerce.number().positive().optional().nullable(),
        unites_pf_cibles: z.coerce.number().int().positive().optional().nullable(),
        surdosage_pct: z.coerce.number().min(0).max(50).default(0),
      })
      .parse(req.body);
    const echelle = await miseAEchelle(pool, b.formule_id, {
      masse_nette_kg: b.masse_nette_kg ?? null,
      unites_pf: b.unites_pf_cibles ?? null,
      surdosage_pct: b.surdosage_pct,
    });
    const faisabilite = await controlerFaisabilite(pool, b.formule_id, echelle.masse_brute_kg, b.unites_pf_cibles ?? null);
    return { ...echelle, faisabilite };
  });

  app.post('/', { preHandler: exige('production:creer') }, async (req, rep) => {
    const b = z
      .object({
        formule_id: z.coerce.number().int(),
        masse_nette_kg: z.coerce.number().positive().optional().nullable(),
        unites_pf_cibles: z.coerce.number().int().positive().optional().nullable(),
        surdosage_pct: z.coerce.number().min(0).max(50).default(0),
        date_planifiee: z.string().date().optional().nullable(),
        commentaire: z.string().optional().nullable(),
      })
      .parse(req.body);
    const of = await transaction((client) => creerOf(client, req.utilisateur.id, b));
    return rep.status(201).send(of);
  });

  // ---------------------- Etape 1 : pesee atelier ---------------------
  // Lots proposes a l'ecran tactile : uniquement les lots conformes, non
  // perimes, tries selon la regle FEFO.
  app.get('/:id/lignes/:ligneId/lots', { preHandler: exige('production:peser') }, async (req) => {
    const p = z.object({ id: z.coerce.number().int(), ligneId: z.coerce.number().int() }).parse(req.params);
    const ligne = await queryOne(pool, 'SELECT * FROM of_lignes_theoriques WHERE id = $1 AND of_id = $2', [p.ligneId, p.id]);
    if (!ligne) throw introuvable('Ligne de fiche de fabrication', p.ligneId);
    return query(
      pool,
      `SELECT l.id, l.code_lot_interne, l.code_lot_fournisseur, l.dluo, l.qte_actuelle, l.emplacement,
              a.unite, a.code_sku, a.densite, f.raison_sociale AS fournisseur
         FROM lots_stock l
         JOIN articles_catalogue a ON a.id = l.article_id
         LEFT JOIN fournisseurs f ON f.id = l.fournisseur_id
        WHERE l.article_id = $1
          AND l.statut = 'CONFORME'
          AND l.qte_actuelle > 0
          AND (l.dluo IS NULL OR l.dluo >= CURRENT_DATE)
        ORDER BY l.dluo NULLS LAST, l.date_reception, l.id`,
      [ligne.article_id],
    );
  });

  /**
   * Proposition d'allocation FEFO pour une ligne : le systeme indique quel(s)
   * lot(s) prelever et en quelle quantite pour atteindre la consigne, en
   * tenant compte de ce qui a deja ete pese.
   */
  app.get('/:id/lignes/:ligneId/fefo', { preHandler: exige('production:peser') }, async (req) => {
    const p = z.object({ id: z.coerce.number().int(), ligneId: z.coerce.number().int() }).parse(req.params);
    return propositionFefoLigne(pool, p.id, p.ligneId);
  });

  // Recherche par code-barres / douchette : resolution d'un lot scanne.
  app.get('/:id/scan', { preHandler: exige('production:peser') }, async (req) => {
    const p = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const q = z.object({ code: z.string().min(1) }).parse(req.query);
    const lot = await queryOne(
      pool,
      `SELECT l.*, a.code_sku, a.designation, a.unite, a.type
         FROM lots_stock l JOIN articles_catalogue a ON a.id = l.article_id
        WHERE UPPER(l.code_lot_interne) = UPPER($1) OR UPPER(COALESCE(l.code_lot_fournisseur,'')) = UPPER($1)`,
      [q.code],
    );
    if (!lot) throw new ErreurMetier('LOT_INCONNU', `Aucun lot ne correspond au code scanne « ${q.code} ».`, 404);
    const ligne = await queryOne(
      pool,
      'SELECT id, phase, masse_theorique_g FROM of_lignes_theoriques WHERE of_id = $1 AND article_id = $2',
      [p.id, lot.article_id],
    );
    const bloquant =
      lot.statut !== 'CONFORME'
        ? `Lot en statut ${lot.statut} : utilisation interdite.`
        : lot.dluo && new Date(lot.dluo) < new Date(new Date().toDateString())
          ? `Lot perime depuis le ${lot.dluo}.`
          : !ligne
            ? "Cet article ne figure pas dans la fiche de fabrication de l'OF."
            : null;
    return { lot, ligne, utilisable: bloquant === null, message: bloquant };
  });

  app.post('/:id/pesees', { preHandler: exige('production:peser') }, async (req, rep) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z
      .object({
        of_ligne_id: z.coerce.number().int(),
        lot_stock_id: z.coerce.number().int(),
        poids_reel_pesee_g: z.coerce.number().positive(),
        commentaire: z.string().optional().nullable(),
        forcer: z.boolean().default(false),
      })
      .parse(req.body);
    // Le forcage d'une pesee hors tolerance releve de la responsabilite qualite.
    if (b.forcer && !['RESPONSABLE_RD_QUALITE', 'ADMIN'].includes(req.utilisateur.role)) {
      throw new ErreurMetier('ACCES_INTERDIT', "Seul le responsable R&D / Qualite peut accepter une pesee hors tolerance.", 403);
    }
    const pesee = await transaction((client) => enregistrerPesee(client, req.utilisateur.id, id, b));
    return rep.status(201).send(pesee);
  });

  // Annulation tracee d'une pesee (aucune suppression physique).
  app.post('/:id/pesees/:peseeId/annuler', { preHandler: exige('production:peser') }, async (req) => {
    const p = z.object({ id: z.coerce.number().int(), peseeId: z.coerce.number().int() }).parse(req.params);
    const b = z.object({ motif: z.string().min(5) }).parse(req.body);
    return transaction(async (client) => {
      const of = await queryOne(client, 'SELECT statut_of FROM ordres_fabrication WHERE id = $1', [p.id]);
      if (!of) throw introuvable('Ordre de fabrication', p.id);
      if (!['BROUILLON', 'PESEE'].includes(of.statut_of)) {
        throw new ErreurMetier('OF_ETAPE_INVALIDE', 'Les pesees ne sont plus modifiables a ce stade.', 422);
      }
      const pesee = await queryOne(
        client,
        `UPDATE of_pesees_reelles SET valide = FALSE, commentaire = COALESCE(commentaire || ' | ', '') || $3
          WHERE id = $1 AND of_id = $2 AND valide RETURNING *`,
        [p.peseeId, p.id, `ANNULEE: ${b.motif}`],
      );
      if (!pesee) throw introuvable('Pesee validee', p.peseeId);
      await tracer(client, req.utilisateur.id, 'ANNULATION_PESEE', 'of_pesees_reelles', p.peseeId, { motif: b.motif });
      return pesee;
    });
  });

  // ------------- Etape 2 : fabrication cuve et controle qualite -------
  app.post('/:id/fabrication', { preHandler: exige('production:cuve') }, async (req, rep) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z
      .object({
        date_debut_melange: z.string().datetime().optional().nullable(),
        date_fin_melange: z.string().datetime().optional().nullable(),
        commentaire: z.string().optional().nullable(),
      })
      .parse(req.body ?? {});
    const vrac = await transaction((client) => cloturerFabrication(client, req.utilisateur.id, id, b));
    return rep.status(201).send(vrac);
  });

  app.post('/:id/vrac/controle', { preHandler: exige('stock:liberer') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z
      .object({
        ph_mesure: z.coerce.number().min(0).max(14),
        viscosite_mesuree: z.coerce.number().min(0).optional().nullable(),
        aspect: z.string().min(1),
        couleur: z.string().min(1),
        odeur: z.string().min(1),
        conforme_organoleptique: z.boolean(),
        decision: z.enum(['LIBERE', 'REJETE']),
        commentaire: z.string().optional().nullable(),
      })
      .parse(req.body);
    return transaction((client) => libererVrac(client, req.utilisateur.id, id, b));
  });

  // -------------------- Etape 3 : conditionnement ---------------------
  app.post('/:id/conditionnement', { preHandler: exige('production:conditionner') }, async (req, rep) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z
      .object({
        unites_produites: z.coerce.number().int().positive(),
        unites_rebut: z.coerce.number().int().min(0).default(0),
        dluo: z.string().date().optional().nullable(),
        consommations: z
          .array(
            z.object({
              article_ac_id: z.coerce.number().int(),
              lot_stock_id: z.coerce.number().int(),
              qte_consommee: z.coerce.number().positive(),
              qte_rebut: z.coerce.number().min(0).default(0),
            }),
          )
          .min(1, "Au moins un article de conditionnement doit etre consomme."),
      })
      .parse(req.body);
    const resultat = await transaction((client) => conditionner(client, req.utilisateur.id, id, b));
    return rep.status(201).send(resultat);
  });

  app.post('/:id/heures', { preHandler: exige('production:lire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z.object({ heures_production: z.coerce.number().min(0) }).parse(req.body);
    const of = await queryOne(
      pool, 'UPDATE ordres_fabrication SET heures_production = $2 WHERE id = $1 RETURNING *', [id, b.heures_production],
    );
    if (!of) throw introuvable('Ordre de fabrication', id);
    return of;
  });

  app.post('/:id/cloturer', { preHandler: exige('production:cloturer') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    return transaction((client) => cloturerOf(client, req.utilisateur.id, id));
  });
}
