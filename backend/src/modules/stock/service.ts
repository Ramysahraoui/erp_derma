import type pg from 'pg';
import { query, queryOne, type Db } from '../../db/pool.js';
import { ErreurMetier, introuvable } from '../../core/erreurs.js';
import { genererNumero, prefixeLotParType } from '../../core/numerotation.js';
import { tracer } from '../../core/audit.js';
import { d, q3, p4 } from '../../core/nombres.js';

export interface LigneReception {
  article_id: number;
  quantite: number;
  code_lot_fournisseur?: string | null;
  dluo?: string | null;
  prix_achat_unitaire: number;
  frais_approche_unitaire?: number;
  coa_fichier?: string | null;
  coa_absent_motif?: string | null;
  emplacement?: string | null;
  statut?: 'QUARANTAINE' | 'CONFORME';
  commentaire?: string | null;
}

/**
 * Recalcule le Prix d'Achat Moyen Pondere de l'article a chaque entree.
 * PAMP = (PAMP x stock_avant + cout_entree x qte_entree) / (stock_avant + qte_entree)
 */
async function majPamp(db: Db, articleId: number, qteEntree: string, coutUnitaire: string): Promise<void> {
  const etat = await queryOne<{ pamp: string; stock: string }>(
    db,
    `SELECT a.pamp,
            COALESCE((SELECT SUM(l.qte_actuelle) FROM lots_stock l
                       WHERE l.article_id = a.id AND l.statut <> 'REJETE'), 0) AS stock
       FROM articles_catalogue a WHERE a.id = $1`,
    [articleId],
  );
  if (!etat) throw introuvable('Article', articleId);
  const stockAvant = d(etat.stock).minus(qteEntree); // le lot vient d'etre cree
  const base = stockAvant.isNegative() ? d(0) : stockAvant;
  const total = base.plus(qteEntree);
  const pamp = total.isZero()
    ? d(coutUnitaire)
    : d(etat.pamp).times(base).plus(d(coutUnitaire).times(qteEntree)).dividedBy(total);
  await db.query('UPDATE articles_catalogue SET pamp = $2 WHERE id = $1', [articleId, p4(pamp)]);
}

