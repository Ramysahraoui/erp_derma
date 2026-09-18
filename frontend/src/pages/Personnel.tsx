import { useState } from 'react';
import { api, aujourdhui, fmtDate, fmtMontant, fmtNombre } from '../api';
import { AlerteErreur, Badge, Champ, Chargement, Indicateur, Modale, Onglets, useChargement, Vide } from '../composants/Ui';

export function Personnel() {
  const [onglet, setOnglet] = useState('salaries');
  const [modale, setModale] = useState<'salarie' | 'pointage' | null>(null);
  const salaries = useChargement(() => api.get('/salaries'));
  const pointages = useChargement(() => api.get('/pointages'));
  const synthese = useChargement(() => api.get('/rh/synthese'));

  const totalHeures = (synthese.donnees ?? []).reduce((t: number, s: any) => t + Number(s.heures), 0);
  const totalCout = (synthese.donnees ?? []).reduce((t: number, s: any) => t + Number(s.cout_main_oeuvre), 0);

  return (
    <>
      <div className="grille trois" style={{ marginBottom: 16 }}>
        <Indicateur libelle="Effectif actif" valeur={(salaries.donnees ?? []).filter((s: any) => s.actif).length} />
        <Indicateur libelle="Heures pointees" valeur={fmtNombre(totalHeures, 2)} />
        <Indicateur libelle="Cout de main d'oeuvre" valeur={fmtMontant(totalCout)} />
      </div>

      <div className="barre-filtres">
        <div style={{ flex: 1 }} />
        <button className="bouton" onClick={() => setModale('pointage')}>Saisir un pointage</button>
        <button className="bouton primaire" onClick={() => setModale('salarie')}>Nouveau salarie</button>
      </div>

      <Onglets actif={onglet} onChange={setOnglet} onglets={[
        { cle: 'salaries', libelle: 'Fiches salaries' },
        { cle: 'pointages', libelle: 'Pointages' },
        { cle: 'synthese', libelle: 'Synthese par departement' },
      ]} />

      {onglet === 'salaries' && (
        <section className="carte">
          <div className="corps sans-marge tableau-conteneur">
            {salaries.enCours && !salaries.donnees ? <Chargement /> : !salaries.donnees?.length ? <Vide /> : (
              <table className="tableau">
                <thead><tr><th>Matricule</th><th>Nom</th><th>Fonction</th><th>Departement</th><th>Contrat</th>
                  <th className="num">Salaire de base</th><th className="num">Taux horaire</th><th>Etat</th></tr></thead>
                <tbody>
                  {salaries.donnees.map((s: any) => (
                    <tr key={s.id}>
                      <td><strong>{s.matricule}</strong></td>
                      <td>{s.nom} {s.prenom}</td>
                      <td>{s.fonction}</td>
                      <td><Badge valeur={s.departement} classe="info" /></td>
                      <td>{s.type_contrat}</td>
                      <td className="num">{fmtMontant(s.salaire_base)}</td>
                      <td className="num">{fmtMontant(s.taux_horaire)}</td>
                      <td><Badge valeur={s.actif ? 'ACTIF' : 'INACTIF'} classe={s.actif ? 'succes' : 'danger'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {onglet === 'pointages' && (
        <section className="carte">
          <div className="corps sans-marge tableau-conteneur">
            {pointages.enCours && !pointages.donnees ? <Chargement /> : !pointages.donnees?.length ? <Vide texte="Aucun pointage." /> : (
              <table className="tableau">
                <thead><tr><th>Date</th><th>Salarie</th><th>Departement</th><th>OF</th>
                  <th className="num">Heures</th><th className="num">Cout</th></tr></thead>
                <tbody>
                  {pointages.donnees.map((p: any) => (
                    <tr key={p.id}>
                      <td>{fmtDate(p.date_jour)}</td>
                      <td>{p.nom} {p.prenom}<div className="secondaire">{p.matricule}</div></td>
                      <td>{p.departement}</td>
                      <td className="secondaire">{p.code_of ?? '—'}</td>
                      <td className="num">{fmtNombre(p.heures, 2)}</td>
                      <td className="num">{fmtMontant(p.cout_main_oeuvre)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {onglet === 'synthese' && (
        <section className="carte">
          <div className="corps sans-marge tableau-conteneur">
            <table className="tableau">
              <thead><tr><th>Departement</th><th className="num">Effectif</th><th className="num">Heures</th><th className="num">Cout de main d'oeuvre</th></tr></thead>
              <tbody>
                {(synthese.donnees ?? []).map((s: any) => (
                  <tr key={s.departement}>
                    <td><strong>{s.departement}</strong></td>
                    <td className="num">{s.effectif}</td>
                    <td className="num">{fmtNombre(s.heures, 2)}</td>
                    <td className="num">{fmtMontant(s.cout_main_oeuvre)}</td>
                  </tr>
                ))}
                {!(synthese.donnees ?? []).length && <tr><td colSpan={4}><Vide /></td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {modale === 'salarie' && <ModaleSalarie onFermer={() => setModale(null)} onCree={() => { setModale(null); salaries.recharger(); }} />}
      {modale === 'pointage' && (
        <ModalePointage salaries={salaries.donnees ?? []} onFermer={() => setModale(null)}
          onCree={() => { setModale(null); pointages.recharger(); synthese.recharger(); }} />
      )}
    </>
  );
}

function ModaleSalarie({ onFermer, onCree }: { onFermer: () => void; onCree: () => void }) {
  const [form, setForm] = useState<any>({ type_contrat: 'CDI', departement: 'PRODUCTION', salaire_base: '0', taux_horaire: '0' });
  const [erreur, setErreur] = useState<unknown>(null);
  const maj = (c: string, v: string) => setForm({ ...form, [c]: v });

  const creer = async () => {
    setErreur(null);
    try {
      await api.post('/salaries', {
        ...form, salaire_base: Number(form.salaire_base || 0), taux_horaire: Number(form.taux_horaire || 0),
        date_naissance: form.date_naissance || null, date_embauche: form.date_embauche || null,
      });
      onCree();
    } catch (e) { setErreur(e); }
  };

  return (
    <Modale titre="Nouveau salarie" onFermer={onFermer}
      actions={<><button className="bouton" onClick={onFermer}>Annuler</button>
        <button className="bouton primaire" onClick={creer}>Creer la fiche</button></>}>
      <AlerteErreur erreur={erreur} />
      <div className="ligne-champs">
        <Champ libelle="Matricule" obligatoire><input value={form.matricule ?? ''} onChange={(e) => maj('matricule', e.target.value.toUpperCase())} /></Champ>
        <Champ libelle="Nom" obligatoire><input value={form.nom ?? ''} onChange={(e) => maj('nom', e.target.value)} /></Champ>
        <Champ libelle="Prenom" obligatoire><input value={form.prenom ?? ''} onChange={(e) => maj('prenom', e.target.value)} /></Champ>
        <Champ libelle="Date de naissance"><input type="date" value={form.date_naissance ?? ''} onChange={(e) => maj('date_naissance', e.target.value)} /></Champ>
      </div>
      <div className="ligne-champs" style={{ marginTop: 12 }}>
        <Champ libelle="Fonction" obligatoire>
          <select value={form.fonction ?? ''} onChange={(e) => maj('fonction', e.target.value)}>
            <option value="">Selectionner…</option>
            <option>Operateur formulation</option><option>Operateur conditionnement</option>
            <option>Technicien qualite</option><option>Commercial</option><option>Direction</option>
          </select>
        </Champ>
        <Champ libelle="Departement" obligatoire>
          <select value={form.departement} onChange={(e) => maj('departement', e.target.value)}>
            <option>PRODUCTION</option><option>CONDITIONNEMENT</option><option>QUALITE</option>
            <option>COMMERCIAL</option><option>ADMINISTRATION</option>
          </select>
        </Champ>
        <Champ libelle="Type de contrat"><input value={form.type_contrat} onChange={(e) => maj('type_contrat', e.target.value)} /></Champ>
        <Champ libelle="Date d'embauche"><input type="date" value={form.date_embauche ?? ''} onChange={(e) => maj('date_embauche', e.target.value)} /></Champ>
      </div>
      <div className="ligne-champs" style={{ marginTop: 12 }}>
        <Champ libelle="Salaire de base"><input type="number" step="0.01" value={form.salaire_base} onChange={(e) => maj('salaire_base', e.target.value)} /></Champ>
        <Champ libelle="Taux horaire" aide="Utilise dans le calcul du cout de revient">
          <input type="number" step="0.01" value={form.taux_horaire} onChange={(e) => maj('taux_horaire', e.target.value)} />
        </Champ>
      </div>
    </Modale>
  );
}

function ModalePointage({ salaries, onFermer, onCree }: { salaries: any[]; onFermer: () => void; onCree: () => void }) {
  const ordres = useChargement(() => api.get('/of?limite=50'));
  const [form, setForm] = useState<any>({ date_jour: aujourdhui(), heures: '8' });
  const [erreur, setErreur] = useState<unknown>(null);

  const creer = async () => {
    setErreur(null);
    try {
      const salarie = salaries.find((s) => String(s.id) === form.salarie_id);
      await api.post('/pointages', {
        salarie_id: Number(form.salarie_id),
        date_jour: form.date_jour,
        heures: Number(form.heures),
        departement: salarie?.departement ?? 'PRODUCTION',
        of_id: form.of_id ? Number(form.of_id) : null,
        commentaire: form.commentaire || null,
      });
      onCree();
    } catch (e) { setErreur(e); }
  };

  return (
    <Modale titre="Saisie d'un pointage" onFermer={onFermer}
      actions={<><button className="bouton" onClick={onFermer}>Annuler</button>
        <button className="bouton primaire" onClick={creer} disabled={!form.salarie_id}>Enregistrer</button></>}>
      <AlerteErreur erreur={erreur} />
      <div className="ligne-champs">
        <Champ libelle="Salarie" obligatoire>
          <select value={form.salarie_id ?? ''} onChange={(e) => setForm({ ...form, salarie_id: e.target.value })}>
            <option value="">Selectionner…</option>
            {salaries.filter((s) => s.actif).map((s) => <option key={s.id} value={s.id}>{s.matricule} — {s.nom} {s.prenom}</option>)}
          </select>
        </Champ>
        <Champ libelle="Date" obligatoire><input type="date" value={form.date_jour} onChange={(e) => setForm({ ...form, date_jour: e.target.value })} /></Champ>
        <Champ libelle="Heures travaillees" obligatoire><input type="number" step="0.25" value={form.heures} onChange={(e) => setForm({ ...form, heures: e.target.value })} /></Champ>
        <Champ libelle="Ordre de fabrication" aide="Imputation directe au cout de revient">
          <select value={form.of_id ?? ''} onChange={(e) => setForm({ ...form, of_id: e.target.value })}>
            <option value="">—</option>
            {(ordres.donnees ?? []).map((o: any) => <option key={o.id} value={o.id}>{o.code_of} — {o.nom_produit}</option>)}
          </select>
        </Champ>
      </div>
    </Modale>
  );
}
