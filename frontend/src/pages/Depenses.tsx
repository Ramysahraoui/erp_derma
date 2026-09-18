import { useState } from 'react';
import { api, aujourdhui, fmtDate, fmtMontant } from '../api';
import { useAuth } from '../auth';
import { AlerteErreur, Badge, Champ, Chargement, Indicateur, Modale, Onglets, useChargement, Vide } from '../composants/Ui';

export function Depenses() {
  const { peut } = useAuth();
  const [onglet, setOnglet] = useState('journal');
  const [type, setType] = useState('');
  const [saisie, setSaisie] = useState(false);
  const liste = useChargement(() => api.get(`/depenses?${new URLSearchParams(type ? { type } : {})}`), [type]);
  const tresorerie = useChargement(() => api.get('/tresorerie'));

  return (
    <>
      {tresorerie.donnees && (
        <div className="grille trois" style={{ marginBottom: 16 }}>
          <Indicateur libelle="Recettes encaissees" valeur={fmtMontant(tresorerie.donnees.synthese.total_recettes)} ton="succes" />
          <Indicateur libelle="Depenses" valeur={fmtMontant(tresorerie.donnees.synthese.total_depenses)} ton="alerte" />
          <Indicateur libelle="Solde de tresorerie" valeur={fmtMontant(tresorerie.donnees.synthese.solde)}
            ton={Number(tresorerie.donnees.synthese.solde) >= 0 ? 'succes' : 'danger'} />
        </div>
      )}

      <div className="barre-filtres">
        <Champ libelle="Nature de charge">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Toutes</option>
            <option value="DIRECTE">Charges directes</option>
            <option value="INDIRECTE">Charges indirectes</option>
          </select>
        </Champ>
        <div style={{ flex: 1 }} />
        {peut('depense:ecrire') && <button className="bouton primaire" onClick={() => setSaisie(true)}>Saisir une depense</button>}
      </div>

      <Onglets actif={onglet} onChange={setOnglet} onglets={[
        { cle: 'journal', libelle: "Journal des depenses" },
        { cle: 'tresorerie', libelle: 'Rapprochement bancaire' },
      ]} />

      {onglet === 'journal' && (
        <section className="carte">
          <div className="corps sans-marge tableau-conteneur">
            {liste.enCours && !liste.donnees ? <Chargement /> : liste.erreur ? <AlerteErreur erreur={liste.erreur} /> :
              !liste.donnees?.length ? <Vide texte="Aucune depense enregistree." /> : (
              <table className="tableau">
                <thead><tr><th>Numero</th><th>Date</th><th>Libelle</th><th>Categorie</th><th>Nature</th>
                  <th>OF impute</th><th className="num">Montant HT</th><th className="num">TTC</th><th>Rapproche</th></tr></thead>
                <tbody>
                  {liste.donnees.map((d: any) => (
                    <tr key={d.id}>
                      <td><strong>{d.numero}</strong></td>
                      <td>{fmtDate(d.date_depense)}</td>
                      <td>{d.libelle}<div className="secondaire">{d.fournisseur ?? ''}</div></td>
                      <td>{d.categorie}</td>
                      <td><Badge valeur={d.type_charge} classe={d.type_charge === 'DIRECTE' ? 'info' : undefined} /></td>
                      <td className="secondaire">{d.code_of ?? '—'}</td>
                      <td className="num">{fmtMontant(d.montant_ht)}</td>
                      <td className="num">{fmtMontant(d.montant_ttc)}</td>
                      <td>
                        {peut('depense:ecrire') ? (
                          <input type="checkbox" checked={d.rapproche} style={{ width: 20, height: 20, minHeight: 20 }}
                            onChange={(e) => api.post(`/depenses/${d.id}/rapprochement`, { rapproche: e.target.checked }).then(liste.recharger)} />
                        ) : d.rapproche ? 'Oui' : 'Non'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {onglet === 'tresorerie' && (
        <div className="grille deux">
          <section className="carte">
            <header><h2>Recettes encaissees par mois</h2></header>
            <div className="corps sans-marge tableau-conteneur">
              <table className="tableau">
                <thead><tr><th>Mois</th><th>Mode</th><th className="num">Nombre</th><th className="num">Total</th></tr></thead>
                <tbody>
                  {(tresorerie.donnees?.recettes ?? []).map((r: any, i: number) => (
                    <tr key={i}><td>{fmtDate(r.mois)}</td><td><Badge valeur={r.mode_reglement} classe="info" /></td>
                      <td className="num">{r.nombre}</td><td className="num">{fmtMontant(r.total)}</td></tr>
                  ))}
                  {!(tresorerie.donnees?.recettes ?? []).length && <tr><td colSpan={4}><Vide /></td></tr>}
                </tbody>
              </table>
            </div>
          </section>
          <section className="carte">
            <header><h2>Depenses par mois</h2></header>
            <div className="corps sans-marge tableau-conteneur">
              <table className="tableau">
                <thead><tr><th>Mois</th><th>Nature</th><th className="num">Nombre</th><th className="num">Total TTC</th></tr></thead>
                <tbody>
                  {(tresorerie.donnees?.depenses ?? []).map((r: any, i: number) => (
                    <tr key={i}><td>{fmtDate(r.mois)}</td><td><Badge valeur={r.type_charge} /></td>
                      <td className="num">{r.nombre}</td><td className="num">{fmtMontant(r.total)}</td></tr>
                  ))}
                  {!(tresorerie.donnees?.depenses ?? []).length && <tr><td colSpan={4}><Vide /></td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {saisie && <ModaleDepense onFermer={() => setSaisie(false)} onCree={() => { setSaisie(false); liste.recharger(); tresorerie.recharger(); }} />}
    </>
  );
}

function ModaleDepense({ onFermer, onCree }: { onFermer: () => void; onCree: () => void }) {
  const categories = useChargement(() => api.get('/depenses/categories'));
  const fournisseurs = useChargement(() => api.get('/fournisseurs'));
  const ordres = useChargement(() => api.get('/of?limite=50'));
  const [form, setForm] = useState<any>({ date_depense: aujourdhui(), tva_pct: '19', montant_ht: '' });
  const [erreur, setErreur] = useState<unknown>(null);

  const creer = async () => {
    setErreur(null);
    try {
      await api.post('/depenses', {
        categorie_id: Number(form.categorie_id),
        libelle: form.libelle,
        date_depense: form.date_depense,
        montant_ht: Number(form.montant_ht),
        tva_pct: Number(form.tva_pct || 0),
        mode_paiement: form.mode_paiement || null,
        fournisseur_id: form.fournisseur_id ? Number(form.fournisseur_id) : null,
        of_id: form.of_id ? Number(form.of_id) : null,
      });
      onCree();
    } catch (e) { setErreur(e); }
  };

  return (
    <Modale titre="Nouvelle depense" onFermer={onFermer}
      actions={<><button className="bouton" onClick={onFermer}>Annuler</button>
        <button className="bouton primaire" onClick={creer} disabled={!form.categorie_id || !form.libelle}>Enregistrer</button></>}>
      <AlerteErreur erreur={erreur} />
      <div className="ligne-champs">
        <Champ libelle="Categorie analytique" obligatoire>
          <select value={form.categorie_id ?? ''} onChange={(e) => setForm({ ...form, categorie_id: e.target.value })}>
            <option value="">Selectionner…</option>
            {(categories.donnees ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.libelle} ({c.type === 'DIRECTE' ? 'directe' : 'indirecte'})</option>)}
          </select>
        </Champ>
        <Champ libelle="Date" obligatoire><input type="date" value={form.date_depense} onChange={(e) => setForm({ ...form, date_depense: e.target.value })} /></Champ>
      </div>
      <div style={{ marginTop: 12 }}>
        <Champ libelle="Libelle" obligatoire><input value={form.libelle ?? ''} onChange={(e) => setForm({ ...form, libelle: e.target.value })} /></Champ>
      </div>
      <div className="ligne-champs" style={{ marginTop: 12 }}>
        <Champ libelle="Montant HT" obligatoire><input type="number" step="0.01" value={form.montant_ht} onChange={(e) => setForm({ ...form, montant_ht: e.target.value })} /></Champ>
        <Champ libelle="TVA (%)"><input type="number" step="0.01" value={form.tva_pct} onChange={(e) => setForm({ ...form, tva_pct: e.target.value })} /></Champ>
        <Champ libelle="Mode de paiement">
          <select value={form.mode_paiement ?? ''} onChange={(e) => setForm({ ...form, mode_paiement: e.target.value })}>
            <option value="">—</option><option value="ESPECES">Especes</option>
            <option value="CHEQUE">Cheque</option><option value="VIREMENT">Virement</option>
          </select>
        </Champ>
      </div>
      <div className="ligne-champs" style={{ marginTop: 12 }}>
        <Champ libelle="Fournisseur">
          <select value={form.fournisseur_id ?? ''} onChange={(e) => setForm({ ...form, fournisseur_id: e.target.value })}>
            <option value="">—</option>
            {(fournisseurs.donnees ?? []).map((f: any) => <option key={f.id} value={f.id}>{f.raison_sociale}</option>)}
          </select>
        </Champ>
        <Champ libelle="Imputation a un OF" aide="Charge directe rattachee au cout de revient">
          <select value={form.of_id ?? ''} onChange={(e) => setForm({ ...form, of_id: e.target.value })}>
            <option value="">—</option>
            {(ordres.donnees ?? []).map((o: any) => <option key={o.id} value={o.id}>{o.code_of} — {o.nom_produit}</option>)}
          </select>
        </Champ>
      </div>
    </Modale>
  );
}
