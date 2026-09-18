import type { Db } from '../db/pool.js';

export type PrefixeMetier =
  | 'LOT-MP' | 'LOT-AC' | 'LOT-PF' | 'VRAC' | 'OF' | 'REC'
  | 'DEV' | 'BC' | 'BL' | 'FAC' | 'ENC' | 'DEP' | 'CA';

/**
 * Numerotation metier unique et sequentielle par annee.
 * Format : PREFIXE-AAAA-XXXXX (ex : LOT-MP-2026-00042).
 */
export async function genererNumero(db: Db, prefixe: PrefixeMetier, annee = new Date().getFullYear()): Promise<string> {
  const { rows } = await db.query<{ numero: string }>('SELECT prochain_numero($1, $2) AS numero', [prefixe, annee]);
  return rows[0].numero;
}

export const prefixeLotParType = (type: 'MP' | 'AC' | 'PF'): PrefixeMetier =>
  type === 'MP' ? 'LOT-MP' : type === 'AC' ? 'LOT-AC' : 'LOT-PF';
