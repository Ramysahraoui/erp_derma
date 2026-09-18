import type pg from 'pg';
import { query, queryOne, type Db } from '../../db/pool.js';
import { ErreurMetier, introuvable } from '../../core/erreurs.js';
import { genererNumero, type PrefixeMetier } from '../../core/numerotation.js';
import { tracer } from '../../core/audit.js';
import { d, m2, p4, q3, Decimal } from '../../core/nombres.js';
import { verifierMotDePasse } from '../../core/auth.js';
import { ROLES_SUPERVISEUR } from '../../core/rbac.js';
import { ecrireMouvement } from '../stock/service.js';

export type TypeDoc = 'DEVIS' | 'BC' | 'BL' | 'FACTURE';

const PREFIXES: Record<TypeDoc, PrefixeMetier> = { DEVIS: 'DEV', BC: 'BC', BL: 'BL', FACTURE: 'FAC' };

export interface LigneVenteEntree {
  article_id: number;
  lot_pf_id?: number | null;
  quantite: number;
  prix_unitaire?: number | null;
  remise_pct?: number;
  tva_pct?: number | null;
  designation?: string | null;
}

export interface Totaux { total_ht: string; total_tva: string; total_ttc: string }

export function calculerTotaux(lignes: { quantite: number | string; prix_unitaire: number | string; remise_pct?: number | string | null; tva_pct?: number | string | null }[]): Totaux {
  let ht = d(0);
  let tva = d(0);
  for (const l of lignes) {
    const brut = d(l.quantite).times(l.prix_unitaire);
    const net = brut.times(d(100).minus(d(l.remise_pct ?? 0)).dividedBy(100));
    ht = ht.plus(net);
    tva = tva.plus(net.times(d(l.tva_pct ?? 0)).dividedBy(100));
  }
  return { total_ht: m2(ht), total_tva: m2(tva), total_ttc: m2(ht.plus(tva)) };
}

export interface EtatEncours {
  client_id: number;
  raison_sociale: string;
  plafond_credit: string;
  encours_facture: string;
  encours_livre_non_facture: string;
  encours_echu: string;
  encours_total: string;
  disponible: string;
  bloque: boolean;
}

export async function etatEncours(db: Db, clientId: number): Promise<EtatEncours> {
  const e = await queryOne(db, 'SELECT * FROM v_encours_clients WHERE client_id = $1', [clientId]);
  if (!e) throw introuvable('Client', clientId);
  const total = d(e.encours_facture).plus(e.encours_livre_non_facture);
  return {
    client_id: e.client_id,
    raison_sociale: e.raison_sociale,
    plafond_credit: m2(e.plafond_credit),
    encours_facture: m2(e.encours_facture),
    encours_livre_non_facture: m2(e.encours_livre_non_facture),
    encours_echu: m2(e.encours_echu),
    encours_total: m2(total),
    disponible: m2(d(e.plafond_credit).minus(total)),
    bloque: e.bloque,
  };
}

/**
 * Verrouillage automatique du risque client : si l'encours augmente du montant
 * du nouveau bon de livraison depasse le plafond autorise, la sortie est
 * bloquee et exige une autorisation superviseur (mot de passe administrateur).
 */
