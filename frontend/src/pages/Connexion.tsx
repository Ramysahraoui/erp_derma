import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { AlerteErreur, Champ } from '../composants/Ui';

const COMPTES_DEMO = [
  ['direction@derma.dz', 'Direction / administrateur'],
  ['qualite@derma.dz', 'Responsable R&D et qualite'],
  ['atelier@derma.dz', 'Operateur de production'],
  ['commercial@derma.dz', 'Service commercial'],
  ['comptabilite@derma.dz', 'Comptabilite et recouvrement'],
];

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
        <div className="comptes-demo">
          <strong>Comptes de demonstration</strong> (mot de passe&nbsp;: Derma2026!)
          <ul style={{ paddingLeft: 16, margin: '8px 0 0' }}>
            {COMPTES_DEMO.map(([adresse, role]) => (
              <li key={adresse}>
                <button type="button" onClick={() => { setEmail(adresse); setMotDePasse('Derma2026!'); }}>{adresse}</button>
                {' — '}{role}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