/** Enregistre une reception fournisseur : lots internes + entrees de stock + PAMP. */
export async function creerReception(
  client: pg.PoolClient,
  utilisateurId: number,
  entete: { fournisseur_id?: number | null; date_reception?: string; reference_bl_fournisseur?: string | null; commentaire?: string | null },
  lignes: LigneReception[],
) {
  if (lignes.length === 0) throw new ErreurMetier('RECEPTION_VIDE', 'Une reception doit comporter au moins une ligne.', 422);
  const numero = await genererNumero(client, 'REC');
  const reception = await queryOne(
    client,
    `INSERT INTO receptions (numero, fournisseur_id, date_reception, reference_bl_fournisseur, commentaire, cree_par)
     VALUES ($1,$2,COALESCE($3::date, CURRENT_DATE),$4,$5,$6) RETURNING *`,
    [numero, entete.fournisseur_id ?? null, entete.date_reception ?? null, entete.reference_bl_fournisseur ?? null,
     entete.commentaire ?? null, utilisateurId],
  );

  const lotsCrees = [];
  for (const l of lignes) {
    const article = await queryOne<{ id: number; type: 'MP' | 'AC' | 'PF'; code_sku: string }>(
      client,
      'SELECT id, type, code_sku FROM articles_catalogue WHERE id = $1 AND actif',
      [l.article_id],
    );
    if (!article) throw introuvable('Article', l.article_id);
    if (article.type === 'PF') {
      throw new ErreurMetier(
        'RECEPTION_PF_INTERDITE',
        `Un produit fini (${article.code_sku}) entre en stock par conditionnement, jamais par reception fournisseur.`,
        422,
      );
    }
    // Certificat d'analyse obligatoire : a defaut, le motif est exige et le lot
    // reste en quarantaine jusqu'a reception du document.
    if (!l.coa_fichier && !l.coa_absent_motif?.trim()) {
      throw new ErreurMetier(
        'COA_MANQUANT',
        `Certificat d'analyse obligatoire pour ${article.code_sku}. ` +
          "Joindre le document (PDF ou image) ou motiver son absence (le lot restera en quarantaine).",
        422,
      );
    }
    const statutEntree = l.coa_fichier ? (l.statut ?? 'QUARANTAINE') : 'QUARANTAINE';
    const codeLot = await genererNumero(client, prefixeLotParType(article.type));
    const lot = await queryOne(
      client,
      `INSERT INTO lots_stock
         (article_id, code_lot_interne, code_lot_fournisseur, reception_id, fournisseur_id,
          qte_initiale, qte_actuelle, statut, dluo, date_reception, prix_achat_unitaire,
          frais_approche_unitaire, coa_fichier, coa_absent_motif, emplacement, commentaire, cree_par)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,COALESCE($9::date,CURRENT_DATE),$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [article.id, codeLot, l.code_lot_fournisseur ?? null, reception!.id, entete.fournisseur_id ?? null,
       q3(l.quantite), statutEntree, l.dluo ?? null, entete.date_reception ?? null,
       p4(l.prix_achat_unitaire), p4(l.frais_approche_unitaire ?? 0), l.coa_fichier ?? null,
       l.coa_absent_motif ?? null, l.emplacement ?? null, l.commentaire ?? null, utilisateurId],
    );
    await client.query(
      `INSERT INTO mouvements_stock (lot_stock_id, type_mouvement, quantite, cout_unitaire, reception_id, motif, utilisateur_id)
       VALUES ($1,'ENTREE_RECEPTION',$2,$3,$4,$5,$6)`,
      [lot!.id, q3(l.quantite), p4(d(l.prix_achat_unitaire).plus(l.frais_approche_unitaire ?? 0)),
       reception!.id, `Reception ${numero}`, utilisateurId],
    );
    await majPamp(client, article.id, q3(l.quantite), p4(d(l.prix_achat_unitaire).plus(l.frais_approche_unitaire ?? 0)));
    await tracer(client, utilisateurId, 'RECEPTION_LOT', 'lots_stock', lot!.id, {
      code_lot_interne: codeLot, article: article.code_sku, quantite: q3(l.quantite),
    });
    lotsCrees.push({ ...lot, code_sku: article.code_sku });
  }
  return { reception, lots: lotsCrees };
}

/** Changement de statut qualite d'un lot (liberation, rejet, blocage). */
export async function changerStatutLot(
  db: Db,
  utilisateurId: number,
  lotId: number,
  statut: 'QUARANTAINE' | 'CONFORME' | 'REJETE' | 'BLOQUE',
  motif?: string | null,
) {
  const lot = await queryOne(db, 'SELECT * FROM lots_stock WHERE id = $1', [lotId]);
  if (!lot) throw introuvable('Lot', lotId);
  if (lot.statut === statut) return lot;
  if (lot.statut === 'REJETE') {
    throw new ErreurMetier('LOT_REJETE', 'Un lot rejete ne peut pas etre remis en circulation.', 422);
  }
  if (statut === 'CONFORME' && !lot.coa_fichier) {
    const article = await queryOne(db, 'SELECT type, code_sku FROM articles_catalogue WHERE id = $1', [lot.article_id]);
    if (article && ['MP', 'AC'].includes(article.type)) {
      throw new ErreurMetier(
        'COA_MANQUANT',
        `Liberation impossible : aucun certificat d'analyse n'est joint au lot ${lot.code_lot_interne} (${article.code_sku}).`,
        422,
      );
    }
  }
  const maj = await queryOne(
    db,
    `UPDATE lots_stock SET statut = $2, statut_modifie_par = $3, statut_modifie_le = NOW(),
       commentaire = COALESCE($4, commentaire)
     WHERE id = $1 RETURNING *`,
    [lotId, statut, utilisateurId, motif ?? null],
  );
  await tracer(db, utilisateurId, 'CHANGEMENT_STATUT_LOT', 'lots_stock', lotId, {
    ancien_statut: lot.statut, nouveau_statut: statut, motif: motif ?? null,
  });
  return maj;
}

export interface PropositionFefo {
  lot_stock_id: number;
  code_lot_interne: string;
  dluo: string | null;
  qte_disponible: string;
  qte_a_prelever: string;
  cout_unitaire: string;
}

/**
 * Allocation FEFO (First Expired, First Out) : priorite au lot conforme dont la
 * peremption est la plus proche. Les lots perimes et non conformes sont exclus.
 */
export async function allouerFefo(db: Db, articleId: number, quantite: number | string): Promise<{
  lignes: PropositionFefo[];
  quantite_couverte: string;
  quantite_manquante: string;
}> {
  const lots = await query(
    db,
    `SELECT id, code_lot_interne, dluo, qte_actuelle, cout_unitaire
       FROM lots_stock
      WHERE article_id = $1 AND statut = 'CONFORME' AND qte_actuelle > 0
        AND (dluo IS NULL OR dluo >= CURRENT_DATE)
      ORDER BY dluo NULLS LAST, date_reception, id`,
    [articleId],
  );
  let reste = d(quantite);
  const lignes: PropositionFefo[] = [];
  for (const lot of lots) {
    if (reste.lessThanOrEqualTo(0)) break;
    const prise = d(lot.qte_actuelle).greaterThan(reste) ? reste : d(lot.qte_actuelle);
    lignes.push({
      lot_stock_id: lot.id,
      code_lot_interne: lot.code_lot_interne,
      dluo: lot.dluo,
      qte_disponible: q3(lot.qte_actuelle),
      qte_a_prelever: q3(prise),
      cout_unitaire: p4(lot.cout_unitaire),
    });
    reste = reste.minus(prise);
  }
  return {
    lignes,
    quantite_couverte: q3(d(quantite).minus(reste)),
    quantite_manquante: q3(reste.isNegative() ? 0 : reste),
  };
}

/** Ecriture d'un mouvement de stock (unique voie de modification des quantites). */
export async function ecrireMouvement(
  db: Db,
  params: {
    lot_stock_id: number;
    type_mouvement: 'ENTREE_RECEPTION' | 'ENTREE_PRODUCTION' | 'SORTIE_PRODUCTION' | 'SORTIE_VENTE' | 'SORTIE_REBUT' | 'AJUSTEMENT' | 'ANNULATION';
    quantite: number | string;
    cout_unitaire?: number | string;
    of_id?: number | null;
    document_vente_id?: number | null;
    motif?: string | null;
    utilisateur_id: number;
    annule_mouvement_id?: number | null;
  },
) {
  return queryOne(
    db,
    `INSERT INTO mouvements_stock
       (lot_stock_id, type_mouvement, quantite, cout_unitaire, of_id, document_vente_id, motif, utilisateur_id, annule_mouvement_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [params.lot_stock_id, params.type_mouvement, q3(params.quantite), p4(params.cout_unitaire ?? 0),
     params.of_id ?? null, params.document_vente_id ?? null, params.motif ?? null,
     params.utilisateur_id, params.annule_mouvement_id ?? null],
  );
}

/**
 * Correction de stock : jamais de suppression, uniquement une ecriture
 * d'ajustement tracee et motivee (audit trail BPF).
 */
export async function ajusterStock(
  db: Db,
  utilisateurId: number,
  lotId: number,
  quantiteSignee: number | string,
  motif: string,
) {
  if (!motif || motif.trim().length < 5) {
    throw new ErreurMetier('MOTIF_OBLIGATOIRE', 'Un ajustement de stock exige un motif explicite (5 caracteres minimum).', 422);
  }
  const lot = await queryOne(db, 'SELECT * FROM lots_stock WHERE id = $1', [lotId]);
  if (!lot) throw introuvable('Lot', lotId);
  const mouvement = await ecrireMouvement(db, {
    lot_stock_id: lotId,
    type_mouvement: 'AJUSTEMENT',
    quantite: quantiteSignee,
    cout_unitaire: lot.cout_unitaire,
    motif,
    utilisateur_id: utilisateurId,
  });
  await tracer(db, utilisateurId, 'AJUSTEMENT_STOCK', 'lots_stock', lotId, { quantite: q3(quantiteSignee), motif });
  return mouvement;
}