export async function verifierPlafondCredit(
  db: Db,
  clientId: number,
  montantTtc: string | number,
  deblocage?: { email: string; mot_de_passe: string; motif?: string | null } | null,
): Promise<{ autorise_par: number | null; motif: string | null; encours: EtatEncours }> {
  const client = await queryOne(db, 'SELECT * FROM clients WHERE id = $1', [clientId]);
  if (!client) throw introuvable('Client', clientId);
  const encours = await etatEncours(db, clientId);

  const plafond = d(encours.plafond_credit);
  const apres = d(encours.encours_total).plus(montantTtc);
  const depassement = plafond.greaterThan(0) && apres.greaterThan(plafond);
  const bloqueManuellement = client.bloque;

  if (!depassement && !bloqueManuellement) return { autorise_par: null, motif: null, encours };

  const message = bloqueManuellement
    ? `Le compte client ${client.raison_sociale} est bloque administrativement.`
    : `Plafond d'encours depasse : encours actuel ${encours.encours_total}, ` +
      `nouvelle piece ${m2(montantTtc)}, total ${m2(apres)} pour un plafond de ${m2(plafond)}. ` +
      `Depassement de ${m2(apres.minus(plafond))}.`;

  if (!deblocage) {
    throw new ErreurMetier('PLAFOND_CREDIT_DEPASSE', `${message} Une autorisation superviseur est requise.`, 402, {
      ...encours, montant_piece: m2(montantTtc), encours_apres: m2(apres),
      depassement: m2(apres.minus(plafond)), autorisation_requise: true,
    });
  }

  const superviseur = await queryOne(
    db,
    'SELECT id, role, mot_de_passe, actif FROM utilisateurs WHERE LOWER(email) = LOWER($1)',
    [deblocage.email],
  );
  if (!superviseur || !superviseur.actif || !ROLES_SUPERVISEUR.includes(superviseur.role)) {
    throw new ErreurMetier('DEBLOCAGE_REFUSE', "Seul un administrateur peut lever un blocage d'encours.", 403);
  }
  if (!(await verifierMotDePasse(deblocage.mot_de_passe, superviseur.mot_de_passe))) {
    throw new ErreurMetier('DEBLOCAGE_REFUSE', 'Mot de passe superviseur incorrect.', 403);
  }
  return { autorise_par: superviseur.id, motif: deblocage.motif ?? message, encours };
}

