import type pg from 'pg';
import { query, queryOne, type Db } from '../../db/pool.js';
import { ErreurMetier, introuvable } from '../../core/erreurs.js';
import { genererNumero } from '../../core/numerotation.js';
import { tracer } from '../../core/audit.js';
import { d, m2 } from '../../core/nombres.js';

export interface AffectationEntree { document_id: number; montant_affecte: number }

/**
 * Recalcule le montant regle et le statut d'apurement d'une facture a partir
 * de ses affectations actives (les affectations annulees par un cheque
 * impaye ne comptent plus).
 */
export async function reactualiserFacture(client: pg.PoolClient, documentId: number) {
  const doc = await queryOne(
    client,
    `SELECT v.*, COALESCE((SELECT SUM(ea.montant_affecte) FROM encaissement_affectations ea
                            WHERE ea.document_id = v.id AND NOT ea.annulee), 0) AS total_affecte
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

export interface Imputation { encaissement_id: number; document_id: number; numero_piece: string; montant: string }

/**
 * Imputation automatique de l'avoir disponible d'un client (part non affectee
 * de ses encaissements valides) sur ses factures ouvertes, de la plus ancienne
 * echeance a la plus recente. Idempotente : sans avoir ou sans facture
 * ouverte, elle ne fait rien. Appelee apres chaque encaissement, chaque
 * validation de facture et chaque changement de statut de cheque.
 */
export async function imputerAvoirsClient(client: pg.PoolClient, clientId: number): Promise<Imputation[]> {
  // Verrou du compte client : deux imputations concurrentes ne peuvent pas
  // consommer deux fois le meme avoir.
  await client.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [clientId]);

  const avoirs = await query(
    client,
    `SELECT id, (montant_verse - montant_affecte) AS reste
       FROM encaissements
      WHERE client_id = $1
        AND cheque_statut IS DISTINCT FROM 'IMPAYE'
        AND montant_verse - montant_affecte > 0.005
      ORDER BY date_reglement, id
      FOR UPDATE`,
    [clientId],
  );
  if (avoirs.length === 0) return [];

  const factures = await query(
    client,
    `SELECT id, numero_piece, (total_ttc - montant_paye) AS solde
       FROM ventes_documents
      WHERE client_id = $1 AND type_doc = 'FACTURE' AND statut = 'VALIDE'
        AND total_ttc - montant_paye > 0.005
      ORDER BY date_echeance NULLS LAST, date_doc, id
      FOR UPDATE`,
    [clientId],
  );

  const imputations: Imputation[] = [];
  const touchees = new Set<number>();
  let iFacture = 0;
  for (const avoir of avoirs) {
    let reste = d(avoir.reste);
    while (reste.greaterThan('0.005') && iFacture < factures.length) {
      const facture = factures[iFacture];
      const solde = d(facture.solde);
      const prise = reste.lessThan(solde) ? reste : solde;
      await client.query(
        `INSERT INTO encaissement_affectations (encaissement_id, document_id, montant_affecte, origine)
         VALUES ($1, $2, $3, 'AUTOMATIQUE')`,
        [avoir.id, facture.id, m2(prise)],
      );
      await client.query('UPDATE encaissements SET montant_affecte = montant_affecte + $2 WHERE id = $1', [avoir.id, m2(prise)]);
      imputations.push({ encaissement_id: avoir.id, document_id: facture.id, numero_piece: facture.numero_piece, montant: m2(prise) });
      touchees.add(facture.id);
      reste = reste.minus(prise);
      facture.solde = m2(solde.minus(prise));
      if (d(facture.solde).lessThanOrEqualTo('0.005')) iFacture++;
    }
    if (iFacture >= factures.length) break;
  }
  for (const id of touchees) await reactualiserFacture(client, id);
  return imputations;
}

/**
 * Reconciliation au demarrage : impute les avoirs restes en suspens sur les
 * factures ouvertes de chaque client. En regime normal il n'y en a aucun
 * (chaque encaissement, facture et changement de statut de cheque impute
 * aussitot) ; elle reprend les encaissements non ventiles saisis en V1.
 */
export async function reconcilierAvoirs(client: pg.PoolClient): Promise<number> {
  const candidats = await query<{ client_id: number }>(
    client,
    `SELECT DISTINCT e.client_id FROM encaissements e
      WHERE e.cheque_statut IS DISTINCT FROM 'IMPAYE' AND e.montant_verse - e.montant_affecte > 0.005
        AND EXISTS (SELECT 1 FROM ventes_documents v
                     WHERE v.client_id = e.client_id AND v.type_doc = 'FACTURE' AND v.statut = 'VALIDE'
                       AND v.total_ttc - v.montant_paye > 0.005)`,
  );
  let total = 0;
  for (const { client_id } of candidats) total += (await imputerAvoirsClient(client, client_id)).length;
  return total;
}

/**
 * Saisie d'un encaissement. Un reglement peut etre ventile explicitement sur
 * une ou plusieurs factures ; la part non ventilee est imputee
 * automatiquement sur les factures les plus anciennes, l'excedent restant en
 * avoir sur le compte du client. Le solde de l'etat client est donc juste des
 * l'enregistrement, quelle que soit la saisie.
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

  const statutCheque = params.mode_reglement === 'CHEQUE' ? (params.cheque_statut ?? 'RECU') : null;
  const numero = await genererNumero(client, 'ENC');
  const encaissement = await queryOne(
    client,
    `INSERT INTO encaissements
       (numero, client_id, montant_verse, montant_affecte, mode_reglement, date_reglement, cheque_numero,
        cheque_banque, cheque_date_emission, cheque_date_encaissement_prev, cheque_statut, reference, commentaire, cree_par)
     VALUES ($1,$2,$3,0,$4,COALESCE($5::date,CURRENT_DATE),$6,$7,$8::date,$9::date,$10,$11,$12,$13) RETURNING *`,
    [numero, params.client_id, m2(params.montant_verse), params.mode_reglement,
     params.date_reglement ?? null, params.cheque_numero ?? null, params.cheque_banque ?? null,
     params.cheque_date_emission ?? null, params.cheque_date_encaissement_prev ?? null,
     statutCheque, params.reference ?? null, params.commentaire ?? null, utilisateurId],
  );

  // Un cheque saisi directement comme impaye n'apure rien.
  if (statutCheque !== 'IMPAYE') {
    for (const a of params.affectations) {
      const facture = await queryOne(
        client, 'SELECT * FROM ventes_documents WHERE id = $1 FOR UPDATE', [a.document_id],
      );
      if (!facture) throw introuvable('Facture', a.document_id);
      if (facture.type_doc !== 'FACTURE' || facture.statut !== 'VALIDE') {
        throw new ErreurMetier('DOCUMENT_NON_FACTURE', `Le document ${facture.numero_piece} n'est pas une facture validee.`, 422);
      }
      if (facture.client_id !== params.client_id) {
        throw new ErreurMetier('CLIENT_INCOHERENT', `La facture ${facture.numero_piece} appartient a un autre client.`, 422);
      }
      const solde = d(facture.total_ttc).minus(facture.montant_paye);
      if (d(a.montant_affecte).greaterThan(solde.plus('0.005'))) {
        throw new ErreurMetier(
          'AFFECTATION_SUPERIEURE_AU_SOLDE',
          `L'affectation de ${m2(a.montant_affecte)} depasse le solde de la facture ${facture.numero_piece} (${m2(solde)}).`,
          422,
        );
      }
      await client.query(
        `INSERT INTO encaissement_affectations (encaissement_id, document_id, montant_affecte, origine)
         VALUES ($1,$2,$3,'MANUELLE')`,
        [encaissement!.id, a.document_id, m2(a.montant_affecte)],
      );
      await client.query('UPDATE encaissements SET montant_affecte = montant_affecte + $2 WHERE id = $1', [encaissement!.id, m2(a.montant_affecte)]);
      await reactualiserFacture(client, a.document_id);
    }
  }

  const imputations = await imputerAvoirsClient(client, params.client_id);

  await tracer(client, utilisateurId, 'ENCAISSEMENT', 'encaissements', encaissement!.id, {
    numero, client: cl.raison_sociale, montant: m2(params.montant_verse), mode: params.mode_reglement,
    affectations_manuelles: params.affectations.length, imputations_automatiques: imputations,
  });
  const final = await queryOne(client, 'SELECT * FROM encaissements WHERE id = $1', [encaissement!.id]);
  return { ...final, imputations_automatiques: imputations };
}

