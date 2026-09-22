import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth, type Utilisateur } from '../auth';
import { Alerte, AlerteErreur, Champ } from '../composants/Ui';

/**
 * Changement de mot de passe impose : compte cree a l'installation ou mot de
 * passe reinitialise par l'administrateur. Aucun ecran metier n'est accessible
 * tant que l'operation n'est pas faite.
 */
export function ChangementMotDePasse() {
  const { utilisateur, appliquerSession, deconnexion } = useAuth();
  const [ancien, setAncien] = useState('');
  const [nouveau, setNouveau] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [erreur, setErreur] = useState<unknown>(null);
  const [enCours, setEnCours] = useState(false);

  const assezFort = nouveau.length >= 10;
  const identiques = nouveau.length > 0 && nouveau === confirmation;

  const soumettre = async (e: FormEvent) => {
    e.preventDefault();
    setErreur(null);
    setEnCours(true);
    try {
      const reponse = await api.post<{ jeton: string; utilisateur: Utilisateur }>('/auth/mot-de-passe', {
        ancien_mot_de_passe: ancien,
        nouveau_mot_de_passe: nouveau,
      });
      // Le jeton renvoye ne porte plus l'obligation de changement.
      appliquerSession(reponse.jeton, reponse.utilisateur);
    } catch (err) {
      setErreur(err);
    } finally {
      setEnCours(false);
    }
  };

  return (
    <div className="page-connexion">
      <div className="boite">
        <h1>Changement de mot de passe</h1>
        <p className="sous">
          Bonjour {utilisateur?.nom_complet}. Pour des raisons de securite, le mot de passe initial
          doit etre remplace avant tout acces a l'application.
        </p>
        <AlerteErreur erreur={erreur} />
        <Alerte type="info">
          Dix caracteres minimum. Privilegier une phrase de passe memorisable plutot qu'un mot court
          et complexe.
        </Alerte>
        <form onSubmit={soumettre}>
          <Champ libelle="Mot de passe actuel" obligatoire>
            <input type="password" value={ancien} autoComplete="current-password" required
              onChange={(e) => setAncien(e.target.value)} />
          </Champ>
          <Champ libelle="Nouveau mot de passe" obligatoire
            aide={nouveau && !assezFort ? 'Dix caracteres minimum.' : undefined}>
            <input type="password" value={nouveau} autoComplete="new-password" required minLength={10}
              onChange={(e) => setNouveau(e.target.value)} />
          </Champ>
          <Champ libelle="Confirmation" obligatoire
            aide={confirmation && !identiques ? 'Les deux saisies different.' : undefined}>
            <input type="password" value={confirmation} autoComplete="new-password" required
              onChange={(e) => setConfirmation(e.target.value)} />
          </Champ>
          <button className="bouton primaire bloc" type="submit" disabled={enCours || !assezFort || !identiques}>
            {enCours ? 'Enregistrement…' : 'Valider le nouveau mot de passe'}
          </button>
        </form>
        <p className="comptes-demo">
          <button type="button" onClick={deconnexion} style={{ all: 'unset', cursor: 'pointer', color: 'var(--primaire)', fontWeight: 600 }}>
            Se deconnecter
          </button>
        </p>
      </div>
    </div>
  );
}
