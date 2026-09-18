import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, aujourdhui, fmtDate, fmtEntier, fmtNombre, fmtPct } from '../api';
import { useAuth } from '../auth';
import { Alerte, AlerteErreur, Badge, Champ, Chargement, Indicateur, Modale, useChargement, Vide } from '../composants/Ui';

export function OrdresFabrication() {
  const { peut } = useAuth();
  const naviguer = useNavigate();
  const [statut, setStatut] = useState('');
  const [creation, setCreation] = useState(false);
  const liste = useChargement(() => api.get(`/of?${new URLSearchParams(statut ? { statut } : {})}`), [statut]);

  return (
    <>
      <div className="barre-filtres">
        <Champ libelle="Statut">
          <select value={statut} onChange={(e) => setStatut(e.target.value)}>
            <option value="">Tous</option>
            <option value="BROUILLON">Brouillon</option>
            <option value="PESEE">Pesee en cours</option>
            <option value="FABRICATION">Fabrication / controle cuve</option>
            <option value="VRAC_LIBERE">Vrac libere</option>
            <option value="CONDITIONNEMENT">Conditionnement</option>
            <option value="CLOTURE">Cloture</option>
          </select>
        </Champ>
        <div style={{ flex: 1 }} />
        {peut('production:creer') && <button className="bouton primaire" onClick={() => setCreation(true)}>Nouvel ordre de fabrication</button>}
      </div>

      <section className="carte">
        <div className="corps sans-marge tableau-conteneur">
          {liste.enCours && !liste.donnees ? <Chargement /> : liste.erreur ? <AlerteErreur erreur={liste.erreur} /> :
            !liste.donnees?.length ? <Vide texte="Aucun ordre de fabrication." /> : (
            <table className="tableau">
              <thead><tr><th>Code OF</th><th>Produit</th><th className="num">Masse cible</th><th>Avancement pesees</th>
                <th>Lot de vrac</th><th className="num">Unites</th><th className="num">Rendement</th><th>Statut</th></tr></thead>
              <tbody>
                {liste.donnees.map((o: any) => {
                  const avance = Number(o.nb_lignes) ? (Number(o.nb_pesees) / Number(o.nb_lignes)) * 100 : 0;
                  return (
                    <tr key={o.id} className="cliquable" onClick={() => naviguer(`/production/${o.id}`)}>
                      <td><strong>{o.code_of}</strong><div className="secondaire">{fmtDate(o.cree_le)}</div></td>
                      <td>{o.nom_produit}<div className="secondaire">{o.code_formule} v{o.formule_version}</div></td>
                      <td className="num">{fmtNombre(o.masse_cible_kg)} kg<div className="secondaire">brute {fmtNombre(o.masse_brute_kg)}</div></td>
                      <td style={{ minWidth: 130 }}>
                        <div className="progression"><div style={{ width: `${avance}%` }} /></div>
                        <div className="secondaire">{o.nb_pesees} / {o.nb_lignes} lignes</div>
                      </td>
                      <td>{o.code_lot_vrac ?? '—'}{o.statut_vrac && <div className="secondaire"><Badge valeur={o.statut_vrac} /></div>}</td>
                      <td className="num">{fmtEntier(o.unites_produites)}</td>
                      <td className="num">{o.rendement_pct ? fmtPct(o.rendement_pct) : '—'}</td>
                      <td><Badge valeur={o.statut_of} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {creation && <ModaleCreationOf onFermer={() => setCreation(false)} onCree={(id) => naviguer(`/production/${id}`)} />}
    </>
  );
}

function ModaleCreationOf({ onFermer, onCree }: { onFermer: () => void; onCree: (id: number) => void }) {
  const formules = useChargement(() => api.get('/formules?statut=VALIDEE'));
  const [form, setForm] = useState<any>({ mode: 'masse', valeur: '30', surdosage_pct: '1.5', date_planifiee: aujourdhui() });
  const [simulation, setSimulation] = useState<any>(null);
  const [erreur, setErreur] = useState<unknown>(null);
  const [enCours, setEnCours] = useState(false);

  const charge = () => ({
    formule_id: Number(form.formule_id),
    masse_nette_kg: form.mode === 'masse' ? Number(form.valeur) : null,
    unites_pf_cibles: form.mode === 'unites' ? Number(form.valeur) : null,
    surdosage_pct: Number(form.surdosage_pct || 0),
  });

  const simuler = async () => {
    setErreur(null);
    try { setSimulation(await api.post('/of/simulation', charge())); }
    catch (e) { setErreur(e); setSimulation(null); }
  };

  const creer = async () => {
    setErreur(null); setEnCours(true);
    try {
      const of = await api.post('/of', { ...charge(), date_planifiee: form.date_planifiee || null, commentaire: form.commentaire || null });
      onCree(of.id);
    } catch (e) { setErreur(e); } finally { setEnCours(false); }
  };

  return (
    <Modale large titre="Nouvel ordre de fabrication" onFermer={onFermer}
      actions={<>
        <button className="bouton" onClick={onFermer}>Annuler</button>
        <button className="bouton" onClick={simuler} disabled={!form.formule_id}>Simuler</button>
        <button className="bouton primaire" onClick={creer} disabled={!form.formule_id || enCours}>Lancer l'ordre de fabrication</button>
      </>}>
      <AlerteErreur erreur={erreur} />
      <div className="ligne-champs">
        <Champ libelle="Formule validee" obligatoire>
          <select value={form.formule_id ?? ''} onChange={(e) => setForm({ ...form, formule_id: e.target.value })}>
            <option value="">Selectionner…</option>
            {(formules.donnees ?? []).map((f: any) => (
              <option key={f.id} value={f.id}>{f.code_formule} v{f.version} — {f.nom_produit}</option>
            ))}
          </select>
        </Champ>
        <Champ libelle="Cible de fabrication">
          <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
            <option value="masse">Masse nette de vrac (kg)</option>
            <option value="unites">Nombre d'unites de produit fini</option>
          </select>
        </Champ>
        <Champ libelle={form.mode === 'masse' ? 'Masse nette (kg)' : "Unites cibles"} obligatoire>
          <input type="number" step={form.mode === 'masse' ? '0.001' : '1'} value={form.valeur}
            onChange={(e) => setForm({ ...form, valeur: e.target.value })} />
        </Champ>
        <Champ libelle="Surdosage technique (%)">
          <input type="number" step="0.001" value={form.surdosage_pct} onChange={(e) => setForm({ ...form, surdosage_pct: e.target.value })} />
        </Champ>
        <Champ libelle="Date planifiee">
          <input type="date" value={form.date_planifiee} onChange={(e) => setForm({ ...form, date_planifiee: e.target.value })} />
        </Champ>
      </div>

      {simulation && (
        <>
          <div className="grille trois" style={{ margin: '16px 0' }}>
            <Indicateur libelle="Masse brute a peser" valeur={`${fmtNombre(simulation.masse_brute_kg)} kg`} />
            <Indicateur libelle="Faisabilite" valeur={simulation.faisabilite.faisable ? 'Stock suffisant' : 'Stock insuffisant'}
              ton={simulation.faisabilite.faisable ? 'succes' : 'danger'}
              detail={simulation.faisabilite.ingredient_limitant ? `Limitant : ${simulation.faisabilite.ingredient_limitant.code_sku}` : undefined} />
            <Indicateur libelle="Masse maximale fabricable" valeur={`${fmtNombre(simulation.faisabilite.masse_max_kg)} kg`}
              detail={simulation.faisabilite.unites_max !== null ? `${fmtEntier(simulation.faisabilite.unites_max)} unites` : undefined} />
          </div>
          {!simulation.faisabilite.faisable && (
            <Alerte type="erreur" titre="Lancement bloque">
              Le stock disponible ne couvre pas la fiche de fabrication. Reduire le volume cible ou reapprovisionner
              les composants manquants.
            </Alerte>
          )}
          <div className="tableau-conteneur">
            <table className="tableau">
              <thead><tr><th>Phase</th><th>Matiere</th><th className="num">% w/w</th><th className="num">Masse a peser</th>
                <th className="num">Stock</th><th>Consigne</th></tr></thead>
              <tbody>
                {simulation.lignes.map((l: any, i: number) => (
                  <tr key={i} className={!l.suffisant ? 'limitant' : undefined}>
                    <td>{l.phase}</td>
                    <td><strong>{l.code_sku}</strong><div className="secondaire">{l.designation}</div></td>
                    <td className="num">{fmtNombre(l.pourcentage_w_w)} %</td>
                    <td className="num">{fmtNombre(l.masse_theorique_g)} g</td>
                    <td className="num">{fmtNombre(l.qte_disponible)} g</td>
                    <td className="secondaire">{l.consigne ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modale>
  );
}
