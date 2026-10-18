import { z } from 'zod';

/**
 * Booleen transmis en parametre d'URL (« true » / « false »).
 * `z.coerce.boolean()` ne convient pas : toute chaine non vide, y compris
 * « false », y devient `true`.
 */
export const booleenRequete = () =>
  z.preprocess((v) => {
    if (v === true || v === 'true' || v === '1') return true;
    if (v === false || v === 'false' || v === '0') return false;
    return v;
  }, z.boolean());
