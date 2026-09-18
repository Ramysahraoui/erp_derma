import type pg from 'pg';
import { query, queryOne, type Db } from '../../db/pool.js';
import { ErreurMetier, introuvable } from '../../core/erreurs.js';
import { genererNumero } from '../../core/numerotation.js';
import { tracer } from '../../core/audit.js';
import { d, m2 } from '../../core/nombres.js';

export interface AffectationEntree { document_id: number; montant_affecte: number }

/** Met a jour le statut d'apurement d'une facture apres affectation. */
async function reactualiserFacture(client: pg.PoolClient, documentId: number) {
  const doc = await queryOne(
    client,
    `SELECT v.*, COALESCE((SELECT SUM(ea.montant_affecte) FROM encaissement_affectations ea
                            WHERE ea.document_id = v.id), 0) AS total_affecte
       FROM ventes_documents v WHERE v.id = $1 FOR UPDATE`,
    [documentId],
  );
  if (!doc) throw introuvable('Facture', documentId);
  const paye = d(doc.total_affecte);
  const statut = paye.greaterThanOrEqualTo(d(doc.total_ttc).minus('0.005'))
    ? 'SOLDEE'
    : paye.greaterThan(0)
      ? 'PARTIELLE'
      : 'NON_PAYEE';
  return queryOne(
    client,
    'UPDATE ventes_documents SET montant_paye = $2, statut_paiement = $3 WHERE id = $1 RETURNING *',
    [documentId, m2(paye), statut],
  );
}

/**
 * Saisie d'un encaissement multi-factures : un meme reglement peut apurer
 * plusieurs factures, ou n'en solder qu'une partie.
 */
export async function creerEncaissement(
  client: pg.PoolClient,
  utilisateurId: number,
  params: {
    client_id: number;
    montant_verse: number;
    mode_reglement: 'ESPECES' | 'CHEQUE' | 'VIREMENT';
    date_reglement?: string | null;
    cheque_numero?: string | null;
    cheque_banque?: string | null;
    cheque_date_emission?: string | null;
    cheque_date_encaissement_prev?: string | null;
    cheque_statut?: 'RECU' | 'DEPOSE' | 'ENCAISSE' | 'IMPAYE' | null;
    reference?: string | null;
    commentaire?: string | null;
    affectations: AffectationEntree[];
  },
) {
  const cl = await queryOne(client, 'SELECT * FROM clients WHERE id = $1', [params.client_id]);
  if (!cl) throw introuvable('Client', params.client_id);

  const totalAffecte = params.affectations.reduce((acc, a) => acc.plus(a.montant_affecte), d(0));
  if (totalAffecte.greaterThan(d(params.montant_verse).plus('0.005'))) {
    throw new ErreurMetier(
      'AFFECTATION_EXCESSIVE',
      `Le total affecte (${m2(totalAffecte)}) depasse le montant verse (${m2(params.montant_verse)}).`,
      422,
    );
  }

  const numero = await genererNumero(client, 'ENC');
  const encaissement = await queryOne(
    client,
    `INSERT INTO encaissements
       (numero, client_id, montant_verse, montant_affecte, mode_reglement, date_reglement, cheque_numero,
        cheque_banque, cheque_date_emission, cheque_date_encaissement_prev, cheque_statut, reference, commentaire, cree_par)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6::date,CURRENT_DATE),$7,$8,$9::date,$10::date,$11,$12,$13,$14) RETURNING *`,
    [numero, params.client_id, m2(params.montant_verse), m2(totalAffecte), params.mode_reglement,
     params.date_reglement ?? null, params.cheque_numero ?? null, params.cheque_banque ?? null,
     params.cheque_date_emission ?? null, params.cheque_date_encaissement_prev ?? null,
     params.mode_reglement === 'CHEQUE' ? (params.cheque_statut ?? 'RECU') : null,
     params.reference ?? null, params.commentaire ?? null, utilisateurId],
  );

  for (const a of params.affectations) {
    const facture = await queryOne(
      client,
      `SELECT v.*, COALESCE((SELECT SUM(ea.montant_affecte) FROM encaissement_affectations ea
                              WHERE ea.document_id = v.id), 0) AS deja_affecte
         FROM ventes_documents v WHERE v.id = $1 FOR UPDATE`,
      [a.document_id],
    );
    if (!facture) throw introuvable('Facture', a.document_id);
    if (facture.type_doc !== 'FACTURE' || facture.statut !== 'VALIDE') {
      throw new ErreurMetier('DOCUMENT_NON_FACTURE', `Le document ${facture.numero_piece} n'est pas une facture validee.`, 422);
    }
    if (facture.client_id !== params.client_id) {
      throw new ErreurMetier('CLIENT_INCOHERENT', `La facture ${facture.numero_piece} appartient a un autre client.`, 422);
    }
    const solde = d(facture.total_ttc).minus(facture.deja_affecte);
    if (d(a.montant_affecte).greaterThan(solde.plus('0.005'))) {
      throw new ErreurMetier(
        'AFFECTATION_SUPERIEURE_AU_SOLDE',
        `L'affectation de ${m2(a.montant_affecte)} depasse le solde de la facture ${facture.numero_piece} (${m2(solde)}).`,
        422,
      );
    }
    await client.query(
      `INSERT INTO encaissement_affectations (encaissement_id, document_id, montant_affecte) VALUES ($1,$2,$3)`,
      [encaissement!.id, a.document_id, m2(a.montant_affecte)],
    );
    await reactualiserFacture(client, a.document_id);
  }

  await tracer(client, utilisateurId, 'ENCAISSEMENT', 'encaissements', encaissement!.id, {
    numero, client: cl.raison_sociale, montant: m2(params.montant_verse),
    mode: params.mode_reglement, nb_factures: params.affectations.length,
  });
  return encaissement;
}

