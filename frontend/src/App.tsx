import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { LIBELLES_ROLES, useAuth } from './auth';
import { Connexion } from './pages/Connexion';
import { ChangementMotDePasse } from './pages/ChangementMotDePasse';
import { TableauDeBord } from './pages/TableauDeBord';
import { Articles } from './pages/Articles';
import { Receptions } from './pages/Receptions';
import { Lots } from './pages/Lots';
import { Capacite } from './pages/Capacite';
import { Formules } from './pages/Formules';
import { FormuleEditeur } from './pages/FormuleEditeur';
import { OrdresFabrication } from './pages/OrdresFabrication';
import { OrdreFabricationDetail } from './pages/OrdreFabricationDetail';
import { EcranPesee } from './pages/EcranPesee';
import { Clients } from './pages/Clients';
import { Ventes } from './pages/Ventes';
import { VenteDetail } from './pages/VenteDetail';
import { Recouvrement } from './pages/Recouvrement';
import { Depenses } from './pages/Depenses';
import { Personnel } from './pages/Personnel';
import { Rentabilite } from './pages/Rentabilite';
import { Tracabilite } from './pages/Tracabilite';
import { Administration } from './pages/Administration';

interface Entree { chemin: string; libelle: string; icone: string; permission: string; groupe: string }

const MENU: Entree[] = [
  { groupe: 'Pilotage', chemin: '/', libelle: 'Tableau de bord', icone: '◧', permission: 'stock:lire' },
  { groupe: 'Achats & stocks', chemin: '/articles', libelle: 'Articles', icone: '▤', permission: 'article:lire' },
  { groupe: 'Achats & stocks', chemin: '/receptions', libelle: 'Receptions', icone: '⇩', permission: 'stock:lire' },
  { groupe: 'Achats & stocks', chemin: '/lots', libelle: 'Lots & stock', icone: '▣', permission: 'stock:lire' },
  { groupe: 'Achats & stocks', chemin: '/capacite', libelle: 'Capacite predictive', icone: '◱', permission: 'stock:lire' },
  { groupe: 'R&D & production', chemin: '/formules', libelle: 'Formules', icone: '⚗', permission: 'formule:lire' },
  { groupe: 'R&D & production', chemin: '/production', libelle: 'Ordres de fabrication', icone: '⚙', permission: 'production:lire' },
  { groupe: 'Commercial', chemin: '/clients', libelle: 'Clients', icone: '☺', permission: 'client:lire' },
  { groupe: 'Commercial', chemin: '/ventes', libelle: 'Devis, BL & factures', icone: '▦', permission: 'vente:lire' },
  { groupe: 'Finance', chemin: '/recouvrement', libelle: 'Recouvrement', icone: '₣', permission: 'recouvrement:lire' },
  { groupe: 'Finance', chemin: '/depenses', libelle: 'Depenses', icone: '▽', permission: 'depense:lire' },
  { groupe: 'Finance', chemin: '/personnel', libelle: 'Personnel', icone: '☗', permission: 'rh:lire' },
  { groupe: 'Finance', chemin: '/rentabilite', libelle: 'Rentabilite & CRU', icone: '◭', permission: 'finance:lire' },
  { groupe: 'Qualite', chemin: '/tracabilite', libelle: 'Tracabilite', icone: '⁂', permission: 'tracabilite:lire' },
  { groupe: 'Administration', chemin: '/administration', libelle: 'Administration', icone: '⚘', permission: '*' },
];

function Navigation() {
  const { peut } = useAuth();
  const visibles = MENU.filter((e) => peut(e.permission));
  const groupes = [...new Set(visibles.map((e) => e.groupe))];
  return (
    <aside className="navigation">
      <div className="marque">
        <strong>ERP Dermo-Cosmetique</strong>
        <span>Production &amp; gestion integree</span>
      </div>
      <nav>
        {groupes.map((groupe) => (
          <div key={groupe}>
            <div className="groupe">{groupe}</div>
            {visibles.filter((e) => e.groupe === groupe).map((e) => (
              <NavLink key={e.chemin} to={e.chemin} end={e.chemin === '/'}
                className={({ isActive }) => (isActive ? 'actif' : undefined)}>
                <span className="icone" aria-hidden>{e.icone}</span>
                {e.libelle}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}

function Cadre({ children }: { children: React.ReactNode }) {
  const { utilisateur, deconnexion } = useAuth();
  const emplacement = useLocation();
  const entree = MENU.find((e) => (e.chemin === '/' ? emplacement.pathname === '/' : emplacement.pathname.startsWith(e.chemin)));
  const initiales = (utilisateur?.nom_complet ?? '')
    .split(' ').filter(Boolean).slice(0, 2).map((m) => m[0]?.toUpperCase()).join('');

  return (
    <div className="application">
      <Navigation />
      <div className="principal">
        <header className="barre-haute">
          <div className="titre">
            <h1>{entree?.libelle ?? 'ERP Dermo-Cosmetique'}</h1>
            <small>{entree?.groupe ?? ''}</small>
          </div>
          <div className="profil">
            <div className="infos">
              <strong>{utilisateur?.nom_complet}</strong>
              <span>{utilisateur ? LIBELLES_ROLES[utilisateur.role] : ''}</span>
            </div>
            <div className="pastille" aria-hidden>{initiales}</div>
            <button className="bouton petit" onClick={deconnexion}>Deconnexion</button>
          </div>
        </header>
        <main className="contenu">{children}</main>
      </div>
    </div>
  );
}

function Protege({ children }: { children: React.ReactNode }) {
  const { utilisateur } = useAuth();
  const emplacement = useLocation();
  if (!utilisateur) return <Navigate to="/connexion" state={{ de: emplacement.pathname }} replace />;
  // Mot de passe initial ou reinitialise : aucun ecran metier avant le changement.
  if (utilisateur.doit_changer_mot_de_passe) return <ChangementMotDePasse />;
  return <>{children}</>;
}

export function Application() {
  const { utilisateur } = useAuth();
  return (
    <Routes>
      <Route path="/connexion" element={utilisateur ? <Navigate to="/" replace /> : <Connexion />} />
      {/* L'ecran de pesee occupe la totalite de la tablette d'atelier. */}
      <Route path="/production/:id/pesee" element={<Protege><EcranPesee /></Protege>} />
      <Route
        path="*"
        element={
          <Protege>
            <Cadre>
              <Routes>
                <Route path="/" element={<TableauDeBord />} />
                <Route path="/articles" element={<Articles />} />
                <Route path="/receptions" element={<Receptions />} />
                <Route path="/lots" element={<Lots />} />
                <Route path="/capacite" element={<Capacite />} />
                <Route path="/formules" element={<Formules />} />
                <Route path="/formules/:id" element={<FormuleEditeur />} />
                <Route path="/production" element={<OrdresFabrication />} />
                <Route path="/production/:id" element={<OrdreFabricationDetail />} />
                <Route path="/clients" element={<Clients />} />
                <Route path="/ventes" element={<Ventes />} />
                <Route path="/ventes/:id" element={<VenteDetail />} />
                <Route path="/recouvrement" element={<Recouvrement />} />
                <Route path="/depenses" element={<Depenses />} />
                <Route path="/personnel" element={<Personnel />} />
                <Route path="/rentabilite" element={<Rentabilite />} />
                <Route path="/tracabilite" element={<Tracabilite />} />
                <Route path="/administration" element={<Administration />} />
                <Route path="*" element={<div className="vide">Page introuvable.</div>} />
              </Routes>
            </Cadre>
          </Protege>
        }
      />
    </Routes>
  );
}
