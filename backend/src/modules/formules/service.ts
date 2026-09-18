import { query, queryOne, type Db } from '../../db/pool.js';
import { ErreurMetier, introuvable } from '../../core/erreurs.js';
import { d, q3, somme, Decimal } from '../../core/nombres.js';

export const TOTAL_PONDERAL_EXIGE = new Decimal('100.000');

export interface LigneFormuleEntree {
  article_id: number;
  phase: 'A' | 'B' | 'C' | 'D' | 'E';
  pourcentage_w_w: number | string;
  consigne?: string | null;
  ordre?: number;
}

/**
 * Controle d'integrite ponderale (regle metier non negociable) :
 * SUM(pourcentage_w_w) doit valoir exactement 100,000 % (3 decimales).
 * Ce controle double le trigger differe de la base : l'API rejette avant
 * meme d'ouvrir la transaction, avec un message exploitable par l'IHM.
 */
export function controlerSommePonderale(lignes: { pourcentage_w_w: number | string }[]): Decimal {
  const total = somme(lignes.map((l) => l.pourcentage_w_w));
  const arrondi = new Decimal(total.toFixed(3));
  if (!arrondi.equals(TOTAL_PONDERAL_EXIGE)) {
    const ecart = arrondi.minus(TOTAL_PONDERAL_EXIGE);
    throw new ErreurMetier(
      'FORMULE_SOMME_INVALIDE',
      `La somme ponderale de la formule est de ${arrondi.toFixed(3)} % (ecart de ${ecart.toFixed(3)} %). ` +
        'Une formule cosmetique doit totaliser exactement 100,000 % (w/w).',
      422,
      { somme: arrondi.toFixed(3), ecart: ecart.toFixed(3), attendu: '100.000' },
    );
  }
  return arrondi;
}

