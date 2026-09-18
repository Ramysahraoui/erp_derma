import { queryOne, type Db } from '../db/pool.js';
import { d, Decimal } from './nombres.js';

/** Parametres d'exploitation modifiables par la direction. */
export const PARAMETRES_DEFAUT: Record<string, { valeur: string; libelle: string }> = {
  tolerance_pesee_pct:            { valeur: '0.500',  libelle: 'Ecart de pesee tolere (%)' },
  taux_horaire_mo:                { valeur: '850',    libelle: "Taux horaire moyen operateur de production (devise/h)" },
  taux_charges_indirectes_horaire:{ valeur: '1200',   libelle: 'Taux horaire de charges indirectes imputees (devise/h)' },
  taux_frais_generaux_pct:        { valeur: '0',      libelle: 'Frais generaux additionnels (% des couts directs)' },
  tva_defaut_pct:                 { valeur: '19',     libelle: 'Taux de TVA par defaut (%)' },
  devise:                         { valeur: 'DZD',    libelle: 'Devise de tenue des comptes' },
  duree_quarantaine_jours:        { valeur: '7',      libelle: 'Duree indicative de quarantaine des receptions (jours)' },
};

export async function lireParametre(db: Db, cle: string): Promise<string> {
  const row = await queryOne<{ valeur: string }>(db, 'SELECT valeur FROM parametres WHERE cle = $1', [cle]);
  return row?.valeur ?? PARAMETRES_DEFAUT[cle]?.valeur ?? '0';
}

export async function lireParametreNum(db: Db, cle: string): Promise<Decimal> {
  return d(await lireParametre(db, cle));
}
