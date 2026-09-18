import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, query, queryOne, transaction } from '../../db/pool.js';
import { introuvable } from '../../core/erreurs.js';
import { exige } from '../../core/auth.js';
import { balanceAgee, creerEncaissement, majStatutCheque } from './service.js';

export async function routesRecouvrement(app: FastifyInstance): Promise<void> {
  app.get('/balance-agee', { preHandler: exige('recouvrement:lire') }, async (req) => {
    const f = z.object({ client_id: z.coerce.number().int().optional() }).parse(req.query);
    return balanceAgee(pool, f.client_id ?? null);
  });

  app.get('/tableau-de-bord', { preHandler: exige('recouvrement:lire') }, async () => {
    const balance = await balanceAgee(pool, null);
    const cheques = await query(
      pool,
      `SELECT e.*, c.raison_sociale FROM encaissements e JOIN clients c ON c.id = e.client_id
        WHERE e.mode_reglement = 'CHEQUE' AND e.cheque_statut IN ('RECU','DEPOSE','IMPAYE')
        ORDER BY e.cheque_date_encaissement_prev NULLS LAST, e.id`,
    );
    const encaissementsMois = await queryOne(
      pool,
      `SELECT COALESCE(SUM(montant_verse),0) AS total, COUNT(*) AS nombre FROM encaissements
        WHERE date_reglement >= date_trunc('month', CURRENT_DATE)`,
    );
    const clientsRisque = await query(
      pool,
      `SELECT * FROM v_encours_clients
        WHERE plafond_credit > 0 AND (encours_facture + encours_livre_non_facture) > plafond_credit * 0.8
        ORDER BY (encours_facture + encours_livre_non_facture) - plafond_credit DESC`,
    );
    return { balance, cheques_en_cours: cheques, encaissements_du_mois: encaissementsMois, clients_a_risque: clientsRisque };
  });

  app.get('/encaissements', { preHandler: exige('encaissement:lire') }, async (req) => {
    const f = z
      .object({
        client_id: z.coerce.number().int().optional(),
        mode_reglement: z.enum(['ESPECES', 'CHEQUE', 'VIREMENT']).optional(),
        depuis: z.string().date().optional(),
      })
      .parse(req.query);
    return query(
      pool,
      `SELECT e.*, c.raison_sociale,
              (SELECT json_agg(json_build_object('document_id', ea.document_id, 'numero_piece', v.numero_piece,
                                                 'montant_affecte', ea.montant_affecte))
                 FROM encaissement_affectations ea JOIN ventes_documents v ON v.id = ea.document_id
                WHERE ea.encaissement_id = e.id) AS affectations
         FROM encaissements e JOIN clients c ON c.id = e.client_id
        WHERE ($1::bigint IS NULL OR e.client_id = $1)
          AND ($2::text IS NULL OR e.mode_reglement = $2::mode_reglement)
          AND ($3::date IS NULL OR e.date_reglement >= $3::date)
        ORDER BY e.date_reglement DESC, e.id DESC LIMIT 300`,
      [f.client_id ?? null, f.mode_reglement ?? null, f.depuis ?? null],
    );
  });

  app.post('/encaissements', { preHandler: exige('encaissement:ecrire') }, async (req, rep) => {
    const b = z
      .object({
        client_id: z.coerce.number().int(),
        montant_verse: z.coerce.number().positive(),
        mode_reglement: z.enum(['ESPECES', 'CHEQUE', 'VIREMENT']),
        date_reglement: z.string().date().optional().nullable(),
        cheque_numero: z.string().optional().nullable(),
        cheque_banque: z.string().optional().nullable(),
        cheque_date_emission: z.string().date().optional().nullable(),
        cheque_date_encaissement_prev: z.string().date().optional().nullable(),
        cheque_statut: z.enum(['RECU', 'DEPOSE', 'ENCAISSE', 'IMPAYE']).optional().nullable(),
        reference: z.string().optional().nullable(),
        commentaire: z.string().optional().nullable(),
        affectations: z
          .array(z.object({ document_id: z.coerce.number().int(), montant_affecte: z.coerce.number().positive() }))
          .default([]),
      })
      .superRefine((v, ctx) => {
        if (v.mode_reglement === 'CHEQUE' && (!v.cheque_numero || !v.cheque_date_emission)) {
          ctx.addIssue({
            code: 'custom', path: ['cheque_numero'],
            message: "Un reglement par cheque exige le numero de cheque et sa date d'emission.",
          });
        }
      })
      .parse(req.body);
    const enc = await transaction((client) => creerEncaissement(client, req.utilisateur.id, b));
    return rep.status(201).send(enc);
  });

  app.get('/encaissements/:id', { preHandler: exige('encaissement:lire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const enc = await queryOne(
      pool,
      `SELECT e.*, c.raison_sociale FROM encaissements e JOIN clients c ON c.id = e.client_id WHERE e.id = $1`,
      [id],
    );
    if (!enc) throw introuvable('Encaissement', id);
    const affectations = await query(
      pool,
      `SELECT ea.*, v.numero_piece, v.total_ttc, v.montant_paye, v.statut_paiement
         FROM encaissement_affectations ea JOIN ventes_documents v ON v.id = ea.document_id
        WHERE ea.encaissement_id = $1`,
      [id],
    );
    return { ...enc, affectations };
  });

  app.post('/encaissements/:id/cheque', { preHandler: exige('encaissement:ecrire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z
      .object({ statut: z.enum(['RECU', 'DEPOSE', 'ENCAISSE', 'IMPAYE']), commentaire: z.string().optional().nullable() })
      .parse(req.body);
    return transaction((client) => majStatutCheque(client, req.utilisateur.id, id, b.statut, b.commentaire));
  });

  // Factures ouvertes d'un client, pour l'ecran d'affectation multi-factures.
  app.get('/factures-ouvertes/:clientId', { preHandler: exige('encaissement:lire') }, async (req) => {
    const { clientId } = z.object({ clientId: z.coerce.number().int() }).parse(req.params);
    return query(
      pool,
      `SELECT id, numero_piece, date_doc, date_echeance, total_ttc, montant_paye,
              (total_ttc - montant_paye) AS solde_du, statut_paiement,
              GREATEST(0, CURRENT_DATE - date_echeance) AS jours_retard
         FROM ventes_documents
        WHERE client_id = $1 AND type_doc = 'FACTURE' AND statut = 'VALIDE' AND statut_paiement <> 'SOLDEE'
        ORDER BY date_echeance NULLS LAST, id`,
      [clientId],
    );
  });
}