/**
 * Suivi du cycle de vie d'un cheque (recu, depose, encaisse, impaye).
 * Un impaye annule les affectations du cheque (sans les supprimer) : les
 * factures redeviennent dues. Un cheque represente apres impaye redevient un
 * avoir, impute a nouveau automatiquement — sans risque de double paiement.
 */
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
  if (enc.cheque_statut === statut) return enc;

  const maj = await queryOne(
    client,
    `UPDATE encaissements SET cheque_statut = $2, commentaire = COALESCE(commentaire || ' | ', '') || $3
      WHERE id = $1 RETURNING *`,
    [encaissementId, statut, `${statut}${commentaire ? `: ${commentaire}` : ''}`],
  );

  if (statut === 'IMPAYE') {
    const annulees = await query(
      client,
      `UPDATE encaissement_affectations SET annulee = TRUE, annulee_le = NOW()
        WHERE encaissement_id = $1 AND NOT annulee RETURNING document_id`,
      [encaissementId],
    );
    await client.query('UPDATE encaissements SET montant_affecte = 0 WHERE id = $1', [encaissementId]);
    for (const docId of new Set(annulees.map((a) => a.document_id as number))) {
      await reactualiserFacture(client, docId);
    }
  }

  // Re-imputation : un cheque represente redevient un avoir ; une facture
  // liberee par un impaye peut etre couverte par un autre avoir du client.
  const imputations = await imputerAvoirsClient(client, enc.client_id);
  await tracer(client, utilisateurId, 'MAJ_STATUT_CHEQUE', 'encaissements', encaissementId, {
    ancien_statut: enc.cheque_statut, statut, commentaire: commentaire ?? null, imputations_automatiques: imputations,
  });
  return { ...maj, montant_affecte: statut === 'IMPAYE' ? '0.00' : maj!.montant_affecte };
}

