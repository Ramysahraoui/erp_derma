import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { AlerteErreur, Champ } from '../composants/Ui';

export function Connexion() {
  const { connexion } = useAuth();
  const naviguer = useNavigate();
  const [email, setEmail] = useState('');
  const [motDePasse, setMotDePasse] = useState('');
  const [erreur, setErreur] = useState<unknown>(null);
  const [enCours, setEnCours] = useState(false);

  const soumettre = async (e: FormEvent) => {
    e.preventDefault();
    setEnCours(true);
    setErreur(null);
    try {
      await connexion(email, motDePasse);
      naviguer('/', { replace: true });
    } catch (err) {
      setErreur(err);
    } finally {
      setEnCours(false);
    }
  };

  return (
    <div className="page-connexion">
      <div className="boite">
        <h1>ERP Dermo-Cosmetique</h1>
        <p className="sous">Gestion integree de la production et du cycle commercial</p>
        <AlerteErreur erreur={erreur} />
        <form onSubmit={soumettre}>
          <Champ libelle="Adresse e-mail" obligatoire>
            <input type="email" value={email} autoComplete="username" required
              onChange={(e) => setEmail(e.target.value)} placeholder="prenom.nom@societe.dz" />
          </Champ>
          <Champ libelle="Mot de passe" obligatoire>
            <input type="password" value={motDePasse} autoComplete="current-password" required
              onChange={(e) => setMotDePasse(e.target.value)} />
          </Champ>
          <button className="bouton primaire bloc" type="submit" disabled={enCours}>
            {enCours ? 'Connexion…' : 'Se connecter'}
          </button>
        </form>
        <p className="comptes-demo">
          Acces reserve au personnel autorise. En cas d'oubli de mot de passe,
          contacter l'administrateur du systeme.
        </p>
      </div>
    </div>
  );
}