/** Creation d'un document de vente (devis, commande, livraison, facture). */
export async function creerDocument(
  client: pg.PoolClient,
  utilisateurId: number,
  params: {
    type_doc: TypeDoc;
    client_id: number;
    date_doc?: string | null;
    document_parent_id?: number | null;
    reference_externe?: string | null;
    commentaire?: string | null;
    lignes: LigneVenteEntree[];
    deblocage?: { email: string; mot_de_passe: string; motif?: string | null } | null;
  },
) {
  if (params.lignes.length === 0) {
    throw new ErreurMetier('DOCUMENT_VIDE', 'Un document de vente doit comporter au moins une ligne.', 422);
  }
  const cl = await queryOne(client, 'SELECT * FROM clients WHERE id = $1 AND actif', [params.client_id]);
  if (!cl) throw introuvable('Client', params.client_id);

  const lignesCompletes = [];
  for (const l of params.lignes) {
    const article = await queryOne(client, 'SELECT * FROM articles_catalogue WHERE id = $1', [l.article_id]);
    if (!article) throw introuvable('Article', l.article_id);
    if (article.type !== 'PF') {
      throw new ErreurMetier('ARTICLE_NON_VENDABLE', `Seul un produit fini peut etre vendu (${article.code_sku}).`, 422);
    }
    if (params.type_doc === 'BL' && !l.lot_pf_id) {
      throw new ErreurMetier(
        'LOT_PF_OBLIGATOIRE',
        `Aucune sortie commerciale n'est possible sans affectation d'un lot de produit fini (${article.code_sku}).`,
        422,
      );
    }
    let coutUnitaire = d(article.pamp);
    if (l.lot_pf_id) {
      const lot = await queryOne(
        client, 'SELECT * FROM lots_stock WHERE id = $1 FOR UPDATE', [l.lot_pf_id],
      );
      if (!lot) throw introuvable('Lot de produit fini', l.lot_pf_id);
      if (lot.article_id !== l.article_id) {
        throw new ErreurMetier('LOT_ARTICLE_INCOHERENT', `Le lot ${lot.code_lot_interne} n'appartient pas a l'article ${article.code_sku}.`, 422);
      }
      if (lot.statut !== 'CONFORME') {
        throw new ErreurMetier('LOT_NON_CONFORME', `Le lot ${lot.code_lot_interne} est en statut ${lot.statut} : expedition interdite.`, 422);
      }
      if (params.type_doc === 'BL' && d(lot.qte_actuelle).lessThan(l.quantite)) {
        throw new ErreurMetier(
          'STOCK_INSUFFISANT',
          `Le lot ${lot.code_lot_interne} ne contient que ${d(lot.qte_actuelle).toFixed(3)} unites (demande : ${l.quantite}).`,
          422,
        );
      }
      coutUnitaire = d(lot.cout_unitaire);
    }
    const prix = l.prix_unitaire ?? Number(article.prix_vente_ht);
    lignesCompletes.push({
      article_id: article.id,
      lot_pf_id: l.lot_pf_id ?? null,
      designation: l.designation ?? article.designation,
      quantite: l.quantite,
      prix_unitaire: prix,
      remise_pct: l.remise_pct ?? Number(cl.remise_pct),
      tva_pct: l.tva_pct ?? Number(article.tva_pct),
      cout_unitaire: coutUnitaire,
    });
  }

  const totaux = calculerTotaux(lignesCompletes);

  // Controle du risque client sur les pieces engageant une creance.
  let deblocagePar: number | null = null;
  let deblocageMotif: string | null = null;
  if (params.type_doc === 'BL' || params.type_doc === 'FACTURE') {
    const controle = await verifierPlafondCredit(client, params.client_id, totaux.total_ttc, params.deblocage);
    deblocagePar = controle.autorise_par;
    deblocageMotif = controle.motif;
  }

  const numero = await genererNumero(client, PREFIXES[params.type_doc]);
  const echeance = params.type_doc === 'FACTURE' ? Number(cl.delai_paiement_jours) : null;
  const doc = await queryOne(
    client,
    `INSERT INTO ventes_documents
       (type_doc, numero_piece, client_id, document_parent_id, date_doc, date_echeance, statut,
        total_ht, total_tva, total_ttc, deblocage_par, deblocage_motif, reference_externe, commentaire, cree_par)
     VALUES ($1,$2,$3,$4,COALESCE($5::date,CURRENT_DATE),
             CASE WHEN $6::int IS NULL THEN NULL ELSE COALESCE($5::date,CURRENT_DATE) + ($6::int) END,
             'BROUILLON',$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [params.type_doc, numero, params.client_id, params.document_parent_id ?? null, params.date_doc ?? null,
     echeance, totaux.total_ht, totaux.total_tva, totaux.total_ttc, deblocagePar, deblocageMotif,
     params.reference_externe ?? null, params.commentaire ?? null, utilisateurId],
  );

  let ordre = 0;
  for (const l of lignesCompletes) {
    await client.query(
      `INSERT INTO ventes_lignes (document_id, article_id, lot_pf_id, designation, quantite, prix_unitaire,
                                  remise_pct, tva_pct, cout_unitaire, ordre)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [doc!.id, l.article_id, l.lot_pf_id, l.designation, q3(l.quantite), p4(l.prix_unitaire),
       d(l.remise_pct).toFixed(3), d(l.tva_pct).toFixed(3), p4(l.cout_unitaire), ordre++],
    );
  }
  await tracer(client, utilisateurId, `CREATION_${params.type_doc}`, 'ventes_documents', doc!.id, {
    numero_piece: numero, client: cl.raison_sociale, total_ttc: totaux.total_ttc,
    deblocage: deblocagePar ? { par: deblocagePar, motif: deblocageMotif } : null,
  });
  return doc;
}

/**
 * Validation d'un document. Pour un bon de livraison, la validation decremente
 * instantanement le stock physique des lots de produits finis expedies.
 */
