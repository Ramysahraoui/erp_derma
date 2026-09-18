import { useState } from 'react';
import { api, aujourdhui, fmtDate, fmtMontant } from '../api';
import { useAuth } from '../auth';
import { Alerte, AlerteErreur, Badge, Champ, Chargement, Indicateur, Modale, Onglets, useChargement, Vide } from '../composants/Ui';

const TRANCHES = [
  { cle: 'NON_ECHUE', libelle: 'Non echues' },
  { cle: 'ECHUE_1_30', libelle: 'Echues 1 a 30 jours' },
  { cle: 'ECHUE_31_60', libelle: 'Echues 31 a 60 jours' },
  { cle: 'ECHUE_PLUS_60', libelle: 'Echues > 60 jours' },
];

export function Recouvrement() {
  const { peut } = useAuth();
  const [onglet, setOnglet] = useState('balance');
  const [saisie, setSaisie] = useState(false);
  const tdb = useChargement(() => api.get('/recouvrement/tableau-de-bord'));
  const encaissements = useChargement(() => api.get('/recouvrement/encaissements'));

  if (tdb.enCours && !tdb.donnees) return <Chargement />;
  if (tdb.erreur) return <AlerteErreur erreur={tdb.erreur} />;
  const d = tdb.donnees!;

  return (
    <>
      <div className="grille quatre" style={{ marginBottom: 16 }}>
        {TRANCHES.map((t, i) => (
          <Indicateur key={t.cle} libelle={t.libelle} valeur={fmtMontant(d.balance.totaux[t.cle])}
            ton={i === 3 ? 'danger' : i === 2 ? 'alerte' : i === 0 ? 'succes' : undefined} />
        ))}
      </div>

      <div className="barre-filtres">
        <div style={{ flex: 1 }} />
        {peut('encaissement:ecrire') && <button className="bouton primaire" onClick={() => setSaisie(true)}>Saisir un encaissement</button>}
      </div>

      <Onglets actif={onglet} onChange={setOnglet} onglets={[
        { cle: 'balance', libelle: 'Balance agee' },
        { cle: 'clients', libelle: 'Par client' },
        { cle: 'encaissements', libelle: 'Encaissements' },
        { cle: 'cheques', libelle: 'Cheques en circulation' },
        { cle: 'risque', libelle: 'Clients a risque' },
      ]} />

      {onglet === 'balance' && (
        <section className="carte">
          <header><h2>Creances par facture — total {fmtMontant(d.balance.totaux.TOTAL)}</h2></header>
          <div className="corps sans-marge tableau-conteneur">
            {!d.balance.lignes.length ? <Vide texte="Aucune creance en cours." /> : (
              <table className="tableau">
                <thead><tr><th>Facture</th><th>Client</th><th>Date</th><th>Echeance</th>
                  <th className="num">Retard</th><th className="num">Total TTC</th><th className="num">Regle</th>
                  <th className="num">Solde du</th><th>Tranche</th></tr></thead>
                <tbody>
                  {d.balance.lignes.map((l: any) => (
                    <tr key={l.document_id} className={l.tranche === 'ECHUE_PLUS_60' ? 'limitant' : undefined}>
                      <td><strong>{l.numero_piece}</strong></td>
                      <td>{l.raison_sociale}</td>
                      <td>{fmtDate(l.date_doc)}</td>
                      <td>{fmtDate(l.date_echeance)}</td>
                      <td className="num">{l.jours_retard > 0 ? `${l.jours_retard} j` : '—'}</td>
                      <td className="num">{fmtMontant(l.total_ttc)}</td>
                      <td className="num">{fmtMontant(l.montant_paye)}</td>
                      <td className="num"><strong>{fmtMontant(l.solde_du)}</strong></td>
                      <td><Badge valeur={l.tranche} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {onglet === 'clients' && (
        <section className="carte">
          <div className="corps sans-marge tableau-conteneur">
            <table className="tableau">
              <thead><tr><th>Client</th>{TRANCHES.map((t) => <th key={t.cle} className="num">{t.libelle}</th>)}<th className="num">Total</th></tr></thead>
              <tbody>
                {d.balance.par_client.map((c: any) => (
                  <tr key={c.client_id}>
                    <td><strong>{c.raison_sociale}</strong></td>
                    {TRANCHES.map((t) => <td key={t.cle} className="num">{fmtMontant(c.tranches[t.cle])}</td>)}
                    <td className="num"><strong>{fmtMontant(c.total)}</strong></td>
                  </tr>
                ))}
                {!d.balance.par_client.length && <tr><td colSpan={6}><Vide /></td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {onglet === 'encaissements' && (
        <section className="carte">
          <header><h2>Encaissements — {fmtMontant(d.encaissements_du_mois.total)} ce mois</h2></header>
          <div className="corps sans-marge tableau-conteneur">
            {encaissements.enCours && !encaissements.donnees ? <Chargement /> : !encaissements.donnees?.length ? <Vide /> : (
              <table className="tableau">
                <thead><tr><th>Numero</th><th>Client</th><th>Date</th><th>Mode</th>
                  <th className="num">Montant</th><th className="num">Affecte</th><th>Factures apurees</th></tr></thead>
                <tbody>
                  {encaissements.donnees.map((e: any) => (
                    <tr key={e.id}>
                      <td><strong>{e.numero}</strong></td>
                      <td>{e.raison_sociale}</td>
                      <td>{fmtDate(e.date_reglement)}</td>
                      <td><Badge valeur={e.mode_reglement} classe="info" />{e.cheque_statut && <> <Badge valeur={e.cheque_statut} /></>}</td>
                      <td className="num">{fmtMontant(e.montant_verse)}</td>
                      <td className="num">{fmtMontant(e.montant_affecte)}</td>
                      <td className="secondaire">{(e.affectations ?? []).map((a: any) => a.numero_piece).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {onglet === 'cheques' && (
        <section className="carte">
          <header><h2>Cheques recus, deposes ou impayes</h2></header>
          <div className="corps sans-marge tableau-conteneur">
            {!d.cheques_en_cours.length ? <Vide texte="Aucun cheque en circulation." /> : (
              <table className="tableau">
                <thead><tr><th>Numero</th><th>Client</th><th>Cheque</th><th>Banque</th><th>Emission</th>
                  <th>Encaissement prevu</th><th className="num">Montant</th><th>Statut</th><th /></tr></thead>
                <tbody>
                  {d.cheques_en_cours.map((c: any) => (
                    <tr key={c.id}>
                      <td><strong>{c.numero}</strong></td>
                      <td>{c.raison_sociale}</td>
                      <td>{c.cheque_numero}</td>
                      <td>{c.cheque_banque ?? '—'}</td>
                      <td>{fmtDate(c.cheque_date_emission)}</td>
                      <td>{fmtDate(c.cheque_date_encaissement_prev)}</td>
                      <td className="num">{fmtMontant(c.montant_verse)}</td>
                      <td><Badge valeur={c.cheque_statut} /></td>
                      <td>
                        {peut('encaissement:ecrire') && (
                          <div className="actions">
                            {c.cheque_statut === 'RECU' && <button className="bouton petit" onClick={() => api.post(`/recouvrement/encaissements/${c.id}/cheque`, { statut: 'DEPOSE' }).then(tdb.recharger)}>Depose</button>}
                            {c.cheque_statut !== 'ENCAISSE' && <button className="bouton petit primaire" onClick={() => api.post(`/recouvrement/encaissements/${c.id}/cheque`, { statut: 'ENCAISSE' }).then(tdb.recharger)}>Encaisse</button>}
                            {c.cheque_statut !== 'IMPAYE' && <button className="bouton petit danger" onClick={() => api.post(`/recouvrement/encaissements/${c.id}/cheque`, { statut: 'IMPAYE' }).then(tdb.recharger)}>Impaye</button>}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {onglet === 'risque' && (
        <section className="carte">
          <header><h2>Clients proches ou au-dela de leur plafond</h2></header>
          <div className="corps sans-marge tableau-conteneur">
            {!d.clients_a_risque.length ? <Vide texte="Aucun client en depassement." /> : (
              <table className="tableau">
                <thead><tr><th>Client</th><th className="num">Plafond</th><th className="num">Encours factures</th>
                  <th className="num">Livre non facture</th><th className="num">Encours echu</th><th>Etat</th></tr></thead>
                <tbody>
                  {d.clients_a_risque.map((c: any) => {
                    const total = Number(c.encours_facture) + Number(c.encours_livre_non_facture);
                    return (
                      <tr key={c.client_id} className={total > Number(c.plafond_credit) ? 'limitant' : undefined}>
                        <td><strong>{c.raison_sociale}</strong><div className="secondaire">{c.code}</div></td>
                        <td className="num">{fmtMontant(c.plafond_credit)}</td>
                        <td className="num">{fmtMontant(c.encours_facture)}</td>
                        <td className="num">{fmtMontant(c.encours_livre_non_facture)}</td>
                        <td className="num">{fmtMontant(c.encours_echu)}</td>
                        <td><Badge valeur={total > Number(c.plafond_credit) ? 'DEPASSEMENT' : 'VIGILANCE'}
                          classe={total > Number(c.plafond_credit) ? 'danger' : 'alerte'} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {saisie && <ModaleEncaissement onFermer={() => setSaisie(false)} onCree={() => { setSaisie(false); tdb.recharger(); encaissements.recharger(); }} />}
    </>
  );
}

function ModaleEncaissement({ onFermer, onCree }: { onFermer: () => void; onCree: () => void }) {
  const clients = useChargement(() => api.get('/clients'));
  const [clientId, setClientId] = useState('');
  const [form, setForm] = useState<any>({ mode_reglement: 'VIREMENT', date_reglement: aujourdhui(), montant_verse: '', cheque_statut: 'RECU' });
  const [affectations, setAffectations] = useState<Record<number, string>>({});
  const [erreur, setErreur] = useState<unknown>(null);
  const factures = useChargement(
    () => (clientId ? api.get(`/recouvrement/factures-ouvertes/${clientId}`) : Promise.resolve([])),
    [clientId],
  );

  const totalAffecte = Object.values(affectations).reduce((t, v) => t + Number(v || 0), 0);

  const enregistrer = async () => {
    setErreur(null);
    try {
      await api.post('/recouvrement/encaissements', {
        client_id: Number(clientId),
        montant_verse: Number(form.montant_verse),
        mode_reglement: form.mode_reglement,
        date_reglement: form.date_reglement,
        cheque_numero: form.cheque_numero || null,
        cheque_banque: form.cheque_banque || null,
        cheque_date_emission: form.cheque_date_emission || null,
        cheque_date_encaissement_prev: form.cheque_date_encaissement_prev || null,
        cheque_statut: form.mode_reglement === 'CHEQUE' ? form.cheque_statut : null,
        reference: form.reference || null,
        affectations: Object.entries(affectations)
          .filter(([, v]) => Number(v) > 0)
          .map(([documentId, montant]) => ({ document_id: Number(documentId), montant_affecte: Number(montant) })),
      });
      onCree();
    } catch (e) { setErreur(e); }
  };

  return (
    <Modale large titre="Saisie d'un encaissement" onFermer={onFermer}
      actions={<><button className="bouton" onClick={onFermer}>Annuler</button>
        <button className="bouton primaire" onClick={enregistrer} disabled={!clientId || !form.montant_verse}>Enregistrer</button></>}>
      <AlerteErreur erreur={erreur} />
      <div className="ligne-champs">
        <Champ libelle="Client" obligatoire>
          <select value={clientId} onChange={(e) => { setClientId(e.target.value); setAffectations({}); }}>
            <option value="">Selectionner…</option>
            {(clients.donnees ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.code} — {c.raison_sociale}</option>)}
          </select>
        </Champ>
        <Champ libelle="Mode de reglement" obligatoire>
          <select value={form.mode_reglement} onChange={(e) => setForm({ ...form, mode_reglement: e.target.value })}>
            <option value="ESPECES">Especes</option>
            <option value="CHEQUE">Cheque bancaire</option>
            <option value="VIREMENT">Virement bancaire</option>
          </select>
        </Champ>
        <Champ libelle="Montant verse" obligatoire>
          <input type="number" step="0.01" value={form.montant_verse} onChange={(e) => setForm({ ...form, montant_verse: e.target.value })} />
        </Champ>
        <Champ libelle="Date de reglement">
          <input type="date" value={form.date_reglement} onChange={(e) => setForm({ ...form, date_reglement: e.target.value })} />
        </Champ>
      </div>

      {form.mode_reglement === 'CHEQUE' && (
        <div className="ligne-champs" style={{ marginTop: 12 }}>
          <Champ libelle="Numero de cheque" obligatoire><input value={form.cheque_numero ?? ''} onChange={(e) => setForm({ ...form, cheque_numero: e.target.value })} /></Champ>
          <Champ libelle="Banque"><input value={form.cheque_banque ?? ''} onChange={(e) => setForm({ ...form, cheque_banque: e.target.value })} /></Champ>
          <Champ libelle="Date d'emission" obligatoire><input type="date" value={form.cheque_date_emission ?? ''} onChange={(e) => setForm({ ...form, cheque_date_emission: e.target.value })} /></Champ>
          <Champ libelle="Encaissement previsionnel"><input type="date" value={form.cheque_date_encaissement_prev ?? ''} onChange={(e) => setForm({ ...form, cheque_date_encaissement_prev: e.target.value })} /></Champ>
          <Champ libelle="Statut">
            <select value={form.cheque_statut} onChange={(e) => setForm({ ...form, cheque_statut: e.target.value })}>
              <option value="RECU">Recu</option><option value="DEPOSE">Depose</option><option value="ENCAISSE">Encaisse</option>
            </select>
          </Champ>
        </div>
      )}

      <h3 style={{ margin: '18px 0 8px' }}>Affectation aux factures ouvertes</h3>
      <Alerte type="info">
        Un meme reglement peut apurer plusieurs factures, ou n'en solder qu'une partie.
        Affecte : {fmtMontant(totalAffecte)} sur {fmtMontant(form.montant_verse || 0)}.
      </Alerte>
      <div className="tableau-conteneur">
        <table className="tableau">
          <thead><tr><th>Facture</th><th>Echeance</th><th className="num">Retard</th><th className="num">Solde du</th>
            <th className="num">Montant a affecter</th></tr></thead>
          <tbody>
            {(factures.donnees ?? []).map((f: any) => (
              <tr key={f.id}>
                <td><strong>{f.numero_piece}</strong><div className="secondaire">{fmtDate(f.date_doc)}</div></td>
                <td>{fmtDate(f.date_echeance)}</td>
                <td className="num">{f.jours_retard > 0 ? `${f.jours_retard} j` : '—'}</td>
                <td className="num">{fmtMontant(f.solde_du)}</td>
                <td className="num">
                  <input type="number" step="0.01" style={{ textAlign: 'right' }} value={affectations[f.id] ?? ''}
                    onChange={(e) => setAffectations({ ...affectations, [f.id]: e.target.value })} />
                  <button className="bouton petit" style={{ marginTop: 4 }}
                    onClick={() => setAffectations({ ...affectations, [f.id]: String(f.solde_du) })}>Solder</button>
                </td>
              </tr>
            ))}
            {clientId && !(factures.donnees ?? []).length && <tr><td colSpan={5}><Vide texte="Aucune facture ouverte pour ce client." /></td></tr>}
          </tbody>
        </table>
      </div>
    </Modale>
  );
}
