import { useState, type ReactNode } from 'react';
import { api } from '../api';
import { Alerte, AlerteErreur, Badge, Indicateur, Modale } from './Ui';

interface LigneApercu { numero: number; valeurs: Record<string, string | null>; erreurs: string[] }
interface Apercu {
  lignes: LigneApercu[];
  colonnes_inconnues: string[];
  colonnes_manquantes: string[];
  resume: { total: number; valides: number; rejetees: number };
}
interface CompteRendu {
  total: number;
  importees: number;
  rejetees: number;
  rejets: { ligne: number; code: string | null; motifs: string[] }[];
  [cle: string]: unknown;
}

/**
 * Import Excel en trois temps : modele, apercu controle, compte rendu.
 * Le fichier est re-analyse par le serveur au moment de l'import : l'apercu
 * n'est qu'une information, jamais la source des donnees enregistrees.
 */
export function ImportExcel({
  titre, base, nomModele, colonnes, champs, champsSaisie, explication, onFermer, onTermine,
}: {
  titre: string;
  base: string;                       // ex. /imports/articles
  nomModele: string;
  colonnes: { cle: string; libelle: string }[];
  champs?: Record<string, string>;    // champs d'en-tete envoyes avec le fichier
  champsSaisie?: ReactNode;           // formulaire d'en-tete (fournisseur, date...)
  explication: ReactNode;
  onFermer: () => void;
  onTermine: (compteRendu: CompteRendu) => void;
}) {
  const [fichier, setFichier] = useState<File | null>(null);
  const [apercu, setApercu] = useState<Apercu | null>(null);
  const [compteRendu, setCompteRendu] = useState<CompteRendu | null>(null);
  const [erreur, setErreur] = useState<unknown>(null);
  const [enCours, setEnCours] = useState(false);
  const [filtre, setFiltre] = useState<'toutes' | 'rejetees'>('toutes');

  const choisir = async (f: File | undefined) => {
    setErreur(null); setApercu(null); setCompteRendu(null);
    if (!f) return;
    setFichier(f);
    setEnCours(true);
    try { setApercu(await api.envoyerFichier<Apercu>(`${base}/apercu`, f)); }
    catch (e) { setErreur(e); }
    finally { setEnCours(false); }
  };

  const importer = async () => {
    if (!fichier) return;
    setErreur(null); setEnCours(true);
    try {
      const cr = await api.envoyerFichier<CompteRendu>(base, fichier, champs ?? {});
      setCompteRendu(cr);
      onTermine(cr);
    } catch (e) { setErreur(e); }
    finally { setEnCours(false); }
  };

  const lignes = (apercu?.lignes ?? []).filter((l) => filtre === 'toutes' || l.erreurs.length);

  return (
    <Modale large titre={titre} onFermer={onFermer}
      actions={compteRendu
        ? <button className="bouton primaire" onClick={onFermer}>Fermer</button>
        : <>
            <button className="bouton" onClick={onFermer}>Annuler</button>
            <button className="bouton primaire" onClick={importer}
              disabled={!apercu || enCours || apercu.resume.valides === 0 || apercu.colonnes_manquantes.length > 0}>
              {enCours ? 'Traitement…' : `Importer ${apercu?.resume.valides ?? 0} ligne(s) valide(s)`}
            </button>
          </>}>
      <AlerteErreur erreur={erreur} />

      {compteRendu ? (
        <>
          <Alerte type={compteRendu.rejetees ? 'attention' : 'succes'} titre="Compte rendu d'import">
            {compteRendu.importees} ligne(s) importee(s), {compteRendu.rejetees} rejetee(s) sur {compteRendu.total}.
          </Alerte>
          {compteRendu.rejets.length > 0 && (
            <div className="tableau-conteneur">
              <table className="tableau">
                <thead><tr><th className="num">Ligne</th><th>Code</th><th>Motif du rejet</th></tr></thead>
                <tbody>
                  {compteRendu.rejets.map((r) => (
                    <tr key={r.ligne} className="limitant">
                      <td className="num">{r.ligne}</td>
                      <td>{r.code ?? '—'}</td>
                      <td>{r.motifs.map((m, i) => <div key={i}>{m}</div>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <>
          <Alerte type="info">{explication}</Alerte>
          <div className="actions" style={{ marginBottom: 14 }}>
            <button className="bouton" onClick={() => api.telecharger(`${base}/modele`, nomModele).catch(setErreur)}>
              Telecharger le modele Excel
            </button>
            <label className="bouton primaire" style={{ cursor: 'pointer' }}>
              {fichier ? `Fichier : ${fichier.name}` : 'Choisir le fichier rempli (.xlsx)'}
              <input type="file" accept=".xlsx" style={{ display: 'none' }}
                onChange={(e) => { choisir(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          </div>
          {champsSaisie}

          {enCours && !apercu && <div className="chargement">Analyse du fichier…</div>}

          {apercu && (
            <>
              {apercu.colonnes_manquantes.length > 0 && (
                <Alerte type="erreur" titre="Colonnes obligatoires absentes">
                  {apercu.colonnes_manquantes.join(', ')} — repartir du modele telecharge.
                </Alerte>
              )}
              {apercu.colonnes_inconnues.length > 0 && (
                <Alerte type="attention" titre="Colonnes ignorees">{apercu.colonnes_inconnues.join(', ')}</Alerte>
              )}
              <div className="grille trois" style={{ margin: '12px 0' }}>
                <Indicateur libelle="Lignes lues" valeur={apercu.resume.total} />
                <Indicateur libelle="Valides" valeur={apercu.resume.valides} ton="succes" />
                <Indicateur libelle="Rejetees" valeur={apercu.resume.rejetees} ton={apercu.resume.rejetees ? 'danger' : undefined} />
              </div>
              <div className="actions" style={{ marginBottom: 8 }}>
                <button className={`bouton petit ${filtre === 'toutes' ? 'primaire' : ''}`} onClick={() => setFiltre('toutes')}>Toutes les lignes</button>
                <button className={`bouton petit ${filtre === 'rejetees' ? 'primaire' : ''}`} onClick={() => setFiltre('rejetees')}>Lignes rejetees</button>
              </div>
              <div className="tableau-conteneur" style={{ maxHeight: 380, overflowY: 'auto' }}>
                <table className="tableau">
                  <thead><tr>
                    <th className="num">Ligne</th><th>Controle</th>
                    {colonnes.map((c) => <th key={c.cle}>{c.libelle}</th>)}
                  </tr></thead>
                  <tbody>
                    {lignes.map((l) => (
                      <tr key={l.numero} className={l.erreurs.length ? 'limitant' : undefined}>
                        <td className="num">{l.numero}</td>
                        <td style={{ minWidth: 220 }}>
                          {l.erreurs.length
                            ? l.erreurs.map((m, i) => <div key={i} className="secondaire" style={{ color: 'var(--danger)' }}>{m}</div>)
                            : <Badge valeur="VALIDE" classe="succes" />}
                        </td>
                        {colonnes.map((c) => <td key={c.cle}>{l.valeurs[c.cle] ?? <span className="secondaire">—</span>}</td>)}
                      </tr>
                    ))}
                    {!lignes.length && <tr><td colSpan={colonnes.length + 2} className="vide">Aucune ligne.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </Modale>
  );
}
