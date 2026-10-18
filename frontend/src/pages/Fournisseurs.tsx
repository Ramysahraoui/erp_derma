import { useState, type ReactNode } from 'react';
import { api, fmtDate, fmtDateHeure, fmtMontant, fmtNombre } from '../api';
import { useAuth } from '../auth';
import { Alerte, AlerteErreur, Badge, Champ, Chargement, Indicateur, Modale, Onglets, useChargement, Vide } from '../composants/Ui';

const LIBELLES_CHAMPS: Record<string, string> = {
  code: 'Code', raison_sociale: 'Raison sociale', contact: 'Contact', telephone: 'Telephone',
  email: 'E-mail', adresse: 'Adresse', actif: 'Actif',
};

export function Fournisseurs() {
  const { peut } = useAuth();
  const [recherche, setRecherche] = useState('');
  const [etat, setEtat] = useState('true');
  const [creation, setCreation] = useState(false);
  const [detail, setDetail] = useState<number | null>(null);
  const filtres = { ...(recherche ? { recherche } : {}), ...(etat ? { actif: etat } : {}) };
  const liste = useChargement(() => api.get(`/fournisseurs?${new URLSearchParams(filtres)}`), [recherche, etat]);
  const ecriture = peut('achat:ecrire') || peut('depense:ecrire');

  return (
    <>
      <div className="barre-filtres">
        <Champ libelle="Recherche">
          <input value={recherche} onChange={(e) => setRecherche(e.target.value)} placeholder="Code, raison sociale ou contact" />
        </Champ>
        <Champ libelle="Etat">
          <select value={etat} onChange={(e) => setEtat(e.target.value)}>
            <option value="true">Actifs</option><option value="false">Desactives</option><option value="">Tous</option>
          </select>
        </Champ>
        <div style={{ flex: 1 }} />
        {ecriture && <button className="bouton primaire" onClick={() => setCreation(true)}>Nouveau fournisseur</button>}
      </div>

      <section className="carte">
        <div className="corps sans-marge tableau-conteneur">
          {liste.enCours && !liste.donnees ? <Chargement /> : liste.erreur ? <AlerteErreur erreur={liste.erreur} /> :
            !liste.donnees?.length ? (
              <Vide texte={etat === 'true' && !recherche
                ? 'Aucun fournisseur enregistre. Utilisez « Nouveau fournisseur » pour creer le premier.'
                : 'Aucun fournisseur ne correspond.'} />
            ) : (
            <table className="tableau">
              <thead><tr><th>Code</th><th>Raison sociale</th><th>Contact</th><th>Telephone</th><th>E-mail</th>
                <th className="num">Receptions</th><th>Derniere reception</th><th>Etat</th></tr></thead>
              <tbody>
                {liste.donnees.map((f: any) => (
                  <tr key={f.id} className="cliquable" onClick={() => setDetail(f.id)}>
                    <td><strong>{f.code}</strong></td>
                    <td>{f.raison_sociale}{f.adresse && <div className="secondaire">{f.adresse}</div>}</td>
                    <td>{f.contact ?? '—'}</td>
                    <td>{f.telephone ?? '—'}</td>
                    <td>{f.email ?? '—'}</td>
                    <td className="num">{f.nb_receptions}</td>
                    <td>{fmtDate(f.derniere_reception)}</td>
                    <td>{f.actif ? <Badge valeur="ACTIF" classe="succes" /> : <Badge valeur="DESACTIVE" classe="danger" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {creation && (
        <ModaleFournisseur onFermer={() => setCreation(false)}
          onEnregistre={(f) => { setCreation(false); liste.recharger(); setDetail(f.id); }} />
      )}
      {detail && <ModaleDetailFournisseur id={detail} onFermer={() => setDetail(null)} onMaj={liste.recharger} />}
    </>
  );
}

/** Creation (sans `fournisseur`) ou modification d'une fiche. Reutilisee depuis le formulaire de reception. */
export function ModaleFournisseur({ fournisseur, onFermer, onEnregistre }: {
  fournisseur?: any; onFermer: () => void; onEnregistre: (f: any) => void;
}) {
  const initial = { code: '', raison_sociale: '', contact: '', telephone: '', email: '', adresse: '' };
  const [form, setForm] = useState<Record<string, string>>(
    fournisseur ? Object.fromEntries(Object.keys(initial).map((k) => [k, fournisseur[k] ?? ''])) : initial,
  );
  const [erreur, setErreur] = useState<unknown>(null);
  const [envoi, setEnvoi] = useState(false);
  const maj = (c: string, v: string) => setForm({ ...form, [c]: v });

  const enregistrer = async () => {
    setErreur(null); setEnvoi(true);
    try {
      const f = fournisseur
        ? await api.patch(`/fournisseurs/${fournisseur.id}`, form)
        : await api.post('/fournisseurs', form);
      onEnregistre(f);
    } catch (e) { setErreur(e); } finally { setEnvoi(false); }
  };

  return (
    <Modale titre={fournisseur ? `Modifier ${fournisseur.code}` : 'Nouveau fournisseur'} onFermer={onFermer}
      actions={<><button className="bouton" onClick={onFermer}>Annuler</button>
        <button className="bouton primaire" onClick={enregistrer} disabled={envoi || !form.code.trim() || !form.raison_sociale.trim()}>
          {fournisseur ? 'Enregistrer les modifications' : 'Creer le fournisseur'}</button></>}>
      <AlerteErreur erreur={erreur} />
      <div className="ligne-champs">
        <Champ libelle="Code" obligatoire aide="Identifiant court et unique, ex. FRN-001">
          <input value={form.code} onChange={(e) => maj('code', e.target.value.toUpperCase())} autoFocus />
        </Champ>
        <Champ libelle="Raison sociale" obligatoire>
          <input value={form.raison_sociale} onChange={(e) => maj('raison_sociale', e.target.value)} />
        </Champ>
      </div>
      <div className="ligne-champs" style={{ marginTop: 12 }}>
        <Champ libelle="Contact"><input value={form.contact} onChange={(e) => maj('contact', e.target.value)} /></Champ>
        <Champ libelle="Telephone"><input value={form.telephone} onChange={(e) => maj('telephone', e.target.value)} /></Champ>
        <Champ libelle="E-mail"><input type="email" value={form.email} onChange={(e) => maj('email', e.target.value)} /></Champ>
      </div>
      <div className="ligne-champs" style={{ marginTop: 12 }}>
        <Champ libelle="Adresse"><textarea value={form.adresse} onChange={(e) => maj('adresse', e.target.value)} /></Champ>
      </div>
    </Modale>
  );
}

function ModaleDetailFournisseur({ id, onFermer, onMaj }: { id: number; onFermer: () => void; onMaj: () => void }) {
  const { peut } = useAuth();
  const detail = useChargement(() => api.get(`/fournisseurs/${id}`), [id]);
  const [onglet, setOnglet] = useState('receptions');
  const [edition, setEdition] = useState(false);
  const [erreur, setErreur] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const ecriture = peut('achat:ecrire') || peut('depense:ecrire');

  if (detail.enCours && !detail.donnees) return <Modale titre="Fournisseur" onFermer={onFermer}><Chargement /></Modale>;
  if (detail.erreur) return <Modale titre="Fournisseur" onFermer={onFermer}><AlerteErreur erreur={detail.erreur} /></Modale>;
  const f = detail.donnees!;

  const apresMaj = (r: any) => {
    setMessage(r.modifications_enregistrees ? `${r.modifications_enregistrees} modification(s) enregistree(s) et tracee(s).` : 'Aucune modification.');
    detail.recharger(); onMaj();
  };

  const basculer = async () => {
    setErreur(null); setMessage(null);
    try { apresMaj(await api.patch(`/fournisseurs/${id}`, { actif: !f.actif })); }
    catch (e) { setErreur(e); }
  };

  const onglets = [
    { cle: 'receptions', libelle: `Receptions (${f.receptions.length})` },
    { cle: 'lots', libelle: `Lots (${f.lots.length})` },
    ...(f.commandes ? [{ cle: 'commandes', libelle: `Commandes d'achat (${f.commandes.length})` }] : []),
    ...(f.depenses ? [{ cle: 'depenses', libelle: `Depenses (${f.depenses.length})` }] : []),
    { cle: 'historique', libelle: 'Historique des modifications' },
  ];

  return (
    <Modale large titre={`${f.code} — ${f.raison_sociale}`} onFermer={onFermer}>
      <AlerteErreur erreur={erreur} />
      {message && <Alerte type="succes">{message}</Alerte>}
      {!f.actif && (
        <Alerte type="attention" titre="Fournisseur desactive">
          Il n'est plus propose dans les receptions, les depenses et les commandes. Son historique reste consultable.
        </Alerte>
      )}

      <div className="grille quatre" style={{ marginBottom: 16 }}>
        <Indicateur libelle="Contact" valeur={f.contact ?? '—'} detail={f.telephone ?? undefined} />
        <Indicateur libelle="E-mail" valeur={<span style={{ fontSize: '0.8em', wordBreak: 'break-all' }}>{f.email ?? '—'}</span>} />
        <Indicateur libelle="Receptions" valeur={f.receptions.length}
          detail={f.receptions[0] ? `Derniere le ${fmtDate(f.receptions[0].date_reception)}` : 'Aucune'} />
        <Indicateur libelle="Etat" valeur={f.actif ? 'Actif' : 'Desactive'} ton={f.actif ? 'succes' : 'danger'}
          detail={`Cree le ${fmtDate(f.cree_le)}`} />
      </div>
      {f.adresse && <p className="secondaire" style={{ marginTop: 0 }}>Adresse : {f.adresse}</p>}

      {ecriture && (
        <div className="actions" style={{ marginBottom: 16 }}>
          <button className="bouton" onClick={() => { setMessage(null); setEdition(true); }}>Modifier la fiche</button>
          <button className={`bouton ${f.actif ? 'danger' : ''}`} onClick={basculer}>
            {f.actif ? 'Desactiver le fournisseur' : 'Reactiver le fournisseur'}
          </button>
        </div>
      )}

      <Onglets actif={onglet} onChange={setOnglet} onglets={onglets} />

      {onglet === 'receptions' && (
        <Tableau vide="Aucune reception." entetes={['Numero', 'Date', 'BL fournisseur', 'Lots']} lignes={f.receptions.map((r: any) => [
          <strong>{r.numero}</strong>, fmtDate(r.date_reception), r.reference_bl_fournisseur ?? '—', r.nb_lots,
        ])} />
      )}
      {onglet === 'lots' && (
        <Tableau vide="Aucun lot." entetes={['Lot interne', 'Article', 'Lot fournisseur', 'DLUO', 'Stock', 'Statut']}
          lignes={f.lots.map((l: any) => [
            <strong>{l.code_lot_interne}</strong>, <>{l.code_sku}<div className="secondaire">{l.designation}</div></>,
            l.code_lot_fournisseur ?? '—', fmtDate(l.dluo), `${fmtNombre(l.qte_actuelle)} ${l.unite}`, <Badge valeur={l.statut} />,
          ])} />
      )}
      {onglet === 'commandes' && (
        <Tableau vide="Aucune commande d'achat." entetes={['Numero', 'Date', 'Statut', 'Total HT']} lignes={f.commandes.map((c: any) => [
          <strong>{c.numero}</strong>, fmtDate(c.date_commande), <Badge valeur={c.statut} />, fmtMontant(c.total_ht),
        ])} />
      )}
      {onglet === 'depenses' && (
        <Tableau vide="Aucune depense." entetes={['Numero', 'Date', 'Libelle', 'Montant TTC']} lignes={f.depenses.map((d: any) => [
          <strong>{d.numero}</strong>, fmtDate(d.date_depense), d.libelle, fmtMontant(d.montant_ttc),
        ])} />
      )}
      {onglet === 'historique' && (
        <Tableau vide="Aucune modification depuis la creation." entetes={['Date', 'Utilisateur', 'Champ', 'Ancienne valeur', 'Nouvelle valeur']}
          lignes={f.modifications.map((m: any) => [
            fmtDateHeure(m.cree_le), m.utilisateur ?? '—', LIBELLES_CHAMPS[m.champ] ?? m.champ,
            valeurLisible(m.champ, m.ancienne_valeur), <strong>{valeurLisible(m.champ, m.nouvelle_valeur)}</strong>,
          ])} />
      )}

      {edition && (
        <ModaleFournisseur fournisseur={f} onFermer={() => setEdition(false)}
          onEnregistre={(r) => { setEdition(false); apresMaj(r); }} />
      )}
    </Modale>
  );
}

const valeurLisible = (champ: string, v: string | null) =>
  v === null || v === '' ? '—' : champ === 'actif' ? (v === 'true' ? 'oui' : 'non') : v;

function Tableau({ entetes, lignes, vide }: { entetes: string[]; lignes: ReactNode[][]; vide: string }) {
  return (
    <div className="tableau-conteneur">
      <table className="tableau">
        <thead><tr>{entetes.map((e) => <th key={e}>{e}</th>)}</tr></thead>
        <tbody>
          {lignes.map((cellules, i) => <tr key={i}>{cellules.map((c, j) => <td key={j}>{c}</td>)}</tr>)}
          {!lignes.length && <tr><td colSpan={entetes.length}><Vide texte={vide} /></td></tr>}
        </tbody>
      </table>
    </div>
  );
}
