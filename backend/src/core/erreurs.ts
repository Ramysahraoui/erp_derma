/** Erreur metier portant un code stable exploitable par l'IHM. */
export class ErreurMetier extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statut = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ErreurMetier';
  }
}

export const introuvable = (quoi: string, id?: unknown) =>
  new ErreurMetier('INTROUVABLE', `${quoi}${id !== undefined ? ` (${id})` : ''} introuvable.`, 404);

export const conflit = (code: string, message: string, details?: unknown) =>
  new ErreurMetier(code, message, 409, details);

export const interdit = (message: string, details?: unknown) =>
  new ErreurMetier('ACCES_INTERDIT', message, 403, details);

/**
 * Traduit les exceptions PostgreSQL (triggers metier, contraintes) en erreurs
 * applicatives lisibles. Les regles non negociables sont portees par la base :
 * ce mapping garantit qu'elles remontent telles quelles a l'utilisateur.
 */
const CODES_METIER = [
  'FORMULE_SOMME_INVALIDE',
  'FORMULE_ARTICLE_INVALIDE',
  'LOT_PF_SANS_VRAC',
  'VRAC_NON_LIBERE',
  'LOT_VRAC_INTERDIT',
  'LOT_NON_CONFORME',
  'STOCK_INSUFFISANT',
  'PESEE_LOT_NON_CONFORME',
  'PESEE_ARTICLE_INCOHERENT',
  'PESEE_LOT_PERIME',
  'PESEES_INCOMPLETES',
  'VRAC_MANQUANT',
  'LOT_PF_OBLIGATOIRE',
  'LOT_VENTE_INVALIDE',
  'LOT_ARTICLE_INCOHERENT',
  'BL_VIDE',
  'AUDIT_TRAIL_SUPPRESSION_INTERDITE',
  'AUDIT_TRAIL_MODIFICATION_INTERDITE',
  'LOT_INTROUVABLE',
] as const;

export function traduireErreurPg(err: unknown): ErreurMetier | null {
  const e = err as { message?: string; code?: string; constraint?: string; detail?: string };
  if (!e || typeof e.message !== 'string') return null;
  for (const code of CODES_METIER) {
    if (e.message.startsWith(`${code}:`)) {
      return new ErreurMetier(code, e.message.slice(code.length + 1).trim(), 422);
    }
  }
  if (e.code === '23505') {
    return new ErreurMetier('DOUBLON', `Valeur deja existante (${e.constraint ?? 'contrainte unique'}).`, 409, e.detail);
  }
  if (e.code === '23503') {
    return new ErreurMetier('REFERENCE_INVALIDE', `Reference inexistante (${e.constraint ?? 'cle etrangere'}).`, 409, e.detail);
  }
  if (e.code === '23514') {
    return new ErreurMetier('CONTRAINTE_VIOLEE', `Contrainte d'integrite violee (${e.constraint ?? 'check'}).`, 422, e.detail);
  }
  if (e.code === '23502') {
    return new ErreurMetier('CHAMP_OBLIGATOIRE', e.message, 422, e.detail);
  }
  return null;
}
