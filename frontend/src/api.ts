/** Client HTTP de l'API metier : jeton JWT, erreurs typees, telechargements. */

export interface ErreurApi {
  erreur: string;
  message: string;
  details?: any;
  statut: number;
}

export class ExceptionApi extends Error {
  constructor(public readonly donnees: ErreurApi) {
    super(donnees.message);
    this.name = 'ExceptionApi';
  }
  get code(): string { return this.donnees.erreur; }
  get details(): any { return this.donnees.details; }
  get statut(): number { return this.donnees.statut; }
}

const CLE_JETON = 'erp-derma-jeton';
const CLE_UTILISATEUR = 'erp-derma-utilisateur';

export const jetonCourant = (): string | null => localStorage.getItem(CLE_JETON);

export function enregistrerSession(jeton: string, utilisateur: unknown): void {
  localStorage.setItem(CLE_JETON, jeton);
  localStorage.setItem(CLE_UTILISATEUR, JSON.stringify(utilisateur));
}

export function effacerSession(): void {
  localStorage.removeItem(CLE_JETON);
  localStorage.removeItem(CLE_UTILISATEUR);
}

export function utilisateurEnregistre<T = any>(): T | null {
  const brut = localStorage.getItem(CLE_UTILISATEUR);
  try { return brut ? (JSON.parse(brut) as T) : null; } catch { return null; }
}

async function requete<T>(methode: string, url: string, corps?: unknown): Promise<T> {
  const jeton = jetonCourant();
  const reponse = await fetch(url.startsWith('/api') ? url : `/api${url}`, {
    method: methode,
    headers: {
      ...(corps === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}),
    },
    ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
  });

  if (reponse.status === 204) return undefined as T;
  const texte = await reponse.text();
  let donnees: any;
  try { donnees = texte ? JSON.parse(texte) : null; } catch { donnees = texte; }

  if (!reponse.ok) {
    // Seul un probleme de session (jeton absent, invalide ou expire) justifie une
    // deconnexion. Un refus portant sur une valeur saisie dans un formulaire doit
    // remonter a l'ecran appelant, qui l'affiche : sinon l'utilisateur est
    // redirige sans message et croit son action reussie.
    const problemeDeSession = reponse.status === 401
      && (donnees?.erreur === undefined || donnees?.erreur === 'NON_AUTHENTIFIE');
    if (problemeDeSession) {
      effacerSession();
      if (!location.pathname.startsWith('/connexion')) location.href = '/connexion';
    }
    throw new ExceptionApi({
      erreur: donnees?.erreur ?? 'ERREUR',
      message: donnees?.message ?? `Erreur HTTP ${reponse.status}`,
      details: donnees?.details,
      statut: reponse.status,
    });
  }
  return donnees as T;
}

export const api = {
  get: <T = any>(url: string) => requete<T>('GET', url),
  post: <T = any>(url: string, corps?: unknown) => requete<T>('POST', url, corps ?? {}),
  put: <T = any>(url: string, corps?: unknown) => requete<T>('PUT', url, corps ?? {}),
  patch: <T = any>(url: string, corps?: unknown) => requete<T>('PATCH', url, corps ?? {}),

  /** Televerse un certificat d'analyse ou une piece jointe. */
  async televerser(fichier: File): Promise<{ fichier: string; url: string }> {
    const formulaire = new FormData();
    formulaire.append('fichier', fichier);
    const reponse = await fetch('/api/fichiers', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jetonCourant() ?? ''}` },
      body: formulaire,
    });
    const donnees = await reponse.json();
    if (!reponse.ok) throw new ExceptionApi({ ...donnees, statut: reponse.status });
    return donnees;
  },

  /** Ouvre un document imprimable (PDF) dans un nouvel onglet. */
  async ouvrirDocument(url: string): Promise<void> {
    const reponse = await fetch(url.startsWith('/api') ? url : `/api${url}`, {
      headers: { Authorization: `Bearer ${jetonCourant() ?? ''}` },
    });
    if (!reponse.ok) {
      const donnees = await reponse.json().catch(() => ({}));
      throw new ExceptionApi({
        erreur: donnees?.erreur ?? 'ERREUR', message: donnees?.message ?? 'Document indisponible.', statut: reponse.status,
      });
    }
    const blob = await reponse.blob();
    const lien = URL.createObjectURL(blob);
    window.open(lien, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(lien), 60_000);
  },
};

// ------------------------------- Formatage ---------------------------------
export const DEVISE = 'DZD';

export const fmtMontant = (v: unknown): string =>
  `${Number(v ?? 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${DEVISE}`;

export const fmtNombre = (v: unknown, decimales = 3): string =>
  Number(v ?? 0).toLocaleString('fr-FR', { minimumFractionDigits: decimales, maximumFractionDigits: decimales });

export const fmtEntier = (v: unknown): string => Number(v ?? 0).toLocaleString('fr-FR');

export const fmtDate = (v: unknown): string => {
  if (!v) return '—';
  const date = new Date(String(v));
  return Number.isNaN(date.getTime()) ? String(v) : date.toLocaleDateString('fr-FR');
};

export const fmtDateHeure = (v: unknown): string => {
  if (!v) return '—';
  const date = new Date(String(v));
  return Number.isNaN(date.getTime()) ? String(v) : date.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
};

export const fmtPct = (v: unknown, decimales = 2): string =>
  `${Number(v ?? 0).toLocaleString('fr-FR', { minimumFractionDigits: decimales, maximumFractionDigits: decimales })} %`;

export const aujourdhui = (): string => new Date().toISOString().slice(0, 10);
