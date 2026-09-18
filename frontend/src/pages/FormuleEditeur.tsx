import { Fragment, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, fmtDate, fmtNombre } from '../api';
import { useAuth } from '../auth';
import { Alerte, AlerteErreur, Badge, Champ, Chargement, Indicateur, Onglets, useChargement, Vide } from '../composants/Ui';

const PHASES = [
  { cle: 'A', libelle: 'Phase A — aqueuse / chauffe' },
  { cle: 'B', libelle: 'Phase B — huileuse / chauffe' },
  { cle: 'C', libelle: 'Phase C — emulsion / cisaillement' },
  { cle: 'D', libelle: 'Phase D — refroidissement / actifs thermosensibles' },
  { cle: 'E', libelle: 'Phase E — ajustement pH / viscosite' },
];

interface Ligne { article_id: string; phase: string; pourcentage_w_w: string; consigne: string }

export function FormuleEditeur() {
  const { id } = useParams();
  const naviguer = useNavigate();
  const { peut } = useAuth();
  const formule = useChargement(() => api.get(`/formules/${id}`), [id]);
  const matieres = useChargement(() => api.get('/articles?type=MP'));
  const [lignes, setLignes] = useState<Ligne[] | null>(null);
  const [erreur, setErreur] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [onglet, setOnglet] = useState('composition');

  useEffect(() => {
    if (formule.donnees && lignes === null) {
      setLignes(formule.donnees.lignes.map((l: any) => ({
        article_id: String(l.article_id), phase: l.phase,
        pourcentage_w_w: Number(l.pourcentage_w_w).toFixed(3), consigne: l.consigne ?? '',
      })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formule.donnees]);

  if ((formule.enCours && !formule.donnees) || lignes === null) return <Chargement />;
  if (formule.erreur) return <AlerteErreur erreur={formule.erreur} />;
  const f = formule.donnees!;
  const modifiable = peut('formule:ecrire') && f.statut === 'BROUILLON';

  const somme = lignes.reduce((total, l) => total + (Number(l.pourcentage_w_w) || 0), 0);
  const sommeArrondie = Number(somme.toFixed(3));
  const conforme = sommeArrondie === 100;
  const ecart = Number((sommeArrondie - 100).toFixed(3));

  const majLigne = (i: number, champ: keyof Ligne, valeur: string) =>
    setLignes((ls) => ls!.map((l, j) => (j === i ? { ...l, [champ]: valeur } : l)));

  const enregistrer = async () => {
    setErreur(null); setMessage(null);
    try {
      await api.put(`/formules/${id}/lignes`, lignes.map((l, i) => ({
        article_id: Number(l.article_id), phase: l.phase,
        pourcentage_w_w: Number(l.pourcentage_w_w), consigne: l.consigne || null, ordre: i,
      })));
      setMessage('Composition enregistree.');
      formule.recharger();
    } catch (e) { setErreur(e); }
  };

  const valider = async () => {
    setErreur(null); setMessage(null);
    try {
      await api.post(`/formules/${id}/valider`);
      setMessage('Formule validee : elle peut desormais etre lancee en production.');
      formule.recharger();
    } catch (e) { setErreur(e); }
  };

  const nouvelleVersion = async () => {
    setErreur(null);
    try {
      const version = await api.post(`/formules/${id}/nouvelle-version`);
      setLignes(null);
      naviguer(`/formules/${version.id}`);
    } catch (e) { setErreur(e); }
  };

  return (
    <>
      <section className="carte">
        <header>
          <div>
            <h2>{f.code_formule} — {f.nom_produit} <Badge valeur={f.statut} /></h2>
            <div className="secondaire">
              Version {f.version} · densite {fmtNombre(f.densite, 4)} · creee le {fmtDate(f.cree_le)} par {f.auteur ?? '—'}
              {f.pf_code_sku ? ` · produit fini ${f.pf_code_sku}` : ''}
            </div>
          </div>
          <div className="actions">
            {modifiable && <button className="bouton primaire" onClick={enregistrer} disabled={!conforme}>Enregistrer la composition</button>}
            {peut('formule:ecrire') && f.statut === 'BROUILLON' && (
              <button className="bouton" onClick={valider} disabled={!conforme || lignes.length === 0}>Valider la formule</button>
            )}
            {peut('formule:ecrire') && f.statut !== 'BROUILLON' && (
              <button className="bouton" onClick={nouvelleVersion}>Creer une nouvelle version</button>
            )}
          </div>
        </header>
        <div className="corps">
          <AlerteErreur erreur={erreur} />
          {message && <Alerte type="succes">{message}</Alerte>}
          <div className="grille quatre">
            <Indicateur libelle="Somme ponderale (w/w)" valeur={`${fmtNombre(sommeArrondie)} %`}
              detail={conforme ? 'Conforme : exactement 100,000 %' : `Ecart de ${fmtNombre(ecart)} % — enregistrement bloque`}
              ton={conforme ? 'succes' : 'danger'} />
            <Indicateur libelle="Ingredients" valeur={lignes.length} />
            <Indicateur libelle="Intervalle pH" valeur={f.ph_min != null ? `${f.ph_min} – ${f.ph_max}` : '—'} />
            <Indicateur libelle="Viscosite cible" valeur={f.viscosite_min != null ? `${fmtNombre(f.viscosite_min, 0)} – ${fmtNombre(f.viscosite_max, 0)}` : '—'}
              detail="mPa·s" />
          </div>
          {!conforme && (
            <div style={{ marginTop: 14 }}>
              <Alerte type="erreur" titre="Integrite de la formule">
                Une formule cosmetique est exprimee en pourcentage ponderal strict : la somme doit valoir
                exactement 100,000 %. L'enregistrement est refuse par l'interface comme par la base de donnees.
              </Alerte>
            </div>
          )}
        </div>
      </section>

      <Onglets actif={onglet} onChange={setOnglet} onglets={[
        { cle: 'composition', libelle: 'Composition matricielle' },
        { cle: 'echelle', libelle: "Mise a l'echelle (batch scaling)" },
        { cle: 'versions', libelle: 'Historique des versions' },
      ]} />

      {onglet === 'composition' && (
        <section className="carte">
          <div className="corps sans-marge tableau-conteneur">
            <table className="tableau">
              <thead><tr>
                <th style={{ width: 90 }}>Phase</th><th>Matiere premiere</th>
                <th className="num" style={{ width: 150 }}>Pourcentage w/w</th>
                <th>Consigne operatoire</th><th className="num">Stock</th>{modifiable && <th />}
              </tr></thead>
              <tbody>
                {PHASES.map((phase) => {
                  const lignesPhase = lignes.map((l, i) => ({ l, i })).filter(({ l }) => l.phase === phase.cle);
                  if (!lignesPhase.length) return null;
                  const sommePhase = lignesPhase.reduce((t, { l }) => t + Number(l.pourcentage_w_w || 0), 0);
                  return (
                    <Fragment key={phase.cle}>
                      <tr style={{ background: 'var(--primaire-clair)' }}>
                        <td colSpan={modifiable ? 6 : 5}>
                          <strong>{phase.libelle}</strong>
                          <span className="secondaire"> — {fmtNombre(sommePhase)} %</span>
                        </td>
                      </tr>
                      {lignesPhase.map(({ l, i }) => {
                        const matiere = (matieres.donnees ?? []).find((m: any) => String(m.id) === l.article_id);
                        return (
                          <tr key={`${phase.cle}-${i}`}>
                            <td>{modifiable ? (
                              <select value={l.phase} onChange={(e) => majLigne(i, 'phase', e.target.value)}>
                                {PHASES.map((p) => <option key={p.cle} value={p.cle}>{p.cle}</option>)}
                              </select>
                            ) : l.phase}</td>
                            <td>
                              {modifiable ? (
                                <select value={l.article_id} onChange={(e) => majLigne(i, 'article_id', e.target.value)}>
                                  {(matieres.donnees ?? []).map((m: any) => (
                                    <option key={m.id} value={m.id}>{m.code_sku} — {m.designation}</option>
                                  ))}
                                </select>
                              ) : (<>
                                <strong>{matiere?.code_sku}</strong>
                                <div className="secondaire">{matiere?.designation} {matiere?.nom_inci ? `· ${matiere.nom_inci}` : ''}</div>
                              </>)}
                            </td>
                            <td className="num">
                              {modifiable ? (
                                <input type="number" step="0.001" min="0.001" max="100" value={l.pourcentage_w_w}
                                  onChange={(e) => majLigne(i, 'pourcentage_w_w', e.target.value)} style={{ textAlign: 'right' }} />
                              ) : `${fmtNombre(l.pourcentage_w_w)} %`}
                            </td>
                            <td>
                              {modifiable ? (
                                <input value={l.consigne} onChange={(e) => majLigne(i, 'consigne', e.target.value)}
                                  placeholder="Agitation defloculeuse 1500 RPM a 75 °C" />
                              ) : <span className="secondaire">{l.consigne || '—'}</span>}
                            </td>
                            <td className="num secondaire">{matiere ? `${fmtNombre(matiere.qte_disponible)} ${matiere.unite}` : '—'}</td>
                            {modifiable && (
                              <td><button className="bouton petit danger" onClick={() => setLignes(lignes.filter((_, j) => j !== i))}>Retirer</button></td>
                            )}
                          </tr>
                        );
                      })}
                    </Fragment>
                  );
                })}
                {lignes.length === 0 && <tr><td colSpan={6}><Vide texte="Aucun ingredient saisi." /></td></tr>}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>Total ponderal</td>
                  <td className="num" style={{ color: conforme ? 'var(--succes)' : 'var(--danger)' }}>{fmtNombre(sommeArrondie)} %</td>
                  <td colSpan={modifiable ? 3 : 2} className="secondaire">{conforme ? 'Formule equilibree' : `Ecart de ${fmtNombre(ecart)} %`}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {modifiable && (
            <div className="corps">
              <div className="actions">
                {PHASES.map((p) => (
                  <button key={p.cle} className="bouton petit"
                    onClick={() => setLignes([...lignes, {
                      article_id: String(matieres.donnees?.[0]?.id ?? ''), phase: p.cle, pourcentage_w_w: '0.000', consigne: '',
                    }])}>
                    + Ingredient phase {p.cle}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {onglet === 'echelle' && <MiseAEchelle formuleId={Number(id)} contenance={f.contenance_ml} />}

      {onglet === 'versions' && (
        <section className="carte">
          <div className="corps sans-marge tableau-conteneur">
            <table className="tableau">
              <thead><tr><th>Version</th><th>Statut</th><th>Creee le</th><th /></tr></thead>
              <tbody>
                {f.versions.map((v: any) => (
                  <tr key={v.id}>
                    <td><strong>v{v.version}</strong></td>
                    <td><Badge valeur={v.statut} /></td>
                    <td>{fmtDate(v.cree_le)}</td>
                    <td>{v.id !== f.id && <button className="bouton petit" onClick={() => { setLignes(null); naviguer(`/formules/${v.id}`); }}>Ouvrir</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function MiseAEchelle({ formuleId, contenance }: { formuleId: number; contenance: number | null }) {
  const [mode, setMode] = useState<'masse' | 'unites'>('masse');
  const [valeur, setValeur] = useState('150');
  const [surdosage, setSurdosage] = useState('1.5');
  const [resultat, setResultat] = useState<any>(null);
  const [erreur, setErreur] = useState<unknown>(null);

  const calculer = async () => {
    setErreur(null);
    try {
      setResultat(await api.post(`/formules/${formuleId}/mise-a-echelle`, {
        masse_nette_kg: mode === 'masse' ? Number(valeur) : null,
        unites_pf: mode === 'unites' ? Number(valeur) : null,
        surdosage_pct: Number(surdosage || 0),
      }));
    } catch (e) { setErreur(e); setResultat(null); }
  };

  return (
    <section className="carte">
      <header><h2>Mise a l'echelle dynamique</h2></header>
      <div className="corps">
        <AlerteErreur erreur={erreur} />
        <div className="ligne-champs" style={{ alignItems: 'end' }}>
          <Champ libelle="Cible">
            <select value={mode} onChange={(e) => setMode(e.target.value as 'masse' | 'unites')}>
              <option value="masse">Masse nette de vrac (kg)</option>
              <option value="unites" disabled={!contenance}>Nombre d'unites de produit fini</option>
            </select>
          </Champ>
          <Champ libelle={mode === 'masse' ? 'Masse nette (kg)' : "Nombre d'unites"} obligatoire>
            <input type="number" step={mode === 'masse' ? '0.001' : '1'} value={valeur} onChange={(e) => setValeur(e.target.value)} />
          </Champ>
          <Champ libelle="Surdosage technique (%)" aide="Compensation fonds de cuve et tuyauterie">
            <input type="number" step="0.001" value={surdosage} onChange={(e) => setSurdosage(e.target.value)} />
          </Champ>
          <button className="bouton primaire" onClick={calculer}>Calculer la fiche de fabrication</button>
        </div>

        {resultat && (
          <>
            <div className="grille quatre" style={{ margin: '16px 0' }}>
              <Indicateur libelle="Masse nette" valeur={`${fmtNombre(resultat.masse_nette_kg)} kg`} />
              <Indicateur libelle="Masse brute a peser" valeur={`${fmtNombre(resultat.masse_brute_kg)} kg`}
                detail={`Surdosage ${fmtNombre(resultat.surdosage_pct)} %`} />
              <Indicateur libelle="Volume equivalent" valeur={`${fmtNombre(resultat.volume_litres)} L`} />
              <Indicateur libelle="Unites de PF" valeur={resultat.unites_pf ?? '—'} />
            </div>
            <div className="tableau-conteneur">
              <table className="tableau">
                <thead><tr><th>Phase</th><th>Matiere premiere</th><th className="num">% w/w</th>
                  <th className="num">Masse a peser</th><th className="num">Stock disponible</th><th>Couverture</th><th>Consigne</th></tr></thead>
                <tbody>
                  {resultat.lignes.map((l: any, i: number) => (
                    <tr key={i} className={!l.suffisant ? 'limitant' : undefined}>
                      <td>{l.phase}</td>
                      <td><strong>{l.code_sku}</strong><div className="secondaire">{l.designation}</div></td>
                      <td className="num">{fmtNombre(l.pourcentage_w_w)} %</td>
                      <td className="num"><strong>{fmtNombre(l.masse_theorique_g)} g</strong></td>
                      <td className="num">{fmtNombre(l.qte_disponible)} g</td>
                      <td><Badge valeur={l.suffisant ? 'DISPONIBLE' : 'INSUFFISANT'} classe={l.suffisant ? 'succes' : 'danger'} /></td>
                      <td className="secondaire">{l.consigne ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={3}>Total</td><td className="num">{fmtNombre(resultat.total_masse_g)} g</td><td colSpan={3} /></tr></tfoot>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
