import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { api, effacerSession, enregistrerSession, utilisateurEnregistre } from './api';

export type Role = 'OPERATEUR_PRODUCTION' | 'RESPONSABLE_RD_QUALITE' | 'COMMERCIAL' | 'COMPTABILITE' | 'ADMIN';

export interface Utilisateur {
  id: number;
  email: string;
  nom_complet: string;
  role: Role;
  doit_changer_mot_de_passe?: boolean;
}

/** Matrice RBAC miroir de celle du serveur : pilote l'affichage des menus. */
const PERMISSIONS: Record<Role, string[]> = {
  OPERATEUR_PRODUCTION: ['production:lire', 'production:peser', 'production:cuve', 'production:conditionner', 'stock:lire', 'formule:lire'],
  RESPONSABLE_RD_QUALITE: [
    'formule:lire', 'formule:ecrire', 'production:lire', 'production:creer', 'production:peser', 'production:cuve',
    'production:conditionner', 'production:cloturer', 'stock:lire', 'stock:receptionner', 'stock:liberer',
    'stock:ajuster', 'achat:lire', 'achat:ecrire', 'article:lire', 'article:ecrire', 'tracabilite:lire',
  ],
  COMMERCIAL: ['article:lire', 'stock:lire', 'client:lire', 'client:ecrire', 'vente:lire', 'vente:ecrire', 'tracabilite:lire'],
  COMPTABILITE: ['vente:lire', 'client:lire', 'encaissement:lire', 'encaissement:ecrire', 'recouvrement:lire',
    'depense:lire', 'depense:ecrire', 'rh:lire', 'finance:lire'],
  ADMIN: ['*'],
};

export const LIBELLES_ROLES: Record<Role, string> = {
  OPERATEUR_PRODUCTION: 'Operateur production',
  RESPONSABLE_RD_QUALITE: 'Responsable R&D / Qualite',
  COMMERCIAL: 'Commercial / Facturation',
  COMPTABILITE: 'Comptabilite / Recouvrement',
  ADMIN: 'Administrateur / Direction',
};

interface ContexteAuth {
  utilisateur: Utilisateur | null;
  connexion: (email: string, motDePasse: string) => Promise<void>;
  deconnexion: () => void;
  rafraichirProfil: () => Promise<void>;
  appliquerSession: (jeton: string, utilisateur: Utilisateur) => void;
  peut: (permission: string) => boolean;
}

const Contexte = createContext<ContexteAuth | null>(null);

export function FournisseurAuth({ children }: { children: ReactNode }) {
  const [utilisateur, setUtilisateur] = useState<Utilisateur | null>(() => utilisateurEnregistre<Utilisateur>());

  const connexion = useCallback(async (email: string, mot_de_passe: string) => {
    const reponse = await api.post<{ jeton: string; utilisateur: Utilisateur }>('/auth/connexion', { email, mot_de_passe });
    enregistrerSession(reponse.jeton, reponse.utilisateur);
    setUtilisateur(reponse.utilisateur);
  }, []);

  /** Applique une session renouvelee (nouveau jeton apres changement de mot de passe). */
  const appliquerSession = useCallback((jeton: string, profil: Utilisateur) => {
    enregistrerSession(jeton, profil);
    setUtilisateur(profil);
  }, []);

  /** Recharge le profil serveur. */
  const rafraichirProfil = useCallback(async () => {
    const reponse = await api.get<{ utilisateur: Utilisateur }>('/auth/moi');
    setUtilisateur(reponse.utilisateur);
    const jeton = localStorage.getItem('erp-derma-jeton');
    if (jeton) enregistrerSession(jeton, reponse.utilisateur);
  }, []);

  const deconnexion = useCallback(() => {
    effacerSession();
    setUtilisateur(null);
  }, []);

  const peut = useCallback(
    (permission: string) => {
      if (!utilisateur) return false;
      const accordees = PERMISSIONS[utilisateur.role] ?? [];
      return accordees.includes('*') || accordees.includes(permission);
    },
    [utilisateur],
  );

  const valeur = useMemo(
    () => ({ utilisateur, connexion, deconnexion, rafraichirProfil, appliquerSession, peut }),
    [utilisateur, connexion, deconnexion, rafraichirProfil, appliquerSession, peut],
  );
  return <Contexte.Provider value={valeur}>{children}</Contexte.Provider>;
}

export function useAuth(): ContexteAuth {
  const contexte = useContext(Contexte);
  if (!contexte) throw new Error("useAuth doit etre utilise a l'interieur de FournisseurAuth");
  return contexte;
}
