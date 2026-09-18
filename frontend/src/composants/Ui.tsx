import { useEffect, useState, type ReactNode } from 'react';
import { ExceptionApi } from '../api';

// ------------------------------- Etats -------------------------------
export const Chargement = ({ texte = 'Chargement…' }: { texte?: string }) => (
  <div className="chargement">{texte}</div>
);

export const Vide = ({ texte = 'Aucune donnee.' }: { texte?: string }) => <div className="vide">{texte}</div>;

export function Alerte({ type = 'info', titre, children }: { type?: 'erreur' | 'succes' | 'info' | 'attention'; titre?: string; children: ReactNode }) {
  return (
    <div className={`alerte-boite ${type}`} role={type === 'erreur' ? 'alert' : 'status'}>
      <div>
        {titre && <strong>{titre}</strong>}
        {children}
      </div>
    </div>
  );
}

/** Restitution homogene d'une erreur d'API, details metier compris. */
export function AlerteErreur({ erreur }: { erreur: unknown }) {
  if (!erreur) return null;
  const api = erreur instanceof ExceptionApi ? erreur : null;
  const details = api?.details;
  return (
    <Alerte type="erreur" titre={api ? `Operation refusee — ${api.code}` : 'Erreur'}>
      {(erreur as Error).message}
      {Array.isArray(details) && details.length > 0 && (
        <ul>{details.map((d: any, i: number) => <li key={i}>{d.champ ? `${d.champ} : ` : ''}{d.message ?? String(d)}</li>)}</ul>
      )}
      {details?.ingredient_limitant && (
        <ul>
          <li>Ingredient limitant : <strong>{details.ingredient_limitant.code_sku}</strong> — {details.ingredient_limitant.designation}</li>
          <li>Besoin {details.ingredient_limitant.besoin_g} g / disponible {details.ingredient_limitant.disponible_g} g</li>
          <li>Volume maximal fabricable : <strong>{details.masse_max_kg} kg</strong>
            {details.unites_max !== null && details.unites_max !== undefined ? ` (${details.unites_max} unites)` : ''}</li>
        </ul>
      )}
      {details?.somme && <ul><li>Somme saisie : {details.somme} % — ecart de {details.ecart} %</li></ul>}
    </Alerte>
  );
}

// ------------------------------ Badges -------------------------------
const CLASSES: Record<string, string> = {
  CONFORME: 'succes', LIBERE: 'succes', VALIDE: 'succes', SOLDEE: 'succes', CLOTURE: 'succes', ENCAISSE: 'succes',
  VALIDEE: 'succes', DISPONIBLE: 'succes',
  QUARANTAINE: 'alerte', PARTIELLE: 'alerte', BROUILLON: 'alerte', EN_COURS: 'alerte', PESEE: 'alerte',
  FABRICATION: 'alerte', CONDITIONNEMENT: 'alerte', DEPOSE: 'alerte', RECU: 'info', VRAC_LIBERE: 'info',
  REJETE: 'danger', BLOQUE: 'danger', ANNULE: 'danger', NON_PAYEE: 'danger', IMPAYE: 'danger',
  ECHUE_PLUS_60: 'danger', ECHUE_31_60: 'alerte', ECHUE_1_30: 'info', NON_ECHUE: 'succes',
};

export const Badge = ({ valeur, classe }: { valeur: string | null | undefined; classe?: string }) => (
  <span className={`badge ${classe ?? CLASSES[String(valeur)] ?? ''}`}>{String(valeur ?? '—').replaceAll('_', ' ')}</span>
);

// ------------------------------ Modale -------------------------------
export function Modale({ titre, onFermer, children, actions, large }: {
  titre: string; onFermer: () => void; children: ReactNode; actions?: ReactNode; large?: boolean;
}) {
  useEffect(() => {
    const echap = (e: KeyboardEvent) => { if (e.key === 'Escape') onFermer(); };
    document.addEventListener('keydown', echap);
    return () => document.removeEventListener('keydown', echap);
  }, [onFermer]);
  return (
    <div className="modale-fond" onMouseDown={(e) => { if (e.target === e.currentTarget) onFermer(); }}>
      <div className="modale" style={large ? { width: 'min(1080px, 100%)' } : undefined} role="dialog" aria-modal="true" aria-label={titre}>
        <header>
          <h2>{titre}</h2>
          <button className="bouton discret petit" onClick={onFermer} aria-label="Fermer">✕</button>
        </header>
        <div className="corps">{children}</div>
        {actions && <footer>{actions}</footer>}
      </div>
    </div>
  );
}

// ------------------------------ Champs -------------------------------
export function Champ({ libelle, obligatoire, aide, children }: {
  libelle: string; obligatoire?: boolean; aide?: string; children: ReactNode;
}) {
  return (
    <label className="champ">
      <span className={obligatoire ? 'obligatoire' : undefined}>{libelle}</span>
      {children}
      {aide && <span className="aide">{aide}</span>}
    </label>
  );
}

export function Onglets({ onglets, actif, onChange }: {
  onglets: { cle: string; libelle: string }[]; actif: string; onChange: (cle: string) => void;
}) {
  return (
    <div className="onglets" role="tablist">
      {onglets.map((o) => (
        <button key={o.cle} role="tab" aria-selected={o.cle === actif}
          className={o.cle === actif ? 'actif' : undefined} onClick={() => onChange(o.cle)}>
          {o.libelle}
        </button>
      ))}
    </div>
  );
}

export function Indicateur({ libelle, valeur, detail, ton }: {
  libelle: string; valeur: ReactNode; detail?: ReactNode; ton?: 'succes' | 'alerte' | 'danger';
}) {
  return (
    <div className={`indicateur ${ton ?? ''}`}>
      <div className="libelle">{libelle}</div>
      <div className="valeur">{valeur}</div>
      {detail && <div className="detail">{detail}</div>}
    </div>
  );
}

/** Hook de chargement de donnees avec rafraichissement manuel. */
export function useChargement<T>(charger: () => Promise<T>, deps: unknown[] = []): {
  donnees: T | null; erreur: unknown; enCours: boolean; recharger: () => void;
} {
  const [donnees, setDonnees] = useState<T | null>(null);
  const [erreur, setErreur] = useState<unknown>(null);
  const [enCours, setEnCours] = useState(true);
  const [compteur, setCompteur] = useState(0);

  useEffect(() => {
    let annule = false;
    setEnCours(true);
    charger()
      .then((d) => { if (!annule) { setDonnees(d); setErreur(null); } })
      .catch((e) => { if (!annule) setErreur(e); })
      .finally(() => { if (!annule) setEnCours(false); });
    return () => { annule = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, compteur]);

  return { donnees, erreur, enCours, recharger: () => setCompteur((c) => c + 1) };
}
