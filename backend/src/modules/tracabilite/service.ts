import { query, queryOne, type Db } from '../../db/pool.js';
import { introuvable } from '../../core/erreurs.js';

/**
 * Tracabilite descendante : d'un lot de matiere premiere ou d'article de
 * conditionnement vers les ordres de fabrication qui l'ont consomme, les lots
 * de produits finis generes et les clients livres.
 */
export async function tracabiliteDescendante(db: Db, lotId: number) {
  const lot = await queryOne(
    db,
    `SELECT l.*, a.code_sku, a.designation, a.type, a.unite, f.raison_sociale AS fournisseur,
            r.numero AS numero_reception, r.date_reception AS date_reception_doc
       FROM lots_stock l
       JOIN articles_catalogue a ON a.id = l.article_id
       LEFT JOIN fournisseurs f ON f.id = l.fournisseur_id
       LEFT JOIN receptions r ON r.id = l.reception_id
      WHERE l.id = $1`,
    [lotId],
  );
  if (!lot) throw introuvable('Lot', lotId);

  // OF ayant consomme ce lot : via les pesees (MP) ou le conditionnement (AC).
  const ordres = await query(
    db,
    `SELECT DISTINCT o.id, o.code_of, o.statut_of, o.date_debut, o.date_cloture, o.unites_produites,
            f.code_formule, f.nom_produit, v.code_lot_vrac, v.statut AS statut_vrac,
            src.quantite_consommee, src.origine
       FROM (
              SELECT p.of_id, SUM(p.poids_reel_pesee_g) AS quantite_consommee, 'PESEE' AS origine
                FROM of_pesees_reelles p WHERE p.lot_stock_id = $1 AND p.valide GROUP BY p.of_id
              UNION ALL
              SELECT c.of_id, SUM(c.qte_consommee + c.qte_rebut), 'CONDITIONNEMENT'
                FROM of_conditionnement c WHERE c.lot_stock_id = $1 GROUP BY c.of_id
            ) src
       JOIN ordres_fabrication o ON o.id = src.of_id
       JOIN formules f ON f.id = o.formule_id
       LEFT JOIN lots_vrac v ON v.id = o.lot_vrac_id
      ORDER BY o.id`,
    [lotId],
  );

  const ofIds = ordres.map((o) => o.id);
  const lotsPf = ofIds.length
    ? await query(
        db,
        `SELECT l.id, l.code_lot_interne, l.of_id, l.qte_initiale, l.qte_actuelle, l.dluo, l.date_fabrication,
                l.statut, a.code_sku, a.designation, v.code_lot_vrac
           FROM lots_stock l
           JOIN articles_catalogue a ON a.id = l.article_id
           LEFT JOIN lots_vrac v ON v.id = l.lot_vrac_id
          WHERE l.of_id = ANY($1::bigint[]) AND a.type = 'PF'
          ORDER BY l.id`,
        [ofIds],
      )
    : [];

  const lotPfIds = lotsPf.map((l) => l.id);
  const livraisons = lotPfIds.length
    ? await query(
        db,
        `SELECT vl.lot_pf_id, vl.quantite, vd.id AS document_id, vd.type_doc, vd.numero_piece, vd.date_doc,
                vd.statut, c.id AS client_id, c.code AS client_code, c.raison_sociale, c.adresse_livraison,
                c.telephone, c.email
           FROM ventes_lignes vl
           JOIN ventes_documents vd ON vd.id = vl.document_id
           JOIN clients c ON c.id = vd.client_id
          WHERE vl.lot_pf_id = ANY($1::bigint[]) AND vd.statut = 'VALIDE' AND vd.type_doc IN ('BL','FACTURE')
          ORDER BY vd.date_doc, vd.id`,
        [lotPfIds],
      )
    : [];

  const clients = new Map<number, { client_id: number; code: string; raison_sociale: string; contact: string | null; quantite_livree: number; documents: string[] }>();
  for (const l of livraisons.filter((x) => x.type_doc === 'BL')) {
    const c = clients.get(l.client_id) ?? {
      client_id: l.client_id, code: l.client_code, raison_sociale: l.raison_sociale,
      contact: (l.telephone ?? l.email ?? null) as string | null, quantite_livree: 0, documents: [] as string[],
    };
    c.quantite_livree += Number(l.quantite);
    c.documents.push(l.numero_piece);
    clients.set(l.client_id, c);
  }

  return {
    sens: 'DESCENDANTE',
    lot_origine: lot,
    ordres_fabrication: ordres,
    lots_pf: lotsPf,
    livraisons,
    clients_livres: [...clients.values()],
    synthese: {
      nb_of: ordres.length,
      nb_lots_pf: lotsPf.length,
      nb_clients: clients.size,
      nb_documents: new Set(livraisons.map((l) => l.document_id)).size,
    },
  };
}