/** Remplace integralement le tableau d'ingredients d'une formule (operation atomique). */
export async function remplacerLignes(db: Db, formuleId: number, lignes: LigneFormuleEntree[]) {
  const formule = await queryOne(db, 'SELECT * FROM formules WHERE id = $1', [formuleId]);
  if (!formule) throw introuvable('Formule', formuleId);
  if (formule.statut === 'ARCHIVEE') {
    throw new ErreurMetier('FORMULE_ARCHIVEE', 'Une formule archivee ne peut plus etre modifiee. Creer une nouvelle version.', 422);
  }
  if (lignes.length > 0) controlerSommePonderale(lignes);

  await db.query('DELETE FROM formule_lignes WHERE formule_id = $1', [formuleId]);
  let ordre = 0;
  for (const l of lignes) {
    await db.query(
      `INSERT INTO formule_lignes (formule_id, article_id, phase, pourcentage_w_w, consigne, ordre)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [formuleId, l.article_id, l.phase, d(l.pourcentage_w_w).toFixed(3), l.consigne ?? null, l.ordre ?? ordre++],
    );
  }
  return lignesDeFormule(db, formuleId);
}

export async function lignesDeFormule(db: Db, formuleId: number) {
  return query(
    db,
    `SELECT fl.*, a.code_sku, a.designation, a.nom_inci, a.unite, a.pamp, a.densite,
            s.qte_disponible
       FROM formule_lignes fl
       JOIN articles_catalogue a ON a.id = fl.article_id
       JOIN v_stock_disponible s ON s.article_id = a.id
      WHERE fl.formule_id = $1
      ORDER BY fl.phase, fl.ordre, fl.id`,
    [formuleId],
  );
}

export interface ResultatMiseAEchelle {
  masse_nette_kg: string;
  masse_brute_kg: string;
  surdosage_pct: string;
  unites_pf: number | null;
  volume_litres: string;
  lignes: {
    article_id: number;
    code_sku: string;
    designation: string;
    phase: string;
    pourcentage_w_w: string;
    masse_theorique_g: string;
    consigne: string | null;
    ordre: number;
    qte_disponible: string;
    suffisant: boolean;
  }[];
  total_masse_g: string;
}

/**
 * Mise a l'echelle dynamique (batch scaling).
 *   masse ingredient (g) = masse_brute (kg) x 1000 x pourcentage / 100
 * La masse brute integre le coefficient de surdosage technique destine a
 * compenser les pertes de fond de cuve et de tuyauterie.
 */
export async function miseAEchelle(
  db: Db,
  formuleId: number,
  options: { masse_nette_kg?: number | string | null; unites_pf?: number | null; surdosage_pct?: number | string },
): Promise<ResultatMiseAEchelle> {
  const formule = await queryOne(db, 'SELECT * FROM formules WHERE id = $1', [formuleId]);
  if (!formule) throw introuvable('Formule', formuleId);
  const lignes = await lignesDeFormule(db, formuleId);
  if (lignes.length === 0) throw new ErreurMetier('FORMULE_VIDE', "La formule ne comporte aucun ingredient.", 422);
  controlerSommePonderale(lignes);

  const densite = d(formule.densite);
  let masseNette: Decimal;
  let unites: number | null = null;

  if (options.unites_pf) {
    const pf = formule.article_pf_id
      ? await queryOne(db, 'SELECT contenance_ml FROM articles_catalogue WHERE id = $1', [formule.article_pf_id])
      : null;
    if (!pf?.contenance_ml) {
      throw new ErreurMetier(
        'CONTENANCE_INCONNUE',
        "Impossible de convertir un nombre d'unites sans produit fini rattache disposant d'une contenance nominale (ml).",
        422,
      );
    }
    unites = options.unites_pf;
    // masse (kg) = unites x contenance (ml) x densite (g/ml) / 1000
    masseNette = d(options.unites_pf).times(pf.contenance_ml).times(densite).dividedBy(1000);
  } else if (options.masse_nette_kg) {
    masseNette = d(options.masse_nette_kg);
  } else {
    throw new ErreurMetier('CIBLE_MANQUANTE', "Indiquer soit une masse nette de vrac (kg), soit un nombre d'unites de produit fini.", 422);
  }
  if (masseNette.lessThanOrEqualTo(0)) {
    throw new ErreurMetier('CIBLE_INVALIDE', 'La masse cible doit etre strictement positive.', 422);
  }

  const surdosage = d(options.surdosage_pct ?? 0);
  const masseBrute = masseNette.times(surdosage.dividedBy(100).plus(1));
  const masseBruteG = masseBrute.times(1000);

  const lignesEchelle = lignes.map((l) => {
    const masse = masseBruteG.times(d(l.pourcentage_w_w)).dividedBy(100);
    return {
      article_id: l.article_id,
      code_sku: l.code_sku,
      designation: l.designation,
      phase: l.phase,
      pourcentage_w_w: d(l.pourcentage_w_w).toFixed(3),
      masse_theorique_g: q3(masse),
      consigne: l.consigne,
      ordre: l.ordre,
      qte_disponible: q3(convertirEnGrammes(l.qte_disponible, l.unite, l.densite)),
      suffisant: convertirEnGrammes(l.qte_disponible, l.unite, l.densite).greaterThanOrEqualTo(masse),
    };
  });

  return {
    masse_nette_kg: q3(masseNette),
    masse_brute_kg: q3(masseBrute),
    surdosage_pct: surdosage.toFixed(3),
    unites_pf: unites,
    volume_litres: q3(masseNette.dividedBy(densite)),
    lignes: lignesEchelle,
    total_masse_g: q3(somme(lignesEchelle.map((l) => l.masse_theorique_g))),
  };
}

/**
 * Convertit une quantite exprimee dans l'unite d'achat de l'article en grammes.
 * Pour une matiere premiere achetee au volume, la masse volumique propre a
 * l'article est utilisee (par defaut 1 g/ml).
 */
export function convertirEnGrammes(quantite: number | string, unite: string, densiteArticle?: number | string | null): Decimal {
  const v = d(quantite);
  const densite = densiteArticle ? d(densiteArticle) : d(1);
  switch (unite) {
    case 'g':  return v;
    case 'kg': return v.times(1000);
    case 'L':  return v.times(1000).times(densite);
    case 'ml': return v.times(densite);
    default:   return v;
  }
}
