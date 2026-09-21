import { useState } from 'react';
import { api, fmtDate, fmtDateHeure } from '../api';
import { LIBELLES_ROLES, type Role } from '../auth';
import { Alerte, AlerteErreur, Badge, Champ, Chargement, Modale, Onglets, useChargement, Vide } from '../composants/Ui';

const ROLES: Role[] = ['OPERATEUR_PRODUCTION', 'RESPONSABLE_RD_QUALITE', 'COMMERCIAL', 'COMPTABILITE', 'ADMIN'];

export function Administration() {
  const [onglet, setOnglet] = useState('utilisateurs');
  return (
    <>
      <Onglets actif={onglet} onChange={setOnglet} onglets={[
        { cle: 'utilisateurs', libelle: 'Utilisateurs & droits' },
        { cle: 'parametres', libelle: "Parametres d'exploitation" },
        { cle: 'audit', libelle: "Journal d'audit" },
        { cle: 'achats', libelle: "Commandes d'achat" },
      ]} />
      {onglet === 'utilisateurs' && <Utilisateurs />}
      {onglet === 'parametres' && <Parametres />}
      {onglet === 'audit' && <JournalAudit />}
      {onglet === 'achats' && <CommandesAchat />}
    </>
  );
}

function Utilisateurs() {
  const liste = useChargement(() => api.get('/auth/utilisateurs'));
  const [creation, setCreation] = useState(false);
  const [erreur, setErreur] = useState<unknown>(null);

  const basculer = async (id: number, actif: boolean) => {
    setErreur(null);
    try { await api.patch(`/auth/utilisateurs/${id}`, { actif }); liste.recharger(); }
    catch (e) { setErreur(e); }
  };

  return (
    <>
      <div className="barre-filtres">
        <div style={{ flex: 1 }} />
        <button className="bouton primaire" onClick={() => setCreation(true)}>Nouvel utilisateur</button>
      </div>
      <AlerteErreur erreur={erreur} />
      <section className="carte">
        <div className="corps sans-marge tableau-conteneur">
          {liste.enCours && !liste.donnees ? <Chargement /> : (
            <table className="tableau">
              <thead><tr><th>Nom</th><th>E-mail</th><th>Role</th><th>Derniere connexion</th><th>Etat</th><th /></tr></thead>
              <tbody>
                {(liste.donnees ?? []).map((u: any) => (
                  <tr key={u.id}>
                    <td><strong>{u.nom_complet}</strong></td>
                    <td>{u.email}</td>
                    <td><Badge valeur={LIBELLES_ROLES[u.role as Role]} classe="info" /></td>
                    <td>{u.derniere_connexion ? fmtDateHeure(u.derniere_connexion) : <span className="secondaire">Jamais connecte</span>}</td>
                    <td>
                      <Badge valeur={u.actif ? 'ACTIF' : 'DESACTIVE'} classe={u.actif ? 'succes' : 'danger'} />
                      {u.doit_changer_mot_de_passe && <> <Badge valeur="MOT DE PASSE A CHANGER" classe="alerte" /></>}
                    </td>
                    <td><button className="bouton petit" onClick={() => basculer(u.id, !u.actif)}>{u.actif ? 'Desactiver' : 'Reactiver'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
      {creation && <ModaleUtilisateur onFermer={() => setCreation(false)} onCree={() => { setCreation(false); liste.recharger(); }} />}
    </>
  );
}

function ModaleUtilisateur({ onFermer, onCree }: { onFermer: () => void; onCree: () => void }) {
  const [form, setForm] = useState<any>({ role: 'OPERATEUR_PRODUCTION' });
  const [erreur, setErreur] = useState<unknown>(null);
  const creer = async () => {
    setErreur(null);
    try { await api.post('/auth/utilisateurs', form); onCree(); }
    catch (e) { setErreur(e); }
  };
  return (
    <Modale titre="Nouvel utilisateur" onFermer={onFermer}
      actions={<><button className="bouton" onClick={onFermer}>Annuler</button>
        <button className="bouton primaire" onClick={creer}>Creer</button></>}>
      <AlerteErreur erreur={erreur} />
      <div className="ligne-champs">
        <Champ libelle="Nom complet" obligatoire><input value={form.nom_complet ?? ''} onChange={(e) => setForm({ ...form, nom_complet: e.target.value })} /></Champ>
        <Champ libelle="E-mail" obligatoire><input type="email" value={form.email ?? ''} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Champ>
      </div>
      <div className="ligne-champs" style={{ marginTop: 12 }}>
        <Champ libelle="Mot de passe provisoire" obligatoire aide="10 caracteres minimum">
          <input type="password" value={form.mot_de_passe ?? ''} onChange={(e) => setForm({ ...form, mot_de_passe: e.target.value })} />
        </Champ>
        <Champ libelle="Role" obligatoire>
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {ROLES.map((r) => <option key={r} value={r}>{LIBELLES_ROLES[r]}</option>)}
          </select>
        </Champ>
      </div>
      <Alerte type="info" titre="Cloisonnement des privileges">
        L'operateur de production n'accede ni aux couts, ni aux marges, ni aux clients. Seuls le responsable
        qualite et l'administrateur peuvent liberer un lot ou accepter une pesee hors tolerance.
        Le mot de passe defini ici est provisoire : son titulaire devra le changer a sa premiere connexion.
      </Alerte>
    </Modale>
  );
}

function Parametres() {
  const liste = useChargement(() => api.get('/parametres'));
  const [valeurs, setValeurs] = useState<Record<string, string>>({});
  const [erreur, setErreur] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);

  const enregistrer = async (cle: string) => {
    setErreur(null); setMessage(null);
    try {
      await api.put(`/parametres/${cle}`, { valeur: valeurs[cle] });
      setMessage(`Parametre « ${cle} » mis a jour.`);
      liste.recharger();
    } catch (e) { setErreur(e); }
  };

  return (
    <section className="carte">
      <header><h2>Parametres d'exploitation</h2></header>
      <div className="corps">
        <AlerteErreur erreur={erreur} />
        {message && <Alerte type="succes">{message}</Alerte>}
        {liste.enCours && !liste.donnees ? <Chargement /> : (
          <div className="tableau-conteneur">
            <table className="tableau">
              <thead><tr><th>Cle</th><th>Libelle</th><th style={{ width: 220 }}>Valeur</th><th>Mise a jour</th><th /></tr></thead>
              <tbody>
                {(liste.donnees ?? []).map((p: any) => (
                  <tr key={p.cle}>
                    <td><code>{p.cle}</code></td>
                    <td>{p.libelle}</td>
                    <td><input value={valeurs[p.cle] ?? p.valeur} onChange={(e) => setValeurs({ ...valeurs, [p.cle]: e.target.value })} /></td>
                    <td className="secondaire">{p.maj_le ? fmtDateHeure(p.maj_le) : 'Valeur par defaut'}</td>
                    <td><button className="bouton petit primaire" disabled={!(p.cle in valeurs)} onClick={() => enregistrer(p.cle)}>Enregistrer</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function JournalAudit() {
  const [entite, setEntite] = useState('');
  const journal = useChargement(
    () => api.get(`/documents/journal-audit?${new URLSearchParams({ limite: '300', ...(entite ? { entite } : {}) })}`),
    [entite],
  );
  return (
    <>
      <div className="barre-filtres">
        <Champ libelle="Entite">
          <select value={entite} onChange={(e) => setEntite(e.target.value)}>
            <option value="">Toutes</option>
            <option value="lots_stock">Lots de stock</option>
            <option value="ordres_fabrication">Ordres de fabrication</option>
            <option value="of_pesees_reelles">Pesees</option>
            <option value="lots_vrac">Lots de vrac</option>
            <option value="ventes_documents">Documents de vente</option>
            <option value="encaissements">Encaissements</option>
            <option value="formules">Formules</option>
            <option value="utilisateurs">Utilisateurs</option>
          </select>
        </Champ>
      </div>
      <section className="carte">
        <header><h2>Journal d'audit (audit trail BPF / ISO 22716)</h2></header>
        <div className="corps sans-marge tableau-conteneur">
          {journal.enCours && !journal.donnees ? <Chargement /> : !journal.donnees?.length ? <Vide /> : (
            <table className="tableau">
              <thead><tr><th>Horodatage</th><th>Utilisateur</th><th>Action</th><th>Entite</th><th>Reference</th><th>Details</th></tr></thead>
              <tbody>
                {journal.donnees.map((l: any) => (
                  <tr key={l.id}>
                    <td>{fmtDateHeure(l.cree_le)}</td>
                    <td>{l.nom_complet ?? 'Systeme'}<div className="secondaire">{l.role ?? ''}</div></td>
                    <td><Badge valeur={l.action} classe="info" /></td>
                    <td className="secondaire">{l.entite}</td>
                    <td className="secondaire">{l.entite_id ?? '—'}</td>
                    <td className="secondaire" style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {JSON.stringify(l.details)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}

function CommandesAchat() {
  const liste = useChargement(() => api.get('/capacite/commandes-achat'));
  return (
    <section className="carte">
      <header><h2>Commandes d'achat generees</h2></header>
      <div className="corps sans-marge tableau-conteneur">
        {liste.enCours && !liste.donnees ? <Chargement /> : !liste.donnees?.length ? <Vide texte="Aucune commande d'achat." /> : (
          <table className="tableau">
            <thead><tr><th>Numero</th><th>Date</th><th>Fournisseur</th><th>Origine</th><th>Articles</th><th>Statut</th><th /></tr></thead>
            <tbody>
              {liste.donnees.map((c: any) => (
                <tr key={c.id}>
                  <td><strong>{c.numero}</strong></td>
                  <td>{fmtDate(c.date_commande)}</td>
                  <td>{c.fournisseur ?? '—'}</td>
                  <td className="secondaire">{c.origine ?? '—'}</td>
                  <td className="secondaire">{(c.lignes ?? []).map((l: any) => l.code_sku).join(', ')}</td>
                  <td><Badge valeur={c.statut} /></td>
                  <td><button className="bouton petit" onClick={() => api.ouvrirDocument(`/documents/commandes-achat/${c.id}`)}>Imprimer</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
