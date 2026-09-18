import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDate, fmtNombre } from '../api';
import { useAuth } from '../auth';
import { AlerteErreur, Badge, Champ, Chargement, Modale, useChargement, Vide } from '../composants/Ui';

export function Formules() {
  const { peut } = useAuth();
  const naviguer = useNavigate();
  const [recherche, setRecherche] = useState('');
  const [creation, setCreation] = useState(false);
  const liste = useChargement(() => api.get(`/formules?${new URLSearchParams(recherche ? { recherche } : {})}`), [recherche]);

  return (
    <>
      <div className="barre-filtres">
        <Champ libelle="Recherche"><input value={recherche} onChange={(e) => setRecherche(e.target.value)} placeholder="Code ou produit" /></Champ>
        <div style={{ flex: 1 }} />
        {peut('formule:ecrire') && <button className="bouton primaire" onClick={() => setCreation(true)}>Nouvelle formule</button>}
      </div>

      <section className="carte">
        <div className="corps sans-marge tableau-conteneur">
          {liste.enCours && !liste.donnees ? <Chargement /> : liste.erreur ? <AlerteErreur erreur={liste.erreur} /> :
            !liste.donnees?.length ? <Vide texte="Aucune formule." /> : (
            <table className="tableau">
              <thead><tr><th>Code</th><th>Produit</th><th className="num">Version</th><th className="num">Densite</th>
                <th className="num">Ingredients</th><th className="num">Somme w/w</th><th>Statut</th><th>Creee le</th></tr></thead>
              <tbody>
                {liste.donnees.map((f: any) => {
                  const somme = Number(f.somme_ponderale);
                  return (
                    <tr key={f.id} className="cliquable" onClick={() => naviguer(`/formules/${f.id}`)}>
                      <td><strong>{f.code_formule}</strong></td>
                      <td>{f.nom_produit}<div className="secondaire">{f.pf_code_sku ?? 'Aucun PF rattache'}</div></td>
                      <td className="num">v{f.version}</td>
                      <td className="num">{fmtNombre(f.densite, 4)}</td>
                      <td className="num">{f.nb_ingredients}</td>
                      <td className="num" style={{ color: somme === 100 ? 'var(--succes)' : 'var(--danger)', fontWeight: 700 }}>
                        {fmtNombre(somme)} %
                      </td>
                      <td><Badge valeur={f.statut} /></td>
                      <td>{fmtDate(f.cree_le)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {creation && <ModaleCreation onFermer={() => setCreation(false)} onCree={(id) => naviguer(`/formules/${id}`)} />}
    </>
  );
}

function ModaleCreation({ onFermer, onCree }: { onFermer: () => void; onCree: (id: number) => void }) {
  const produits = useChargement(() => api.get('/articles?type=PF'));
  const [form, setForm] = useState<any>({ densite: '1.0000', perte_process_pct: '1.5' });
  const [erreur, setErreur] = useState<unknown>(null);

  const creer = async () => {
    setErreur(null);
    try {
      const formule = await api.post('/formules', {
        code_formule: form.code_formule,
        nom_produit: form.nom_produit,
        densite: Number(form.densite),
        article_pf_id: form.article_pf_id ? Number(form.article_pf_id) : null,
        perte_process_pct: Number(form.perte_process_pct || 0),
        ph_min: form.ph_min ? Number(form.ph_min) : null,
        ph_max: form.ph_max ? Number(form.ph_max) : null,
        viscosite_min: form.viscosite_min ? Number(form.viscosite_min) : null,
        viscosite_max: form.viscosite_max ? Number(form.viscosite_max) : null,
        commentaire: form.commentaire || null,
      });
      onCree(formule.id);
    } catch (e) { setErreur(e); }
  };

  return (
    <Modale titre="Nouvelle formule" onFermer={onFermer}
      actions={<><button className="bouton" onClick={onFermer}>Annuler</button>
        <button className="bouton primaire" onClick={creer}>Creer et saisir les ingredients</button></>}>
      <AlerteErreur erreur={erreur} />
      <div className="ligne-champs">
        <Champ libelle="Code formule" obligatoire>
          <input value={form.code_formule ?? ''} onChange={(e) => setForm({ ...form, code_formule: e.target.value.toUpperCase() })} placeholder="FOR-XXX-01" />
        </Champ>
        <Champ libelle="Designation du produit" obligatoire>
          <input value={form.nom_produit ?? ''} onChange={(e) => setForm({ ...form, nom_produit: e.target.value })} />
        </Champ>
      </div>
      <div className="ligne-champs" style={{ marginTop: 12 }}>
        <Champ libelle="Densite theorique" obligatoire aide="Conversion masse / volume">
          <input type="number" step="0.0001" value={form.densite} onChange={(e) => setForm({ ...form, densite: e.target.value })} />
        </Champ>
        <Champ libelle="Produit fini rattache">
          <select value={form.article_pf_id ?? ''} onChange={(e) => setForm({ ...form, article_pf_id: e.target.value })}>
            <option value="">—</option>
            {(produits.donnees ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.code_sku} — {p.designation}</option>)}
          </select>
        </Champ>
        <Champ libelle="Perte de process (%)" aide="Fonds de cuve et tuyauterie">
          <input type="number" step="0.001" value={form.perte_process_pct} onChange={(e) => setForm({ ...form, perte_process_pct: e.target.value })} />
        </Champ>
      </div>
      <div className="ligne-champs" style={{ marginTop: 12 }}>
        <Champ libelle="pH minimal"><input type="number" step="0.01" value={form.ph_min ?? ''} onChange={(e) => setForm({ ...form, ph_min: e.target.value })} /></Champ>
        <Champ libelle="pH maximal"><input type="number" step="0.01" value={form.ph_max ?? ''} onChange={(e) => setForm({ ...form, ph_max: e.target.value })} /></Champ>
        <Champ libelle="Viscosite min (mPa·s)"><input type="number" step="1" value={form.viscosite_min ?? ''} onChange={(e) => setForm({ ...form, viscosite_min: e.target.value })} /></Champ>
        <Champ libelle="Viscosite max (mPa·s)"><input type="number" step="1" value={form.viscosite_max ?? ''} onChange={(e) => setForm({ ...form, viscosite_max: e.target.value })} /></Champ>
      </div>
    </Modale>
  );
}