/**
 * Releve de compte client : factures (debit), encaissements (credit) et
 * impayes (contre-passation) en ordre chronologique, avec solde progressif.
 * Le solde final est le montant restant du par le client.
 */
export async function releveClient(db: Db, clientId: number) {
  const cl = await queryOne(db, 'SELECT * FROM clients WHERE id = $1', [clientId]);
  if (!cl) throw introuvable('Client', clientId);

  const mouvements = await query(
    db,
    `SELECT * FROM (
       SELECT v.date_doc AS date, v.valide_le AS horodatage, 'FACTURE' AS nature, v.id AS reference_id,
              v.numero_piece AS piece, 'Facture ' || v.numero_piece AS libelle,
              v.total_ttc AS debit, 0::numeric AS credit, v.date_echeance, v.statut_paiement::text AS etat
         FROM ventes_documents v
        WHERE v.client_id = $1 AND v.type_doc = 'FACTURE' AND v.statut = 'VALIDE'
       UNION ALL
       SELECT e.date_reglement, e.cree_le, 'ENCAISSEMENT', e.id, e.numero,
              'Encaissement ' || e.numero || ' — ' ||
                CASE e.mode_reglement WHEN 'ESPECES' THEN 'especes' WHEN 'VIREMENT' THEN 'virement'
                     ELSE 'cheque n° ' || COALESCE(e.cheque_numero, '') END,
              0, e.montant_verse, NULL, COALESCE(e.cheque_statut::text, 'ENCAISSE')
         FROM encaissements e
        WHERE e.client_id = $1
       -- Cheque revenu impaye : contre-passation de son montant.
       UNION ALL
       SELECT a.cree_le::date, a.cree_le, 'IMPAYE', e.id, e.numero,
              'Cheque n° ' || COALESCE(e.cheque_numero, '') || ' revenu impaye (' || e.numero || ')',
              e.montant_verse, 0, NULL, 'IMPAYE'
         FROM audit_log a JOIN encaissements e ON e.id::text = a.entite_id
        WHERE a.action = 'MAJ_STATUT_CHEQUE' AND e.client_id = $1
          AND a.details->>'statut' = 'IMPAYE'
          AND COALESCE(a.details->>'ancien_statut', '') <> 'IMPAYE'
       -- Cheque represente apres impaye : il est a nouveau credite.
       UNION ALL
       SELECT a.cree_le::date, a.cree_le, 'REPRESENTATION', e.id, e.numero,
              'Cheque n° ' || COALESCE(e.cheque_numero, '') || ' represente (' || e.numero || ')',
              0, e.montant_verse, NULL, a.details->>'statut'
         FROM audit_log a JOIN encaissements e ON e.id::text = a.entite_id
        WHERE a.action = 'MAJ_STATUT_CHEQUE' AND e.client_id = $1
          AND a.details->>'ancien_statut' = 'IMPAYE'
          AND a.details->>'statut' <> 'IMPAYE'
       -- Cheque saisi directement comme impaye.
       UNION ALL
       SELECT e.date_reglement, e.cree_le + INTERVAL '1 second', 'IMPAYE', e.id, e.numero,
              'Cheque n° ' || COALESCE(e.cheque_numero, '') || ' impaye (' || e.numero || ')',
              e.montant_verse, 0, NULL, 'IMPAYE'
         FROM encaissements e
        WHERE e.client_id = $1 AND e.cheque_statut = 'IMPAYE'
          AND NOT EXISTS (SELECT 1 FROM audit_log a
                           WHERE a.action = 'MAJ_STATUT_CHEQUE' AND a.entite_id = e.id::text
                             AND a.details->>'statut' = 'IMPAYE')
     ) m
     ORDER BY date, horodatage NULLS FIRST, nature`,
    [clientId],
  );

  let solde = d(0);
  let totalFacture = d(0);
  let totalEncaisse = d(0);
  let totalImpaye = d(0);
  const lignes = mouvements.map((m) => {
    solde = solde.plus(m.debit).minus(m.credit);
    if (m.nature === 'FACTURE') totalFacture = totalFacture.plus(m.debit);
    if (m.nature === 'ENCAISSEMENT' || m.nature === 'REPRESENTATION') totalEncaisse = totalEncaisse.plus(m.credit);
    if (m.nature === 'IMPAYE') totalImpaye = totalImpaye.plus(m.debit);
    return { ...m, debit: m2(m.debit), credit: m2(m.credit), solde: m2(solde) };
  });

  const encours = await queryOne(db, 'SELECT * FROM v_encours_clients WHERE client_id = $1', [clientId]);
  const facturesOuvertes = await query(
    db,
    `SELECT id, numero_piece, date_doc, date_echeance, total_ttc, montant_paye,
            (total_ttc - montant_paye) AS solde_du, statut_paiement,
            GREATEST(0, CURRENT_DATE - date_echeance) AS jours_retard
       FROM ventes_documents
      WHERE client_id = $1 AND type_doc = 'FACTURE' AND statut = 'VALIDE' AND statut_paiement <> 'SOLDEE'
      ORDER BY date_echeance NULLS LAST, id`,
    [clientId],
  );

  const facturesDues = d(encours?.encours_facture ?? 0);
  const avoir = d(encours?.avoir_disponible ?? 0);
  return {
    client: { id: cl.id, code: cl.code, raison_sociale: cl.raison_sociale, adresse_facturation: cl.adresse_facturation,
      plafond_credit: m2(cl.plafond_credit), delai_paiement_jours: cl.delai_paiement_jours },
    lignes,
    factures_ouvertes: facturesOuvertes,
    totaux: {
      total_facture: m2(totalFacture),
      total_encaisse: m2(totalEncaisse),
      total_impaye: m2(totalImpaye),
      factures_dues: m2(facturesDues),
      avoir_disponible: m2(avoir),
      livre_non_facture: m2(encours?.encours_livre_non_facture ?? 0),
      // Solde restant du = factures dues - avoir non encore impute.
      solde_restant_du: m2(facturesDues.minus(avoir)),
    },
  };
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