export async function validerDocument(client: pg.PoolClient, utilisateurId: number, documentId: number) {
  const doc = await queryOne(client, 'SELECT * FROM ventes_documents WHERE id = $1 FOR UPDATE', [documentId]);
  if (!doc) throw introuvable('Document de vente', documentId);
  if (doc.statut === 'VALIDE') throw new ErreurMetier('DEJA_VALIDE', 'Ce document est deja valide.', 409);
  if (doc.statut === 'ANNULE') throw new ErreurMetier('DOCUMENT_ANNULE', 'Ce document est annule.', 409);

  const lignes = await query(
    client,
    `SELECT vl.*, a.code_sku FROM ventes_lignes vl JOIN articles_catalogue a ON a.id = vl.article_id
      WHERE vl.document_id = $1 ORDER BY vl.ordre`,
    [documentId],
  );
  if (lignes.length === 0) throw new ErreurMetier('DOCUMENT_VIDE', 'Impossible de valider un document sans ligne.', 422);

  let marge = d(0);
  if (doc.type_doc === 'BL') {
    const sansLot = lignes.filter((l) => !l.lot_pf_id);
    if (sansLot.length > 0) {
      throw new ErreurMetier(
        'LOT_PF_OBLIGATOIRE',
        `Erreur bloquante : ${sansLot.length} ligne(s) sans numero de lot de produit fini expedie (${sansLot.map((l) => l.code_sku).join(', ')}).`,
        422,
      );
    }
    for (const l of lignes) {
      await ecrireMouvement(client, {
        lot_stock_id: l.lot_pf_id,
        type_mouvement: 'SORTIE_VENTE',
        quantite: q3(d(l.quantite).negated()),
        cout_unitaire: l.cout_unitaire,
        document_vente_id: documentId,
        motif: `Bon de livraison ${doc.numero_piece}`,
        utilisateur_id: utilisateurId,
      });
    }
  }
  for (const l of lignes) {
    const net = d(l.quantite).times(l.prix_unitaire).times(d(100).minus(d(l.remise_pct)).dividedBy(100));
    marge = marge.plus(net.minus(d(l.cout_unitaire).times(l.quantite)));
  }

  const maj = await queryOne(
    client,
    `UPDATE ventes_documents SET statut = 'VALIDE', valide_par = $2, valide_le = NOW(), marge_brute = $3
      WHERE id = $1 RETURNING *`,
    [documentId, utilisateurId, m2(marge)],
  );
  await tracer(client, utilisateurId, `VALIDATION_${doc.type_doc}`, 'ventes_documents', documentId, {
    numero_piece: doc.numero_piece, marge_brute: m2(marge),
  });
  return maj;
}

/** Transformation d'une piece en piece aval (devis -> BC -> BL -> facture). */
export async function transformerDocument(
  client: pg.PoolClient,
  utilisateurId: number,
  documentId: number,
  cible: TypeDoc,
  affectations?: { ligne_id: number; lot_pf_id: number }[] | null,
  deblocage?: { email: string; mot_de_passe: string; motif?: string | null } | null,
) {
  const source = await queryOne(client, 'SELECT * FROM ventes_documents WHERE id = $1', [documentId]);
  if (!source) throw introuvable('Document de vente', documentId);
  const chaine: Record<TypeDoc, TypeDoc[]> = { DEVIS: ['BC'], BC: ['BL', 'FACTURE'], BL: ['FACTURE'], FACTURE: [] };
  if (!chaine[source.type_doc as TypeDoc].includes(cible)) {
    throw new ErreurMetier('TRANSFORMATION_INTERDITE', `Un document ${source.type_doc} ne peut pas devenir un ${cible}.`, 422);
  }
  if (source.statut !== 'VALIDE') {
    throw new ErreurMetier('SOURCE_NON_VALIDEE', 'Le document source doit etre valide avant transformation.', 422);
  }
  const existant = await queryOne(
    client,
    "SELECT id, numero_piece FROM ventes_documents WHERE document_parent_id = $1 AND type_doc = $2 AND statut <> 'ANNULE'",
    [documentId, cible],
  );
  if (existant) {
    throw new ErreurMetier('DEJA_TRANSFORME', `Ce document a deja genere le ${cible} ${existant.numero_piece}.`, 409);
  }

  const lignes = await query(client, 'SELECT * FROM ventes_lignes WHERE document_id = $1 ORDER BY ordre', [documentId]);
  const map = new Map((affectations ?? []).map((a) => [a.ligne_id, a.lot_pf_id]));
  return creerDocument(client, utilisateurId, {
    type_doc: cible,
    client_id: source.client_id,
    document_parent_id: documentId,
    reference_externe: source.numero_piece,
    lignes: lignes.map((l) => ({
      article_id: l.article_id,
      lot_pf_id: map.get(l.id) ?? l.lot_pf_id ?? null,
      quantite: Number(l.quantite),
      prix_unitaire: Number(l.prix_unitaire),
      remise_pct: Number(l.remise_pct),
      tva_pct: Number(l.tva_pct),
      designation: l.designation,
    })),
    deblocage,
  });
}

