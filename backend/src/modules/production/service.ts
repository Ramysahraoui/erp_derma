import type pg from 'pg';
import { query, queryOne, type Db } from '../../db/pool.js';
import { ErreurMetier, introuvable } from '../../core/erreurs.js';
import { genererNumero } from '../../core/numerotation.js';
import { tracer } from '../../core/audit.js';
import { d, q3, p4, m2, ecartPct, somme, Decimal } from '../../core/nombres.js';
import { lireParametreNum } from '../../core/parametres.js';
import { convertirEnGrammes, miseAEchelle } from '../formules/service.js';
import { ecrireMouvement } from '../stock/service.js';

/** Cout de revient d'un gramme de matiere premiere issu d'un lot donne. */
function coutParGramme(coutUnitaire: string | number, unite: string, densiteArticle?: string | null): Decimal {
  const grammesParUnite = convertirEnGrammes(1, unite, densiteArticle);
  return grammesParUnite.isZero() ? d(0) : d(coutUnitaire).dividedBy(grammesParUnite);
}

export interface VerdictFaisabilite {
  faisable: boolean;
  masse_max_kg: string;
  unites_max: number | null;
  ingredient_limitant: {
    article_id: number;
    code_sku: string;
    designation: string;
    besoin_g: string;
    disponible_g: string;
    manquant_g: string;
  } | null;
  manquants: {
    article_id: number; code_sku: string; designation: string;
    besoin_g: string; disponible_g: string; manquant_g: string;
  }[];
}

/**
 * Controle de faisabilite d'un OF : confronte la fiche de fabrication mise a
 * l'echelle au stock reellement disponible (lots conformes, non perimes) et
 * identifie l'ingredient limitant ainsi que le volume maximal atteignable.
 */
export async function controlerFaisabilite(
  db: Db,
  formuleId: number,
  masseBruteKg: number | string,
  unitesCibles: number | null,
): Promise<VerdictFaisabilite> {
  const lignes = await query(
    db,
    `SELECT fl.article_id, fl.pourcentage_w_w, a.code_sku, a.designation, a.unite, a.densite,
            COALESCE((SELECT SUM(l.qte_actuelle) FROM lots_stock l
                       WHERE l.article_id = fl.article_id AND l.statut = 'CONFORME'
                         AND l.qte_actuelle > 0 AND (l.dluo IS NULL OR l.dluo >= CURRENT_DATE)), 0) AS dispo
       FROM formule_lignes fl JOIN articles_catalogue a ON a.id = fl.article_id
      WHERE fl.formule_id = $1`,
    [formuleId],
  );
  const masseBruteG = d(masseBruteKg).times(1000);
  let ratioMin: Decimal | null = null;
  let limitant: VerdictFaisabilite['ingredient_limitant'] = null;
  const manquants: VerdictFaisabilite['manquants'] = [];

  for (const l of lignes) {
    const besoinG = masseBruteG.times(d(l.pourcentage_w_w)).dividedBy(100);
    const dispoG = convertirEnGrammes(l.dispo, l.unite, l.densite);
    const ratio = besoinG.isZero() ? d(Number.MAX_SAFE_INTEGER) : dispoG.dividedBy(besoinG);
    const detail = {
      article_id: l.article_id,
      code_sku: l.code_sku,
      designation: l.designation,
      besoin_g: q3(besoinG),
      disponible_g: q3(dispoG),
      manquant_g: q3(besoinG.minus(dispoG).isNegative() ? 0 : besoinG.minus(dispoG)),
    };
    if (dispoG.lessThan(besoinG)) manquants.push(detail);
    if (ratioMin === null || ratio.lessThan(ratioMin)) {
      ratioMin = ratio;
      limitant = detail;
    }
  }

  const ratio = ratioMin ?? d(0);
  const masseMax = d(masseBruteKg).times(ratio);
  return {
    faisable: manquants.length === 0,
    masse_max_kg: q3(masseMax),
    unites_max: unitesCibles ? Number(d(unitesCibles).times(ratio).floor().toFixed(0)) : null,
    ingredient_limitant: manquants.length > 0 ? limitant : null,
    manquants,
  };
}

/**
 * Creation d'un ordre de fabrication : la fiche de fabrication (formule mise a
 * l'echelle) est figee dans of_lignes_theoriques - le dossier de lot ne doit
 * jamais dependre d'une formule modifiee a posteriori.
 */