/**
 * Tracabilite ascendante : d'un lot de produit fini (ou d'un numero de lot
 * expedie) vers le vrac, l'ordre de fabrication, les pesees, les lots de
 * matieres premieres et leurs fournisseurs.
 */
export async function tracabiliteAscendante(db: Db, lotPfId: number) {
  const lotPf = await queryOne(
    db,
    `SELECT l.*, a.code_sku, a.designation, a.type, v.code_lot_vrac, v.statut AS statut_vrac,
            v.ph_mesure, v.viscosite_mesuree, v.date_fin_melange, v.libere_le,
            o.code_of, o.statut_of, o.cru, o.rendement_pct, f.code_formule, f.version AS formule_version, f.nom_produit
       FROM lots_stock l
       JOIN articles_catalogue a ON a.id = l.article_id
       LEFT JOIN lots_vrac v ON v.id = l.lot_vrac_id
       LEFT JOIN ordres_fabrication o ON o.id = l.of_id
       LEFT JOIN formules f ON f.id = o.formule_id
      WHERE l.id = $1`,
    [lotPfId],
  );
  if (!lotPf) throw introuvable('Lot de produit fini', lotPfId);

  const matieres = lotPf.of_id
    ? await query(
        db,
        `SELECT p.poids_reel_pesee_g, p.poids_theorique_g, p.ecart_pct, p.conforme, p.date_pesee,
                l.id AS lot_stock_id, l.code_lot_interne, l.code_lot_fournisseur, l.dluo, l.coa_fichier,
                a.code_sku, a.designation, a.nom_inci, fo.raison_sociale AS fournisseur,
                lt.phase, u.nom_complet AS operateur
           FROM of_pesees_reelles p
           JOIN lots_stock l ON l.id = p.lot_stock_id
           JOIN articles_catalogue a ON a.id = l.article_id
           JOIN of_lignes_theoriques lt ON lt.id = p.of_ligne_id
           LEFT JOIN fournisseurs fo ON fo.id = l.fournisseur_id
           LEFT JOIN utilisateurs u ON u.id = p.operateur_id
          WHERE p.of_id = $1 AND p.valide ORDER BY lt.phase, lt.ordre`,
        [lotPf.of_id],
      )
    : [];

  const conditionnement = lotPf.of_id
    ? await query(
        db,
        `SELECT c.qte_consommee, c.qte_rebut, l.code_lot_interne, l.code_lot_fournisseur, l.dluo,
                a.code_sku, a.designation, fo.raison_sociale AS fournisseur
           FROM of_conditionnement c
           JOIN lots_stock l ON l.id = c.lot_stock_id
           JOIN articles_catalogue a ON a.id = l.article_id
           LEFT JOIN fournisseurs fo ON fo.id = l.fournisseur_id
          WHERE c.of_id = $1 ORDER BY a.code_sku`,
        [lotPf.of_id],
      )
    : [];

  const destinations = await query(
    db,
    `SELECT vd.numero_piece, vd.type_doc, vd.date_doc, vl.quantite, c.raison_sociale, c.code AS client_code
       FROM ventes_lignes vl
       JOIN ventes_documents vd ON vd.id = vl.document_id
       JOIN clients c ON c.id = vd.client_id
      WHERE vl.lot_pf_id = $1 AND vd.statut = 'VALIDE' ORDER BY vd.date_doc`,
    [lotPfId],
  );

  return {
    sens: 'ASCENDANTE',
    lot_pf: lotPf,
    matieres_premieres: matieres,
    articles_conditionnement: conditionnement,
    destinations,
    synthese: {
      nb_matieres: matieres.length,
      nb_ac: conditionnement.length,
      nb_expeditions: destinations.length,
    },
  };
}

/** Recherche d'un lot par code interne ou code fournisseur (douchette incluse). */
export async function rechercherLot(db: Db, code: string) {
  return query(
    db,
    `SELECT l.id, l.code_lot_interne, l.code_lot_fournisseur, l.statut, l.qte_actuelle, l.dluo,
            a.code_sku, a.designation, a.type, a.unite
       FROM lots_stock l JOIN articles_catalogue a ON a.id = l.article_id
      WHERE l.code_lot_interne ILIKE '%'||$1||'%' OR l.code_lot_fournisseur ILIKE '%'||$1||'%'
      ORDER BY l.id DESC LIMIT 50`,
    [code],
  );
}
