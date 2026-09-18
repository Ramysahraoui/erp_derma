import { useState } from 'react';
import { api, fmtDate, fmtMontant } from '../api';
import { useAuth } from '../auth';
import { Alerte, AlerteErreur, Badge, Champ, Chargement, Indicateur, Modale, useChargement, Vide } from '../composants/Ui';

export function Clients() {
  const { peut } = useAuth();
  const [recherche, setRecherche] = useState('');
  const [creation, setCreation] = useState(false);
  const [detail, setDetail] = useState<number | null>(null);
  const liste = useChargement(() => api.get(`/clients?${new URLSearchParams(recherche ? { recherche } : {})}`), [recherche]);

  return (
    <>
      <div className="barre-filtres">
        <Champ libelle="Recherche"><input value={recherche} onChange={(e) => setRecherche(e.target.value)} placeholder="Raison sociale ou code" /></Champ>
        <div style={{ flex: 1 }} />
        {peut('client:ecrire') && <button className="bouton primaire" onClick={() => setCreation(true)}>Nouveau client</button>}
      </div>

      <section className="carte">
        <div className="corps sans-marge tableau-conteneur">
          {liste.enCours && !liste.donnees ? <Chargement /> : liste.erreur ? <AlerteErreur erreur={liste.erreur} /> :
            !liste.donnees?.length ? <Vide /> : (
            <table className="tableau">
              <thead><tr><th>Code</th><th>Raison sociale</th><th className="num">Plafond de credit</th>
                <th className="num">Encours</th><th className="num">Dont echu</th><th className="num">Credit disponible</th>
                <th className="num">Delai</th><th>Etat</th></tr></thead>
              <tbody>
                {liste.donnees.map((c: any) => {
                  const depasse = Number(c.credit_disponible) < 0;
                  return (
                    <tr key={c.id} className={`cliquable ${depasse ? 'limitant' : ''}`} onClick={() => setDetail(c.id)}>
                      <td><strong>{c.code}</strong></td>
                      <td>{c.raison_sociale}<div className="secondaire">{c.categorie_tarif}</div></td>
                      <td className="num">{fmtMontant(c.plafond_credit)}</td>
                      <td className="num">{fmtMontant(c.encours_total)}</td>
                      <td className="num" style={Number(c.encours_echu) > 0 ? { color: 'var(--danger)' } : undefined}>{fmtMontant(c.encours_echu)}</td>
                      <td className="num">{fmtMontant(c.credit_disponible)}</td>
                      <td className="num">{c.delai_paiement_jours} j</td>
                      <td>{c.bloque ? <Badge valeur="BLOQUE" /> : <Badge valeur={depasse ? 'PLAFOND ATTEINT' : 'ACTIF'} classe={depasse ? 'danger' : 'succes'} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {creation && <ModaleClient onFermer={() => setCreation(false)} onCree={() => { setCreation(false); liste.recharger(); }} />}
      {detail && <ModaleDetailClient id={detail} onFermer={() => setDetail(null)} onMaj={liste.recharger} />}
    </>
  );
}

function ModaleClient({ onFermer, onCree }: { onFermer: () => void; onCree: () => void }) {
  const [form, setForm] = useState<any>({ plafond_credit: '0', delai_paiement_jours: '30', remise_pct: '0', categorie_tarif: 'STANDARD' });
  const [erreur, setErreur] = useState<unknown>(null);
  const maj = (c: string, v: string) => setForm({ ...form, [c]: v });

  const creer = async () => {
    setErreur(null);
    try {
      await api.post('/clients', {
        ...form,
        plafond_credit: Number(form.plafond_credit || 0),
        delai_paiement_jours: Number(form.delai_paiement_jours || 0),
        remise_pct: Number(form.remise_pct || 0),
        email: form.email || null,
      });
      onCree();
    } catch (e) { setErreur(e); }
  };

  return (
    <Modale titre="Nouveau client" onFermer={onFermer}
      actions={<><button className="bouton" onClick={onFermer}>Annuler</button>
        <button className="bouton primaire" onClick={creer}>Creer le client</button></>}>
      <AlerteErreur erreur={erreur} />
      <div className="ligne-champs">
        <Champ libelle="Code" obligatoire><input value={form.code ?? ''} onChange={(e) => maj('code', e.target.value.toUpperCase())} /></Champ>
        <Champ libelle="Raison sociale" obligatoire><input value={form.raison_sociale ?? ''} onChange={(e) => maj('raison_sociale', e.target.value)} /></Champ>
        <Champ libelle="Categorie tarifaire"><input value={form.categorie_tarif} onChange={(e) => maj('categorie_tarif', e.target.value)} /></Champ>
      </div>
      <div className="ligne-champs" style={{ marginTop: 12 }}>
        <Champ libelle="Registre de commerce"><input value={form.registre_commerce ?? ''} onChange={(e) => maj('registre_commerce', e.target.value)} /></Champ>
        <Champ libelle="NIF"><input value={form.nif ?? ''} onChange={(e) => maj('nif', e.target.value)} /></Champ>
        <Champ libelle="Telephone"><input value={form.telephone ?? ''} onChange={(e) => maj('telephone', e.target.value)} /></Champ>
        <Champ libelle="E-mail"><input type="email" value={form.email ?? ''} onChange={(e) => maj('email', e.target.value)} /></Champ>
      </div>
      <div className="ligne-champs" style={{ marginTop: 12 }}>
        <Champ libelle="Plafond d'encours autorise" obligatoire aide="0 = aucun controle de plafond">
          <input type="number" step="0.01" value={form.plafond_credit} onChange={(e) => maj('plafond_credit', e.target.value)} />
        </Champ>
        <Champ libelle="Delai de reglement (jours)">
          <select value={form.delai_paiement_jours} onChange={(e) => maj('delai_paiement_jours', e.target.value)}>
            <option value="0">Comptant</option><option value="30">30 jours</option><option value="60">60 jours</option>
          </select>
        </Champ>
        <Champ libelle="Remise habituelle (%)"><input type="number" step="0.001" value={form.remise_pct} onChange={(e) => maj('remise_pct', e.target.value)} /></Champ>
      </div>
      <div className="ligne-champs" style={{ marginTop: 12 }}>
        <Champ libelle="Adresse de facturation"><textarea value={form.adresse_facturation ?? ''} onChange={(e) => maj('adresse_facturation', e.target.value)} /></Champ>
        <Champ libelle="Adresse de livraison"><textarea value={form.adresse_livraison ?? ''} onChange={(e) => maj('adresse_livraison', e.target.value)} /></Champ>
      </div>
    </Modale>
  );
}

function ModaleDetailClient({ id, onFermer, onMaj }: { id: number; onFermer: () => void; onMaj: () => void }) {
  const { peut } = useAuth();
  const detail = useChargement(() => api.get(`/clients/${id}`), [id]);
  const [plafond, setPlafond] = useState<string | null>(null);
  const [erreur, setErreur] = useState<unknown>(null);

  if (detail.enCours && !detail.donnees) return <Modale titre="Client" onFermer={onFermer}><Chargement /></Modale>;
  const c = detail.donnees!;

  const enregistrer = async () => {
    setErreur(null);
    try {
      await api.patch(`/clients/${id}`, { plafond_credit: Number(plafond) });
      detail.recharger(); onMaj(); setPlafond(null);
    } catch (e) { setErreur(e); }
  };

  const basculerBlocage = async () => {
    setErreur(null);
    try { await api.patch(`/clients/${id}`, { bloque: !c.bloque }); detail.recharger(); onMaj(); }
    catch (e) { setErreur(e); }
  };

  return (
    <Modale large titre={`${c.code} — ${c.raison_sociale}`} onFermer={onFermer}>
      <AlerteErreur erreur={erreur} />
      <div className="grille quatre" style={{ marginBottom: 16 }}>
        <Indicateur libelle="Plafond autorise" valeur={fmtMontant(c.encours.plafond_credit)} />
        <Indicateur libelle="Encours total" valeur={fmtMontant(c.encours.encours_total)}
          detail={`Factures ${fmtMontant(c.encours.encours_facture)} · livre non facture ${fmtMontant(c.encours.encours_livre_non_facture)}`} />
        <Indicateur libelle="Encours echu" valeur={fmtMontant(c.encours.encours_echu)} ton="danger" />
        <Indicateur libelle="Credit disponible" valeur={fmtMontant(c.encours.disponible)}
          ton={Number(c.encours.disponible) < 0 ? 'danger' : 'succes'} />
      </div>

      {c.bloque && <Alerte type="erreur" titre="Compte bloque">Toute nouvelle livraison exige une autorisation administrateur.</Alerte>}

      {peut('client:ecrire') && (
        <div className="ligne-champs" style={{ alignItems: 'end', marginBottom: 16 }}>
          <Champ libelle="Plafond d'encours autorise">
            <input type="number" step="0.01" value={plafond ?? c.plafond_credit} onChange={(e) => setPlafond(e.target.value)} />
          </Champ>
          <button className="bouton" onClick={enregistrer} disabled={plafond === null}>Mettre a jour le plafond</button>
          <button className={`bouton ${c.bloque ? '' : 'danger'}`} onClick={basculerBlocage}>
            {c.bloque ? 'Debloquer le compte' : 'Bloquer le compte'}
          </button>
        </div>
      )}

      <h3>Historique documentaire</h3>
      <div className="tableau-conteneur">
        <table className="tableau">
          <thead><tr><th>Piece</th><th>Type</th><th>Date</th><th>Echeance</th><th className="num">Total TTC</th>
            <th className="num">Regle</th><th>Statut</th></tr></thead>
          <tbody>
            {c.documents.map((d: any) => (
              <tr key={d.id}>
                <td><strong>{d.numero_piece}</strong></td>
                <td><Badge valeur={d.type_doc} classe="info" /></td>
                <td>{fmtDate(d.date_doc)}</td>
                <td>{fmtDate(d.date_echeance)}</td>
                <td className="num">{fmtMontant(d.total_ttc)}</td>
                <td className="num">{fmtMontant(d.montant_paye)}</td>
                <td><Badge valeur={d.statut === 'VALIDE' && d.type_doc === 'FACTURE' ? d.statut_paiement : d.statut} /></td>
              </tr>
            ))}
            {!c.documents.length && <tr><td colSpan={7}><Vide texte="Aucun document." /></td></tr>}
          </tbody>
        </table>
      </div>
    </Modale>
  );
}