/** Suivi du cycle de vie d'un cheque (recu, depose, encaisse, impaye). */
export async function majStatutCheque(
  client: pg.PoolClient,
  utilisateurId: number,
  encaissementId: number,
  statut: 'RECU' | 'DEPOSE' | 'ENCAISSE' | 'IMPAYE',
  commentaire?: string | null,
) {
  const enc = await queryOne(client, 'SELECT * FROM encaissements WHERE id = $1 FOR UPDATE', [encaissementId]);
  if (!enc) throw introuvable('Encaissement', encaissementId);
  if (enc.mode_reglement !== 'CHEQUE') {
    throw new ErreurMetier('MODE_INCOMPATIBLE', "Le suivi de statut ne concerne que les reglements par cheque.", 422);
  }
  const maj = await queryOne(
    client,
    `UPDATE encaissements SET cheque_statut = $2, commentaire = COALESCE(commentaire || ' | ', '') || $3
      WHERE id = $1 RETURNING *`,
    [encaissementId, statut, `${statut}${commentaire ? `: ${commentaire}` : ''}`],
  );

  // Un cheque impaye annule l'apurement des factures qu'il couvrait.
  if (statut === 'IMPAYE') {
    const affectations = await query(
      client, 'SELECT * FROM encaissement_affectations WHERE encaissement_id = $1', [encaissementId],
    );
    for (const a of affectations) {
      await client.query(
        `INSERT INTO encaissement_affectations (encaissement_id, document_id, montant_affecte)
         VALUES ($1, $2, $3)
         ON CONFLICT (encaissement_id, document_id) DO NOTHING`,
        [encaissementId, a.document_id, a.montant_affecte],
      );
    }
    await client.query(
      `UPDATE ventes_documents v
          SET montant_paye = GREATEST(0, v.montant_paye - sub.montant),
              statut_paiement = CASE
                WHEN GREATEST(0, v.montant_paye - sub.montant) <= 0 THEN 'NON_PAYEE'::statut_paiement
                WHEN GREATEST(0, v.montant_paye - sub.montant) < v.total_ttc THEN 'PARTIELLE'::statut_paiement
                ELSE 'SOLDEE'::statut_paiement END
         FROM (SELECT document_id, SUM(montant_affecte) AS montant
                 FROM encaissement_affectations WHERE encaissement_id = $1 GROUP BY document_id) sub
        WHERE v.id = sub.document_id`,
      [encaissementId],
    );
  }
  await tracer(client, utilisateurId, 'MAJ_STATUT_CHEQUE', 'encaissements', encaissementId, { statut, commentaire: commentaire ?? null });
  return maj;
}

/** Balance agee : classement dynamique des creances par tranche de retard. */
export async function balanceAgee(db: Db, clientId?: number | null) {
  const lignes = await query(
    db,
    `SELECT * FROM v_balance_agee WHERE ($1::bigint IS NULL OR client_id = $1)
      ORDER BY jours_retard DESC, solde_du DESC`,
    [clientId ?? null],
  );
  const tranches = { NON_ECHUE: d(0), ECHUE_1_30: d(0), ECHUE_31_60: d(0), ECHUE_PLUS_60: d(0) };
  for (const l of lignes) {
    tranches[l.tranche as keyof typeof tranches] = tranches[l.tranche as keyof typeof tranches].plus(l.solde_du);
  }
  type TrancheCle = 'NON_ECHUE' | 'ECHUE_1_30' | 'ECHUE_31_60' | 'ECHUE_PLUS_60';
  const parClient = new Map<number, { client_id: number; raison_sociale: string; total: string; tranches: Record<TrancheCle, string> }>();
  for (const l of lignes) {
    const courant = parClient.get(l.client_id) ?? {
      client_id: l.client_id,
      raison_sociale: l.raison_sociale,
      total: '0.00',
      tranches: { NON_ECHUE: '0.00', ECHUE_1_30: '0.00', ECHUE_31_60: '0.00', ECHUE_PLUS_60: '0.00' },
    };
    courant.total = m2(d(courant.total).plus(l.solde_du));
    const cle = l.tranche as TrancheCle;
    courant.tranches[cle] = m2(d(courant.tranches[cle]).plus(l.solde_du));
    parClient.set(l.client_id, courant);
  }
  return {
    lignes,
    totaux: {
      NON_ECHUE: m2(tranches.NON_ECHUE),
      ECHUE_1_30: m2(tranches.ECHUE_1_30),
      ECHUE_31_60: m2(tranches.ECHUE_31_60),
      ECHUE_PLUS_60: m2(tranches.ECHUE_PLUS_60),
      TOTAL: m2(d(tranches.NON_ECHUE).plus(tranches.ECHUE_1_30).plus(tranches.ECHUE_31_60).plus(tranches.ECHUE_PLUS_60)),
    },
    par_client: [...parClient.values()].sort((a, b) => Number(b.total) - Number(a.total)),
  };
}
