import { query, queryOne, type Db } from '../../db/pool.js';
import { ErreurMetier, introuvable } from '../../core/erreurs.js';
import { d, q3, Decimal } from '../../core/nombres.js';
import { convertirEnGrammes } from '../formules/service.js';

export interface BesoinComposant {
  article_id: number;
  code_sku: string;
  designation: string;
  type: 'MP' | 'AC';
  unite: string;
  phase: string | null;
  besoin_unitaire: string;          // dans l'unite de stock de l'article
  stock_disponible: string;
  unites_fabricables: string;       // floor(stock / besoin unitaire)
  limitant: boolean;
  manquant_pour_cible: string;
}

export interface SimulationPf {
  article_pf_id: number;
  code_sku: string;
  designation: string;
  formule_id: number;
  code_formule: string;
  version: number;
  masse_unitaire_g: string;
  unites_cibles: number | null;
  unites_max_fabricables: number;
  composant_limitant: { article_id: number; code_sku: string; designation: string; type: string } | null;
  cible_atteignable: boolean;
  composants: BesoinComposant[];
}

/** Besoin unitaire de chaque composant (MP en unite de stock, AC en pieces). */
async function composantsUnitaires(db: Db, articlePfId: number, formuleId?: number) {
  const pf = await queryOne(db, "SELECT * FROM articles_catalogue WHERE id = $1 AND type = 'PF'", [articlePfId]);
  if (!pf) throw introuvable('Produit fini', articlePfId);

  const formule = formuleId
    ? await queryOne(db, 'SELECT * FROM formules WHERE id = $1', [formuleId])
    : await queryOne(
        db,
        `SELECT * FROM formules WHERE article_pf_id = $1 AND statut = 'VALIDEE'
          ORDER BY version DESC LIMIT 1`,
        [articlePfId],
      );
  if (!formule) {
    throw new ErreurMetier('FORMULE_ABSENTE', `Aucune formule validee n'est rattachee au produit fini ${pf.code_sku}.`, 422);
  }
  if (!pf.contenance_ml) {
    throw new ErreurMetier('CONTENANCE_INCONNUE', `La contenance nominale (ml) du produit fini ${pf.code_sku} n'est pas renseignee.`, 422);
  }

  // Masse de vrac necessaire pour une unite de produit fini.
  const masseUnitaireG = d(pf.contenance_ml).times(formule.densite)
    .times(d(1).plus(d(formule.perte_process_pct).dividedBy(100)));

  const mp = await query(
    db,
    `SELECT fl.article_id, fl.phase, fl.pourcentage_w_w, a.code_sku, a.designation, a.unite, a.densite, a.pamp,
            s.qte_disponible
       FROM formule_lignes fl
       JOIN articles_catalogue a ON a.id = fl.article_id
       JOIN v_stock_disponible s ON s.article_id = a.id
      WHERE fl.formule_id = $1 ORDER BY fl.phase, fl.ordre`,
    [formule.id],
  );
  const ac = await query(
    db,
    `SELECT n.article_ac_id AS article_id, n.qte_par_unite, a.code_sku, a.designation, a.unite, s.qte_disponible
       FROM nomenclature_ac n
       JOIN articles_catalogue a ON a.id = n.article_ac_id
       JOIN v_stock_disponible s ON s.article_id = a.id
      WHERE n.article_pf_id = $1 ORDER BY a.code_sku`,
    [articlePfId],
  );

  const composants = [
    ...mp.map((l) => {
      // Besoin en grammes puis conversion vers l'unite de stock de la MP.
      const besoinG = masseUnitaireG.times(d(l.pourcentage_w_w)).dividedBy(100);
      const facteur = convertirEnGrammes(1, l.unite, l.densite); // grammes par unite de stock
      return {
        article_id: l.article_id,
        code_sku: l.code_sku,
        designation: l.designation,
        type: 'MP' as const,
        unite: l.unite,
        phase: l.phase as string,
        besoin_unitaire: besoinG.dividedBy(facteur),
        stock_disponible: d(l.qte_disponible),
      };
    }),
    ...ac.map((l) => ({
      article_id: l.article_id,
      code_sku: l.code_sku,
      designation: l.designation,
      type: 'AC' as const,
      unite: l.unite,
      phase: null,
      besoin_unitaire: d(l.qte_par_unite),
      stock_disponible: d(l.qte_disponible),
    })),
  ];

  return { pf, formule, masseUnitaireG, composants };
}

/**
 * Moteur de capacite predictive : nombre maximal theorique d'unites de produit
 * fini fabricables = min sur tous les composants de floor(stock / besoin unitaire).
 */