/** Annulation tracee : contre-passation des mouvements, jamais de suppression. */
export async function annulerDocument(client: pg.PoolClient, utilisateurId: number, documentId: number, motif: string) {
  const doc = await queryOne(client, 'SELECT * FROM ventes_documents WHERE id = $1 FOR UPDATE', [documentId]);
  if (!doc) throw introuvable('Document de vente', documentId);
  if (doc.statut === 'ANNULE') throw new ErreurMetier('DEJA_ANNULE', 'Document deja annule.', 409);
  if (d(doc.montant_paye).greaterThan(0)) {
    throw new ErreurMetier('DOCUMENT_ENCAISSE', 'Un document partiellement ou totalement encaisse ne peut etre annule.', 422);
  }
  if (doc.statut === 'VALIDE' && doc.type_doc === 'BL') {
    const mouvements = await query(client, 'SELECT * FROM mouvements_stock WHERE document_vente_id = $1', [documentId]);
    for (const m of mouvements) {
      await ecrireMouvement(client, {
        lot_stock_id: m.lot_stock_id,
        type_mouvement: 'ANNULATION',
        quantite: q3(d(m.quantite).negated()),
        cout_unitaire: m.cout_unitaire,
        document_vente_id: documentId,
        motif: `Annulation ${doc.numero_piece} : ${motif}`,
        utilisateur_id: utilisateurId,
        annule_mouvement_id: m.id,
      });
    }
  }
  const maj = await queryOne(
    client,
    `UPDATE ventes_documents SET statut = 'ANNULE', commentaire = COALESCE(commentaire || ' | ', '') || $2 WHERE id = $1 RETURNING *`,
    [documentId, `ANNULE: ${motif}`],
  );
  await tracer(client, utilisateurId, 'ANNULATION_DOCUMENT', 'ventes_documents', documentId, { motif });
  return maj;
}

/** Lots de produit fini disponibles a l'expedition, tries FEFO. */
export async function lotsPfDisponibles(db: Db, articleId: number) {
  return query(
    db,
    `SELECT l.id, l.code_lot_interne, l.dluo, l.qte_actuelle, l.date_fabrication, l.cout_unitaire,
            v.code_lot_vrac, o.code_of
       FROM lots_stock l
       LEFT JOIN lots_vrac v ON v.id = l.lot_vrac_id
       LEFT JOIN ordres_fabrication o ON o.id = l.of_id
      WHERE l.article_id = $1 AND l.statut = 'CONFORME' AND l.qte_actuelle > 0
        AND (l.dluo IS NULL OR l.dluo >= CURRENT_DATE)
      ORDER BY l.dluo NULLS LAST, l.date_fabrication, l.id`,
    [articleId],
  );
}