export async function creerOf(
  client: pg.PoolClient,
  utilisateurId: number,
  params: {
    formule_id: number;
    masse_nette_kg?: number | null;
    unites_pf_cibles?: number | null;
    surdosage_pct?: number;
    date_planifiee?: string | null;
    commentaire?: string | null;
  },
) {
  const formule = await queryOne(client, 'SELECT * FROM formules WHERE id = $1', [params.formule_id]);
  if (!formule) throw introuvable('Formule', params.formule_id);
  if (formule.statut === 'BROUILLON') {
    throw new ErreurMetier('FORMULE_NON_VALIDEE', "La formule doit etre validee par la R&D avant tout lancement en production.", 422);
  }

  const echelle = await miseAEchelle(client, params.formule_id, {
    masse_nette_kg: params.masse_nette_kg ?? null,
    unites_pf: params.unites_pf_cibles ?? null,
    surdosage_pct: params.surdosage_pct ?? 0,
  });

  // Blocage de la validation de l'OF si le stock ne couvre pas la fiche.
  const verdict = await controlerFaisabilite(client, params.formule_id, echelle.masse_brute_kg, params.unites_pf_cibles ?? null);
  if (!verdict.faisable) {
    throw new ErreurMetier(
      'STOCK_INSUFFISANT_OF',
      `Stock insuffisant : l'ingredient limitant est ${verdict.ingredient_limitant?.code_sku} ` +
        `(${verdict.ingredient_limitant?.designation}). Masse maximale fabricable : ${verdict.masse_max_kg} kg` +
        (verdict.unites_max !== null ? ` (soit ${verdict.unites_max} unites).` : '.'),
      422,
      verdict,
    );
  }

  const tolerance = await lireParametreNum(client, 'tolerance_pesee_pct');
  const codeOf = await genererNumero(client, 'OF');
  const of = await queryOne(
    client,
    `INSERT INTO ordres_fabrication
       (code_of, formule_id, article_pf_id, masse_cible_kg, surdosage_pct, masse_brute_kg,
        unites_pf_cibles, tolerance_pesee_pct, date_planifiee, commentaire, cree_par)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11) RETURNING *`,
    [codeOf, formule.id, formule.article_pf_id, echelle.masse_nette_kg, echelle.surdosage_pct,
     echelle.masse_brute_kg, params.unites_pf_cibles ?? null, tolerance.toFixed(3),
     params.date_planifiee ?? null, params.commentaire ?? null, utilisateurId],
  );

  for (const l of echelle.lignes) {
    await client.query(
      `INSERT INTO of_lignes_theoriques (of_id, article_id, phase, pourcentage_w_w, masse_theorique_g, consigne, ordre)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [of!.id, l.article_id, l.phase, l.pourcentage_w_w, l.masse_theorique_g, l.consigne, l.ordre],
    );
  }
  await tracer(client, utilisateurId, 'CREATION_OF', 'ordres_fabrication', of!.id, {
    code_of: codeOf, formule: `${formule.code_formule} v${formule.version}`, masse_brute_kg: echelle.masse_brute_kg,
  });
  return { ...of, faisabilite: verdict };
}

/**
 * Enregistrement d'une pesee atelier.
 *
 * Une consigne peut etre servie par plusieurs lots successifs (regle FEFO
 * lorsqu'un lot ne couvre pas la totalite du besoin) : les pesees d'une meme
 * ligne se cumulent. La ligne n'est soldee que lorsque le cumul atteint la
 * consigne dans la tolerance paramétrée, ou sur acceptation explicite du
 * responsable qualite (parametre « forcer »).
 */
export async function enregistrerPesee(
  client: pg.PoolClient,
  utilisateurId: number,
  ofId: number,
  params: { of_ligne_id: number; lot_stock_id: number; poids_reel_pesee_g: number; commentaire?: string | null; forcer?: boolean },
) {
  const of = await queryOne(client, 'SELECT * FROM ordres_fabrication WHERE id = $1 FOR UPDATE', [ofId]);
  if (!of) throw introuvable('Ordre de fabrication', ofId);
  if (!['BROUILLON', 'PESEE'].includes(of.statut_of)) {
    throw new ErreurMetier('OF_ETAPE_INVALIDE', `Les pesees ne sont plus modifiables (statut ${of.statut_of}).`, 422);
  }
  const ligne = await queryOne(client, 'SELECT * FROM of_lignes_theoriques WHERE id = $1 AND of_id = $2', [params.of_ligne_id, ofId]);
  if (!ligne) throw introuvable('Ligne de fiche de fabrication', params.of_ligne_id);

  const soldee = await queryOne(
    client, 'SELECT id FROM of_pesees_reelles WHERE of_ligne_id = $1 AND valide AND ligne_terminee', [params.of_ligne_id],
  );
  if (soldee) {
    throw new ErreurMetier('PESEE_DEJA_VALIDEE', "Cette ligne est deja soldee. Annuler la pesee pour la corriger (operation tracee).", 409);
  }

  // Le lot doit couvrir la quantite prelevee, dans son unite de stock.
  const lot = await queryOne(
    client,
    `SELECT l.*, a.unite, a.densite, a.code_sku FROM lots_stock l
       JOIN articles_catalogue a ON a.id = l.article_id WHERE l.id = $1`,
    [params.lot_stock_id],
  );
  if (!lot) throw introuvable('Lot', params.lot_stock_id);
  const grammesParUnite = convertirEnGrammes(1, lot.unite, lot.densite);
  const quantitePrelevee = d(params.poids_reel_pesee_g).dividedBy(grammesParUnite);
  if (quantitePrelevee.greaterThan(d(lot.qte_actuelle))) {
    throw new ErreurMetier(
      'STOCK_INSUFFISANT',
      `Le lot ${lot.code_lot_interne} ne contient que ${d(lot.qte_actuelle).toFixed(3)} ${lot.unite} ` +
        `(soit ${convertirEnGrammes(lot.qte_actuelle, lot.unite, lot.densite).toFixed(3)} g). ` +
        'Completer la consigne avec le lot suivant selon la regle FEFO.',
      422,
      { disponible_g: convertirEnGrammes(lot.qte_actuelle, lot.unite, lot.densite).toFixed(3) },
    );
  }

  const cumulExistant = await queryOne<{ cumul: string }>(
    client,
    'SELECT COALESCE(SUM(poids_reel_pesee_g), 0) AS cumul FROM of_pesees_reelles WHERE of_ligne_id = $1 AND valide',
    [params.of_ligne_id],
  );
  const cumul = d(cumulExistant?.cumul ?? 0).plus(params.poids_reel_pesee_g);
  const ecart = ecartPct(cumul, ligne.masse_theorique_g);
  const tolerance = d(of.tolerance_pesee_pct);
  const dansTolerance = ecart.abs().lessThanOrEqualTo(tolerance);
  const depassement = ecart.greaterThan(tolerance);

  if (depassement && !params.forcer) {
    throw new ErreurMetier(
      'PESEE_HORS_TOLERANCE',
      `Ecart de pesee de ${ecart.toFixed(3)} % : hors tolerance de +/- ${tolerance.toFixed(3)} %. ` +
        `Consigne ${d(ligne.masse_theorique_g).toFixed(3)} g, cumul pese ${cumul.toFixed(3)} g.`,
      422,
      {
        ecart_pct: ecart.toFixed(3), tolerance_pct: tolerance.toFixed(3),
        theorique_g: q3(ligne.masse_theorique_g), cumul_g: q3(cumul),
      },
    );
  }

  const ligneTerminee = dansTolerance || Boolean(params.forcer);
  const pesee = await queryOne(
    client,
    `INSERT INTO of_pesees_reelles
       (of_id, of_ligne_id, lot_stock_id, poids_theorique_g, poids_reel_pesee_g, ecart_pct, conforme, ligne_terminee, operateur_id, commentaire)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [ofId, params.of_ligne_id, params.lot_stock_id, q3(ligne.masse_theorique_g), q3(params.poids_reel_pesee_g),
     ecart.toFixed(3), dansTolerance, ligneTerminee, utilisateurId, params.commentaire ?? null],
  );
  if (of.statut_of === 'BROUILLON') {
    await client.query("UPDATE ordres_fabrication SET statut_of = 'PESEE', date_debut = COALESCE(date_debut, NOW()) WHERE id = $1", [ofId]);
  }
  await tracer(client, utilisateurId, 'PESEE', 'of_pesees_reelles', pesee!.id, {
    of_id: ofId, lot_stock_id: params.lot_stock_id, poids_g: q3(params.poids_reel_pesee_g),
    cumul_g: q3(cumul), ecart_pct: ecart.toFixed(3), conforme: dansTolerance, ligne_terminee: ligneTerminee,
  });
  return {
    ...pesee,
    cumul_g: q3(cumul),
    reste_a_peser_g: q3(d(ligne.masse_theorique_g).minus(cumul).isNegative() ? 0 : d(ligne.masse_theorique_g).minus(cumul)),
    ligne_terminee: ligneTerminee,
  };
}

/**
 * Cloture de fabrication : destockage definitif des MP pesees et generation du
 * lot de vrac. Aucune pesee ne peut manquer.
 */
export async function cloturerFabrication(
  client: pg.PoolClient,
  utilisateurId: number,
  ofId: number,
  params: { date_debut_melange?: string | null; date_fin_melange?: string | null; commentaire?: string | null },
) {
  const of = await queryOne(client, 'SELECT * FROM ordres_fabrication WHERE id = $1 FOR UPDATE', [ofId]);
  if (!of) throw introuvable('Ordre de fabrication', ofId);
  if (of.lot_vrac_id) throw new ErreurMetier('VRAC_DEJA_GENERE', 'Un lot de vrac a deja ete genere pour cet OF.', 409);
  if (of.statut_of !== 'PESEE') {
    throw new ErreurMetier('OF_ETAPE_INVALIDE', `Fabrication impossible depuis le statut ${of.statut_of}.`, 422);
  }

  const manquantes = await query(
    client,
    `SELECT a.code_sku FROM of_lignes_theoriques l JOIN articles_catalogue a ON a.id = l.article_id
      WHERE l.of_id = $1
        AND NOT EXISTS (SELECT 1 FROM of_pesees_reelles p
                         WHERE p.of_ligne_id = l.id AND p.valide AND p.ligne_terminee)`,
    [ofId],
  );
  if (manquantes.length > 0) {
    throw new ErreurMetier(
      'PESEES_INCOMPLETES',
      `Validation bloquante : ${manquantes.length} pesee(s) manquante(s) ou incomplete(s) ` +
        `(${manquantes.map((m) => m.code_sku).join(', ')}).`,
      422,
    );
  }

  // Destockage definitif des matieres premieres pesees, lot par lot.
  const pesees = await query(
    client,
    `SELECT p.*, l.article_id, l.cout_unitaire, a.unite, a.densite, a.code_sku
       FROM of_pesees_reelles p
       JOIN lots_stock l ON l.id = p.lot_stock_id
       JOIN articles_catalogue a ON a.id = l.article_id
      WHERE p.of_id = $1 AND p.valide`,
    [ofId],
  );
  let coutMp = d(0);
  let masseTotaleG = d(0);
  for (const p of pesees) {
    const grammesParUnite = convertirEnGrammes(1, p.unite, p.densite);
    const qteStock = d(p.poids_reel_pesee_g).dividedBy(grammesParUnite);
    await ecrireMouvement(client, {
      lot_stock_id: p.lot_stock_id,
      type_mouvement: 'SORTIE_PRODUCTION',
      quantite: q3(qteStock.negated()),
      cout_unitaire: p.cout_unitaire,
      of_id: ofId,
      motif: `Pesee OF ${of.code_of} - ${p.code_sku}`,
      utilisateur_id: utilisateurId,
    });
    coutMp = coutMp.plus(coutParGramme(p.cout_unitaire, p.unite, p.densite).times(p.poids_reel_pesee_g));
    masseTotaleG = masseTotaleG.plus(p.poids_reel_pesee_g);
  }

  const codeVrac = await genererNumero(client, 'VRAC');
  const masseNetteKg = masseTotaleG.dividedBy(1000);
  const vrac = await queryOne(
    client,
    `INSERT INTO lots_vrac (code_lot_vrac, of_id, formule_id, masse_nette_kg, masse_restante_kg, statut,
                            date_debut_melange, date_fin_melange, cout_total, commentaire_qualite)
     VALUES ($1,$2,$3,$4,$4,'QUARANTAINE',COALESCE($5::timestamptz, NOW()),COALESCE($6::timestamptz, NOW()),$7,$8)
     RETURNING *`,
    [codeVrac, ofId, of.formule_id, q3(masseNetteKg), params.date_debut_melange ?? null,
     params.date_fin_melange ?? null, p4(coutMp), params.commentaire ?? null],
  );
  await client.query(
    `UPDATE ordres_fabrication SET statut_of = 'FABRICATION', lot_vrac_id = $2, cout_mp = $3 WHERE id = $1`,
    [ofId, vrac!.id, p4(coutMp)],
  );
  await tracer(client, utilisateurId, 'CLOTURE_FABRICATION', 'lots_vrac', vrac!.id, {
    of_id: ofId, code_lot_vrac: codeVrac, masse_nette_kg: q3(masseNetteKg), cout_mp: p4(coutMp),
  });
  return vrac;
}

/** Controle qualite de cuve et liberation (ou rejet) du lot de vrac. */
export async function libererVrac(
  client: pg.PoolClient,
  utilisateurId: number,
  ofId: number,
  params: {
    ph_mesure: number;
    viscosite_mesuree?: number | null;
    aspect: string;
    couleur: string;
    odeur: string;
    conforme_organoleptique: boolean;
    decision: 'LIBERE' | 'REJETE';
    commentaire?: string | null;
  },
) {
  const of = await queryOne(
    client,
    `SELECT o.*, f.ph_min, f.ph_max, f.viscosite_min, f.viscosite_max
       FROM ordres_fabrication o JOIN formules f ON f.id = o.formule_id WHERE o.id = $1 FOR UPDATE OF o`,
    [ofId],
  );
  if (!of) throw introuvable('Ordre de fabrication', ofId);
  if (!of.lot_vrac_id) throw new ErreurMetier('VRAC_MANQUANT', "La fabrication doit etre cloturee avant le controle de cuve.", 422);
  if (of.statut_of !== 'FABRICATION') {
    throw new ErreurMetier('OF_ETAPE_INVALIDE', `Controle de cuve impossible depuis le statut ${of.statut_of}.`, 422);
  }

  const horsSpec: string[] = [];
  if (of.ph_min !== null && d(params.ph_mesure).lessThan(d(of.ph_min))) horsSpec.push(`pH ${params.ph_mesure} < ${of.ph_min}`);
  if (of.ph_max !== null && d(params.ph_mesure).greaterThan(d(of.ph_max))) horsSpec.push(`pH ${params.ph_mesure} > ${of.ph_max}`);
  if (params.viscosite_mesuree != null) {
    if (of.viscosite_min !== null && d(params.viscosite_mesuree).lessThan(d(of.viscosite_min))) {
      horsSpec.push(`viscosite ${params.viscosite_mesuree} < ${of.viscosite_min}`);
    }
    if (of.viscosite_max !== null && d(params.viscosite_mesuree).greaterThan(d(of.viscosite_max))) {
      horsSpec.push(`viscosite ${params.viscosite_mesuree} > ${of.viscosite_max}`);
    }
  }
  if (!params.conforme_organoleptique) horsSpec.push('controle organoleptique non conforme');

  if (params.decision === 'LIBERE' && horsSpec.length > 0) {
    throw new ErreurMetier(
      'VRAC_HORS_SPECIFICATION',
      `Liberation refusee : ${horsSpec.join(' ; ')}. Le vrac doit etre rejete ou retouche.`,
      422,
      { hors_specification: horsSpec },
    );
  }

  const vrac = await queryOne(
    client,
    `UPDATE lots_vrac SET statut = $2, ph_mesure = $3, viscosite_mesuree = $4, aspect = $5, couleur = $6,
            odeur = $7, conforme_organoleptique = $8, commentaire_qualite = COALESCE($9, commentaire_qualite),
            libere_par = $10, libere_le = NOW()
      WHERE id = $1 RETURNING *`,
    [of.lot_vrac_id, params.decision, params.ph_mesure, params.viscosite_mesuree ?? null, params.aspect,
     params.couleur, params.odeur, params.conforme_organoleptique, params.commentaire ?? null, utilisateurId],
  );
  await client.query(
    `UPDATE ordres_fabrication SET statut_of = $2 WHERE id = $1`,
    [ofId, params.decision === 'LIBERE' ? 'VRAC_LIBERE' : 'ANNULE'],
  );
  await tracer(client, utilisateurId, params.decision === 'LIBERE' ? 'LIBERATION_VRAC' : 'REJET_VRAC', 'lots_vrac', of.lot_vrac_id, {
    of_id: ofId, ph: params.ph_mesure, viscosite: params.viscosite_mesuree ?? null, hors_specification: horsSpec,
  });
  return vrac;
}

/**
 * Etape 3 : conditionnement. Le lot de produit fini nait du lot de vrac libere,
 * consomme les articles de conditionnement et entre en stock au statut conforme.
 */
export async function conditionner(
  client: pg.PoolClient,
  utilisateurId: number,
  ofId: number,
  params: {
    unites_produites: number;
    unites_rebut?: number;
    dluo?: string | null;
    consommations: { article_ac_id: number; lot_stock_id: number; qte_consommee: number; qte_rebut?: number }[];
  },
) {
  const of = await queryOne(
    client,
    `SELECT o.*, v.code_lot_vrac, v.masse_restante_kg, v.masse_nette_kg, v.statut AS statut_vrac,
            v.cout_total AS cout_vrac, f.densite, a.contenance_ml, a.code_sku AS pf_code_sku
       FROM ordres_fabrication o
       JOIN lots_vrac v ON v.id = o.lot_vrac_id
       JOIN formules f ON f.id = o.formule_id
       LEFT JOIN articles_catalogue a ON a.id = o.article_pf_id
      WHERE o.id = $1 FOR UPDATE OF o`,
    [ofId],
  );
  if (!of) throw introuvable('Ordre de fabrication (ou lot de vrac)', ofId);
  if (!['VRAC_LIBERE', 'CONDITIONNEMENT'].includes(of.statut_of)) {
    throw new ErreurMetier('OF_ETAPE_INVALIDE', `Conditionnement impossible depuis le statut ${of.statut_of}.`, 422);
  }
  if (of.statut_vrac !== 'LIBERE') {
    throw new ErreurMetier('VRAC_NON_LIBERE', `Le lot de vrac ${of.code_lot_vrac} n'est pas libere par le controle qualite.`, 422);
  }
  if (!of.article_pf_id || !of.contenance_ml) {
    throw new ErreurMetier('PF_NON_PARAMETRE', "Le produit fini rattache a la formule doit exister et disposer d'une contenance (ml).", 422);
  }

  // Masse de vrac reellement mobilisee par les unites conditionnees.
  const masseUnitaireG = d(of.contenance_ml).times(of.densite);
  const masseConsommeeKg = masseUnitaireG.times(params.unites_produites).dividedBy(1000);
  if (masseConsommeeKg.greaterThan(d(of.masse_restante_kg).plus('0.001'))) {
    throw new ErreurMetier(
      'VRAC_INSUFFISANT',
      `Le lot de vrac ${of.code_lot_vrac} ne contient que ${d(of.masse_restante_kg).toFixed(3)} kg : ` +
        `${params.unites_produites} unites exigent ${masseConsommeeKg.toFixed(3)} kg.`,
      422,
    );
  }

  // Consommation des articles de conditionnement (rebuts inclus dans le cout).
  let coutAc = d(0);
  for (const c of params.consommations) {
    const lot = await queryOne(
      client,
      `SELECT l.*, a.code_sku, a.type FROM lots_stock l JOIN articles_catalogue a ON a.id = l.article_id WHERE l.id = $1`,
      [c.lot_stock_id],
    );
    if (!lot) throw introuvable('Lot de conditionnement', c.lot_stock_id);
    if (lot.type !== 'AC') throw new ErreurMetier('TYPE_INVALIDE', `Le lot ${lot.code_lot_interne} n'est pas un article de conditionnement.`, 422);
    if (lot.article_id !== c.article_ac_id) {
      throw new ErreurMetier('LOT_ARTICLE_INCOHERENT', `Le lot ${lot.code_lot_interne} n'appartient pas a l'article declare.`, 422);
    }
    const total = d(c.qte_consommee).plus(c.qte_rebut ?? 0);
    await client.query(
      `INSERT INTO of_conditionnement (of_id, article_ac_id, lot_stock_id, qte_consommee, qte_rebut, operateur_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ofId, c.article_ac_id, c.lot_stock_id, q3(c.qte_consommee), q3(c.qte_rebut ?? 0), utilisateurId],
    );
    await ecrireMouvement(client, {
      lot_stock_id: c.lot_stock_id,
      type_mouvement: 'SORTIE_PRODUCTION',
      quantite: q3(total.negated()),
      cout_unitaire: lot.cout_unitaire,
      of_id: ofId,
      motif: `Conditionnement OF ${of.code_of} - ${lot.code_sku}`,
      utilisateur_id: utilisateurId,
    });
    coutAc = coutAc.plus(d(lot.cout_unitaire).times(total));
  }

  // Naissance du lot de produit fini, rattache au vrac (regle non negociable).
  const codeLotPf = await genererNumero(client, 'LOT-PF');
  const lotPf = await queryOne(
    client,
    `INSERT INTO lots_stock (article_id, code_lot_interne, lot_vrac_id, of_id, qte_initiale, qte_actuelle,
                             statut, dluo, date_fabrication, prix_achat_unitaire, cree_par)
     VALUES ($1,$2,$3,$4,$5,0,'CONFORME',$6::date,CURRENT_DATE,$7,$8) RETURNING *`,
    [of.article_pf_id, codeLotPf, of.lot_vrac_id, ofId, params.unites_produites, params.dluo ?? null, 0, utilisateurId],
  );
  await ecrireMouvement(client, {
    lot_stock_id: lotPf!.id,
    type_mouvement: 'ENTREE_PRODUCTION',
    quantite: params.unites_produites,
    cout_unitaire: 0,
    of_id: ofId,
    motif: `Conditionnement OF ${of.code_of} - vrac ${of.code_lot_vrac}`,
    utilisateur_id: utilisateurId,
  });

  await client.query(
    `UPDATE lots_vrac SET masse_restante_kg = GREATEST(0, masse_restante_kg - $2) WHERE id = $1`,
    [of.lot_vrac_id, q3(masseConsommeeKg)],
  );

  // Rendement reel = unites conformes produites / unites theoriques du vrac.
  const unitesTheoriques = d(of.masse_nette_kg).times(1000).dividedBy(masseUnitaireG);
  const rendement = unitesTheoriques.isZero() ? d(0) : d(params.unites_produites).dividedBy(unitesTheoriques).times(100);

  const of2 = await queryOne(
    client,
    `UPDATE ordres_fabrication
        SET statut_of = 'CONDITIONNEMENT',
            unites_produites = unites_produites + $2,
            unites_rebut = unites_rebut + $3,
            cout_ac = cout_ac + $4,
            rendement_pct = $5
      WHERE id = $1 RETURNING *`,
    [ofId, params.unites_produites, params.unites_rebut ?? 0, p4(coutAc), rendement.toFixed(3)],
  );
  await tracer(client, utilisateurId, 'CONDITIONNEMENT', 'lots_stock', lotPf!.id, {
    of_id: ofId, code_lot_pf: codeLotPf, unites: params.unites_produites, rendement_pct: rendement.toFixed(3),
  });
  return { lot_pf: { ...lotPf, code_lot_interne: codeLotPf }, ordre_fabrication: of2, rendement_pct: rendement.toFixed(3) };
}

export interface DetailCru {
  cout_mp: string;
  cout_ac: string;
  cout_main_oeuvre: string;
  cout_charges_indirectes: string;
  cout_total: string;
  unites_produites: number;
  cru: string;
  heures_production: string;
  taux_horaire_mo: string;
  taux_charges_indirectes_horaire: string;
}

/**
 * Cloture de l'OF et calcul du Cout de Revient Unitaire reel :
 *   CRU = (cout MP + cout AC + cout main d'oeuvre + charges indirectes imputees)
 *         / nombre d'unites de PF conformes produites
 * Les heures de main d'oeuvre proviennent des pointages affectes a l'OF, a
 * defaut de la saisie directe portee par l'ordre de fabrication.
 */
export async function cloturerOf(client: pg.PoolClient, utilisateurId: number, ofId: number): Promise<{ of: any; cru: DetailCru }> {
  const of = await queryOne(client, 'SELECT * FROM ordres_fabrication WHERE id = $1 FOR UPDATE', [ofId]);
  if (!of) throw introuvable('Ordre de fabrication', ofId);
  if (of.statut_of === 'CLOTURE') throw new ErreurMetier('OF_DEJA_CLOTURE', 'Cet ordre de fabrication est deja cloture.', 409);
  if (of.statut_of !== 'CONDITIONNEMENT') {
    throw new ErreurMetier('OF_ETAPE_INVALIDE', `Cloture impossible depuis le statut ${of.statut_of} : le conditionnement doit etre declare.`, 422);
  }
  if (Number(of.unites_produites) <= 0) {
    throw new ErreurMetier('AUCUNE_UNITE', 'Cloture impossible : aucune unite de produit fini conforme declaree.', 422);
  }

  const pointages = await queryOne<{ heures: string }>(
    client,
    'SELECT COALESCE(SUM(heures), 0) AS heures FROM pointages WHERE of_id = $1',
    [ofId],
  );
  const coutMoPointe = await queryOne<{ cout: string }>(
    client,
    `SELECT COALESCE(SUM(p.heures * s.taux_horaire), 0) AS cout
       FROM pointages p JOIN salaries s ON s.id = p.salarie_id WHERE p.of_id = $1`,
    [ofId],
  );

  const tauxMo = await lireParametreNum(client, 'taux_horaire_mo');
  const tauxIndirect = await lireParametreNum(client, 'taux_charges_indirectes_horaire');
  const pctFraisGeneraux = await lireParametreNum(client, 'taux_frais_generaux_pct');

  const heures = d(pointages?.heures ?? 0).greaterThan(0) ? d(pointages!.heures) : d(of.heures_production);
  const coutMo = d(coutMoPointe?.cout ?? 0).greaterThan(0) ? d(coutMoPointe!.cout) : heures.times(tauxMo);

  const coutMp = d(of.cout_mp);
  const coutAc = d(of.cout_ac);
  // Charges indirectes imputees a l'heure de production + quote-part de frais generaux.
  const depensesDirectes = await queryOne<{ montant: string }>(
    client,
    'SELECT COALESCE(SUM(montant_ht), 0) AS montant FROM depenses WHERE of_id = $1',
    [ofId],
  );
  const coutIndirect = heures.times(tauxIndirect)
    .plus(coutMp.plus(coutAc).plus(coutMo).times(pctFraisGeneraux).dividedBy(100))
    .plus(d(depensesDirectes?.montant ?? 0));

  const coutTotal = coutMp.plus(coutAc).plus(coutMo).plus(coutIndirect);
  const cru = coutTotal.dividedBy(of.unites_produites);

  const maj = await queryOne(
    client,
    `UPDATE ordres_fabrication
        SET statut_of = 'CLOTURE', date_cloture = NOW(), heures_production = $2,
            cout_main_oeuvre = $3, cout_charges_indirectes = $4, cru = $5
      WHERE id = $1 RETURNING *`,
    [ofId, heures.toFixed(2), p4(coutMo), p4(coutIndirect), p4(cru)],
  );

  // Valorisation du stock de produits finis issus de cet OF au cout reel.
  await client.query(
    `UPDATE lots_stock SET prix_achat_unitaire = $2 WHERE of_id = $1 AND lot_vrac_id IS NOT NULL`,
    [ofId, p4(cru)],
  );
  const pfArticle = await queryOne<{ article_id: number }>(
    client, 'SELECT article_pf_id AS article_id FROM ordres_fabrication WHERE id = $1', [ofId],
  );
  if (pfArticle?.article_id) {
    await client.query(
      `UPDATE articles_catalogue a SET pamp = COALESCE((
          SELECT SUM(l.qte_actuelle * l.cout_unitaire) / NULLIF(SUM(l.qte_actuelle), 0)
            FROM lots_stock l WHERE l.article_id = a.id AND l.statut <> 'REJETE' AND l.qte_actuelle > 0
        ), a.pamp) WHERE a.id = $1`,
      [pfArticle.article_id],
    );
  }

  const detail: DetailCru = {
    cout_mp: p4(coutMp),
    cout_ac: p4(coutAc),
    cout_main_oeuvre: p4(coutMo),
    cout_charges_indirectes: p4(coutIndirect),
    cout_total: p4(coutTotal),
    unites_produites: Number(of.unites_produites),
    cru: p4(cru),
    heures_production: heures.toFixed(2),
    taux_horaire_mo: p4(tauxMo),
    taux_charges_indirectes_horaire: p4(tauxIndirect),
  };
  await tracer(client, utilisateurId, 'CLOTURE_OF', 'ordres_fabrication', ofId, detail as unknown as Record<string, unknown>);
  return { of: maj, cru: detail };
}

/** Dossier de lot electronique complet (fiche suiveuse). */
export async function dossierDeLot(db: Db, ofId: number) {
  const of = await queryOne(
    db,
    `SELECT o.*, f.code_formule, f.version AS formule_version, f.nom_produit, f.densite, f.ph_min, f.ph_max,
            f.viscosite_min, f.viscosite_max, a.code_sku AS pf_code_sku, a.designation AS pf_designation,
            a.contenance_ml, v.code_lot_vrac, v.statut AS statut_vrac, v.ph_mesure, v.viscosite_mesuree,
            v.aspect, v.couleur, v.odeur, v.conforme_organoleptique, v.date_debut_melange, v.date_fin_melange,
            v.masse_nette_kg, v.masse_restante_kg, v.libere_le, u.nom_complet AS cree_par_nom,
            ul.nom_complet AS libere_par_nom
       FROM ordres_fabrication o
       JOIN formules f ON f.id = o.formule_id
       LEFT JOIN articles_catalogue a ON a.id = o.article_pf_id
       LEFT JOIN lots_vrac v ON v.id = o.lot_vrac_id
       LEFT JOIN utilisateurs u ON u.id = o.cree_par
       LEFT JOIN utilisateurs ul ON ul.id = v.libere_par
      WHERE o.id = $1`,
    [ofId],
  );
  if (!of) throw introuvable('Ordre de fabrication', ofId);

  // Une ligne peut avoir ete pesee depuis plusieurs lots : les prelevements
  // sont agreges et le detail lot par lot est conserve pour le dossier de lot.
  const lignes = await query(
    db,
    `SELECT l.*, a.code_sku, a.designation, a.nom_inci, a.unite,
            p.cumul AS poids_reel_pesee_g, p.ecart_pct, p.conforme, p.ligne_terminee,
            p.date_pesee, p.pesee_id, p.commentaire AS pesee_commentaire,
            p.code_lot_interne, p.code_lot_fournisseur, p.dluo, p.operateur, p.prelevements
       FROM of_lignes_theoriques l
       JOIN articles_catalogue a ON a.id = l.article_id
       LEFT JOIN (
         SELECT pr.of_ligne_id,
                SUM(pr.poids_reel_pesee_g)                       AS cumul,
                MAX(pr.ecart_pct)                                AS ecart_pct,
                BOOL_AND(pr.conforme)                            AS conforme,
                BOOL_OR(pr.ligne_terminee)                       AS ligne_terminee,
                MAX(pr.date_pesee)                               AS date_pesee,
                MAX(pr.id)                                       AS pesee_id,
                STRING_AGG(DISTINCT pr.commentaire, ' | ')       AS commentaire,
                STRING_AGG(DISTINCT ls.code_lot_interne, ', ')   AS code_lot_interne,
                STRING_AGG(DISTINCT ls.code_lot_fournisseur, ', ') AS code_lot_fournisseur,
                MIN(ls.dluo)                                     AS dluo,
                STRING_AGG(DISTINCT u.nom_complet, ', ')         AS operateur,
                JSON_AGG(JSON_BUILD_OBJECT('pesee_id', pr.id, 'lot', ls.code_lot_interne,
                         'poids_g', pr.poids_reel_pesee_g, 'date', pr.date_pesee,
                         'conforme', pr.conforme) ORDER BY pr.id) AS prelevements
           FROM of_pesees_reelles pr
           JOIN lots_stock ls ON ls.id = pr.lot_stock_id
           LEFT JOIN utilisateurs u ON u.id = pr.operateur_id
          WHERE pr.valide
          GROUP BY pr.of_ligne_id
       ) p ON p.of_ligne_id = l.id
      WHERE l.of_id = $1 ORDER BY l.phase, l.ordre, l.id`,
    [ofId],
  );
  const conditionnement = await query(
    db,
    `SELECT c.*, a.code_sku, a.designation, l.code_lot_interne
       FROM of_conditionnement c
       JOIN articles_catalogue a ON a.id = c.article_ac_id
       JOIN lots_stock l ON l.id = c.lot_stock_id
      WHERE c.of_id = $1 ORDER BY c.id`,
    [ofId],
  );
  const lotsPf = await query(
    db,
    `SELECT l.*, a.code_sku, a.designation FROM lots_stock l JOIN articles_catalogue a ON a.id = l.article_id
      WHERE l.of_id = $1 AND l.lot_vrac_id IS NOT NULL ORDER BY l.id`,
    [ofId],
  );
  const pointages = await query(
    db,
    `SELECT p.*, s.nom, s.prenom, s.fonction, s.taux_horaire FROM pointages p
       JOIN salaries s ON s.id = p.salarie_id WHERE p.of_id = $1 ORDER BY p.date_jour`,
    [ofId],
  );
  const pesees = lignes.filter((l) => l.ligne_terminee).length;

  return {
    ...of,
    lignes,
    conditionnement,
    lots_pf: lotsPf,
    pointages,
    avancement: {
      lignes_totales: lignes.length,
      lignes_pesees: pesees,
      pesees_completes: pesees === lignes.length && lignes.length > 0,
      masse_pesee_g: q3(somme(lignes.map((l) => l.poids_reel_pesee_g ?? 0))),
      masse_theorique_g: q3(somme(lignes.map((l) => l.masse_theorique_g))),
    },
  };
}

/**
 * Proposition d'allocation FEFO pour une ligne de fiche de fabrication :
 * quels lots prelever, en grammes et dans l'unite de stock, pour atteindre la
 * consigne restante.
 */
export async function propositionFefoLigne(db: Db, ofId: number, ligneId: number) {
  const ligne = await queryOne(
    db,
    `SELECT l.*, a.code_sku, a.designation, a.unite, a.densite
       FROM of_lignes_theoriques l JOIN articles_catalogue a ON a.id = l.article_id
      WHERE l.id = $1 AND l.of_id = $2`,
    [ligneId, ofId],
  );
  if (!ligne) throw introuvable('Ligne de fiche de fabrication', ligneId);

  const cumul = await queryOne<{ cumul: string; terminee: boolean }>(
    db,
    `SELECT COALESCE(SUM(poids_reel_pesee_g), 0) AS cumul,
            COALESCE(BOOL_OR(ligne_terminee), FALSE) AS terminee
       FROM of_pesees_reelles WHERE of_ligne_id = $1 AND valide`,
    [ligneId],
  );
  const reste = d(ligne.masse_theorique_g).minus(cumul?.cumul ?? 0);
  const grammesParUnite = convertirEnGrammes(1, ligne.unite, ligne.densite);

  const lots = await query(
    db,
    `SELECT id, code_lot_interne, code_lot_fournisseur, dluo, qte_actuelle, emplacement, cout_unitaire
       FROM lots_stock
      WHERE article_id = $1 AND statut = 'CONFORME' AND qte_actuelle > 0
        AND (dluo IS NULL OR dluo >= CURRENT_DATE)
      ORDER BY dluo NULLS LAST, date_reception, id`,
    [ligne.article_id],
  );

  let restant = reste.greaterThan(0) ? reste : d(0);
  const propositions = [];
  for (const lot of lots) {
    if (restant.lessThanOrEqualTo(0)) break;
    const disponibleG = d(lot.qte_actuelle).times(grammesParUnite);
    const prise = disponibleG.greaterThan(restant) ? restant : disponibleG;
    propositions.push({
      lot_stock_id: lot.id,
      code_lot_interne: lot.code_lot_interne,
      code_lot_fournisseur: lot.code_lot_fournisseur,
      dluo: lot.dluo,
      emplacement: lot.emplacement,
      disponible_g: q3(disponibleG),
      disponible_unite_stock: q3(lot.qte_actuelle),
      a_prelever_g: q3(prise),
      a_prelever_unite_stock: q3(prise.dividedBy(grammesParUnite)),
      unite: ligne.unite,
    });
    restant = restant.minus(prise);
  }

  return {
    of_ligne_id: ligneId,
    article: { id: ligne.article_id, code_sku: ligne.code_sku, designation: ligne.designation, unite: ligne.unite },
    phase: ligne.phase,
    consigne: ligne.consigne,
    masse_theorique_g: q3(ligne.masse_theorique_g),
    deja_pese_g: q3(cumul?.cumul ?? 0),
    reste_a_peser_g: q3(reste.greaterThan(0) ? reste : 0),
    ligne_terminee: Boolean(cumul?.terminee),
    couverture_complete: restant.lessThanOrEqualTo('0.001'),
    manquant_g: q3(restant),
    propositions,
  };
}