export async function simulerPf(db: Db, articlePfId: number, unitesCibles: number | null, formuleId?: number): Promise<SimulationPf> {
  const { pf, formule, masseUnitaireG, composants } = await composantsUnitaires(db, articlePfId, formuleId);
  if (composants.length === 0) {
    throw new ErreurMetier('NOMENCLATURE_VIDE', `Aucun composant n'est defini pour ${pf.code_sku}.`, 422);
  }

  let maxUnites: Decimal | null = null;
  const details = composants.map((c) => {
    const fabricables = c.besoin_unitaire.isZero()
      ? new Decimal(Number.MAX_SAFE_INTEGER)
      : c.stock_disponible.dividedBy(c.besoin_unitaire).floor();
    if (maxUnites === null || fabricables.lessThan(maxUnites)) maxUnites = fabricables;
    return { ...c, fabricables };
  });
  const maximum = (maxUnites ?? new Decimal(0)).isNegative() ? new Decimal(0) : (maxUnites ?? new Decimal(0));
  const cible = unitesCibles ? d(unitesCibles) : null;

  const composantsSortie: BesoinComposant[] = details.map((c) => {
    const besoinTotal = cible ? c.besoin_unitaire.times(cible) : c.besoin_unitaire.times(maximum);
    const manquant = besoinTotal.minus(c.stock_disponible);
    return {
      article_id: c.article_id,
      code_sku: c.code_sku,
      designation: c.designation,
      type: c.type,
      unite: c.unite,
      phase: c.phase,
      besoin_unitaire: q3(c.besoin_unitaire),
      stock_disponible: q3(c.stock_disponible),
      unites_fabricables: c.fabricables.toFixed(0),
      limitant: c.fabricables.equals(maximum),
      manquant_pour_cible: q3(manquant.isNegative() ? 0 : manquant),
    };
  });

  const limitant = details.find((c) => c.fabricables.equals(maximum)) ?? null;

  return {
    article_pf_id: pf.id,
    code_sku: pf.code_sku,
    designation: pf.designation,
    formule_id: formule.id,
    code_formule: formule.code_formule,
    version: formule.version,
    masse_unitaire_g: q3(masseUnitaireG),
    unites_cibles: unitesCibles,
    unites_max_fabricables: Number(maximum.toFixed(0)),
    composant_limitant: limitant
      ? { article_id: limitant.article_id, code_sku: limitant.code_sku, designation: limitant.designation, type: limitant.type }
      : null,
    cible_atteignable: cible ? maximum.greaterThanOrEqualTo(cible) : true,
    composants: composantsSortie,
  };
}

/**
 * Simulation consolidee sur une liste de produits finis : les besoins des
 * composants partages sont cumules avant confrontation au stock.
 */
export async function simulerPortefeuille(
  db: Db,
  demandes: { article_pf_id: number; unites_cibles?: number | null; formule_id?: number }[],
) {
  const simulations: SimulationPf[] = [];
  const cumul = new Map<number, { code_sku: string; designation: string; type: string; unite: string; besoin: Decimal; stock: Decimal }>();

  for (const demande of demandes) {
    const sim = await simulerPf(db, demande.article_pf_id, demande.unites_cibles ?? null, demande.formule_id);
    simulations.push(sim);
    const base = demande.unites_cibles ?? sim.unites_max_fabricables;
    for (const c of sim.composants) {
      const courant = cumul.get(c.article_id) ?? {
        code_sku: c.code_sku, designation: c.designation, type: c.type, unite: c.unite,
        besoin: new Decimal(0), stock: d(c.stock_disponible),
      };
      courant.besoin = courant.besoin.plus(d(c.besoin_unitaire).times(base));
      cumul.set(c.article_id, courant);
    }
  }

  const besoinsConsolides = [...cumul.entries()].map(([article_id, v]) => {
    const manquant = v.besoin.minus(v.stock);
    return {
      article_id,
      code_sku: v.code_sku,
      designation: v.designation,
      type: v.type,
      unite: v.unite,
      besoin_total: q3(v.besoin),
      stock_disponible: q3(v.stock),
      manquant: q3(manquant.isNegative() ? 0 : manquant),
      couvert: !manquant.isPositive(),
    };
  });

  return {
    simulations,
    besoins_consolides: besoinsConsolides.sort((a, b) => Number(b.manquant) - Number(a.manquant)),
    approvisionnement_necessaire: besoinsConsolides.some((b) => !b.couvert),
  };
}
