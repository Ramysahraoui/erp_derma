import { ErreurMetier } from './erreurs.js';

export const ROLES = [
  'OPERATEUR_PRODUCTION',
  'RESPONSABLE_RD_QUALITE',
  'COMMERCIAL',
  'COMPTABILITE',
  'ADMIN',
] as const;
export type Role = (typeof ROLES)[number];

/**
 * Matrice des privileges (CDCF 4.3). Chaque permission est atomique : un role
 * ne voit que ce que son poste exige (l'operateur atelier n'accede ni aux
 * couts, ni aux marges, ni aux clients).
 */
export const PERMISSIONS = {
  OPERATEUR_PRODUCTION: [
    'production:lire',
    'production:peser',
    'production:cuve',
    'production:conditionner',
    'stock:lire',
    'formule:lire',
  ],
  RESPONSABLE_RD_QUALITE: [
    'formule:lire',
    'formule:ecrire',
    'production:lire',
    'production:creer',
    'production:peser',
    'production:cuve',
    'production:conditionner',
    'production:cloturer',
    'stock:lire',
    'stock:receptionner',
    'stock:liberer',
    'stock:ajuster',
    'achat:lire',
    'achat:ecrire',
    'article:lire',
    'article:ecrire',
    'tracabilite:lire',
  ],
  COMMERCIAL: [
    'article:lire',
    'stock:lire',
    'client:lire',
    'client:ecrire',
    'vente:lire',
    'vente:ecrire',
    'tracabilite:lire',
  ],
  COMPTABILITE: [
    'vente:lire',
    'client:lire',
    'encaissement:lire',
    'encaissement:ecrire',
    'recouvrement:lire',
    'depense:lire',
    'depense:ecrire',
    'rh:lire',
    'finance:lire',
  ],
  ADMIN: ['*'],
} as const satisfies Record<Role, readonly string[]>;

export function aLaPermission(role: Role, permission: string): boolean {
  const accordees = PERMISSIONS[role] as readonly string[];
  return accordees.includes('*') || accordees.includes(permission);
}

export function exigerPermission(role: Role, permission: string): void {
  if (!aLaPermission(role, permission)) {
    throw new ErreurMetier(
      'ACCES_INTERDIT',
      `Le role ${role} ne dispose pas du privilege « ${permission} ».`,
      403,
    );
  }
}

/** Roles autorises a lever un blocage commercial (plafond de credit). */
export const ROLES_SUPERVISEUR: Role[] = ['ADMIN'];
