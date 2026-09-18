import { Decimal } from 'decimal.js';

// Precision large : les arrondis sont explicites, jamais implicites.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -18, toExpPos: 30 });

export type Numerique = string | number | Decimal | null | undefined;

export const d = (v: Numerique): Decimal => {
  if (v === null || v === undefined || v === '') return new Decimal(0);
  return v instanceof Decimal ? v : new Decimal(v);
};

/** Masses et quantites : 3 decimales (gramme au milligramme pres). */
export const q3 = (v: Numerique): string => d(v).toFixed(3);
/** Prix unitaires : 4 decimales. */
export const p4 = (v: Numerique): string => d(v).toFixed(4);
/** Montants de documents : 2 decimales. */
export const m2 = (v: Numerique): string => d(v).toFixed(2);

export const somme = (vals: Numerique[]): Decimal =>
  vals.reduce<Decimal>((acc, v) => acc.plus(d(v)), new Decimal(0));

export const estZero = (v: Numerique): boolean => d(v).isZero();
export const plusPetit = (a: Numerique, b: Numerique): boolean => d(a).lessThan(d(b));

/** Ecart relatif en % entre une valeur reelle et une consigne theorique. */
export const ecartPct = (reel: Numerique, theorique: Numerique): Decimal => {
  const th = d(theorique);
  if (th.isZero()) return new Decimal(0);
  return d(reel).minus(th).dividedBy(th).times(100);
};

export { Decimal };
