import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, fmtDate, fmtDateHeure, fmtMontant, fmtNombre } from '../api';
import { useAuth } from '../auth';
import { Alerte, AlerteErreur, Badge, Champ, Chargement, Modale, useChargement, Vide } from '../composants/Ui';

export function Lots() {
  const { peut } = useAuth();
  const [params, setParams] = useSearchParams();
  const [recherche, setRecherche] = useState('');
  const statut = params.get('statut') ?? '';
  const type = params.get('type') ?? '';

  const liste = useChargement(
    () => api.get(`/lots?${new URLSearchParams({ ...(statut ? { statut } : {}), ...(type ? { type } : {}), ...(recherche ? { recherche } : {}) })}`),
    [statut, type, recherche],
  );
  const [detail, setDetail] = useState<number | null>(null);
  const [journal, setJournal] = useState(false);

  return (
    <>
      <div className="barre-filtres">
        <Champ libelle="Recherche">
          <input value={recherche} onChange={(e) => setRecherche(e.target.value)} placeholder="N° de lot interne ou fournisseur, article" />
        </Champ>
        <Champ libelle="Statut qualite">
          <select value={statut} onChange={(e) => setParams({ ...(type ? { type } : {}), ...(e.target.value ? { statut: e.target.value } : {}) })}>
            <option value="">Tous</option>
            <option value="QUARANTAINE">Quarantaine</option>
            <option value="CONFORME">Conforme</option>
            <option value="BLOQUE">Bloque</option>
            <option value="REJETE">Rejete</option>
          </select>
        </Champ>
        <Champ libelle="Categorie">
          <select value={type} onChange={(e) => setParams({ ...(statut ? { statut } : {}), ...(e.target.value ? { type: e.target.value } : {}) })}>
            <option value="">Toutes</option>
            <option value="MP">Matieres premieres</option>
            <option value="AC">Conditionnement</option>
            <option value="PF">Produits finis</option>
          </select>
        </Champ>
        <div style={{ flex: 1 }} />
        <button className="bouton" onClick={() => setJournal(true)}>Journal des mouvements</button>
      </div>

      <section className="carte">
        <div className="corps sans-marge tableau-conteneur">
          {liste.enCours && !liste.donnees ? <Chargement /> : liste.erreur ? <AlerteErreur erreur={liste.erreur} /> :
            !liste.donnees?.length ? <Vide texte="Aucun lot." /> : (
            <table className="tableau">
              <thead><tr><th>Lot interne</th><th>Article</th><th>Lot fournisseur</th><th>DLUO</th>
                <th className="num">Quantite</th><th>Statut</th><th>Origine</th><th /></tr></thead>
              <tbody>
                {liste.donnees.map((l: any) => (
                  <tr key={l.id} className={l.perime ? 'limitant' : undefined}>
                    <td className="cliquable" onClick={() => setDetail(l.id)}><strong>{l.code_lot_interne}</strong></td>
                    <td>{l.code_sku}<div className="secondaire">{l.designation}</div></td>
                    <td>{l.code_lot_fournisseur ?? '—'}</td>
                    <td>{fmtDate(l.dluo)}{l.perime && <div className="secondaire" style={{ color: 'var(--danger)' }}>Perime</div>}</td>
                    <td className="num">{fmtNombre(l.qte_actuelle)} {l.unite}</td>
                    <td><Badge valeur={l.statut} /></td>
                    <td className="secondaire">{l.code_lot_vrac ?? l.fournisseur ?? '—'}</td>
                    <td>
                      <div className="actions">
                        <button className="bouton petit" onClick={() => setDetail(l.id)}>Detail</button>
                        <button className="bouton petit" onClick={() => api.ouvrirDocument(`/documents/lots/${l.id}/etiquette`)}>Etiquette</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {journal && <ModaleJournal onFermer={() => setJournal(false)} />}
      {detail && <ModaleLot id={detail} onFermer={() => setDetail(null)} onMaj={liste.recharger} peutLiberer={peut('stock:liberer')} peutAjuster={peut('stock:ajuster')} />}
    </>
  );
}

function ModaleLot({ id, onFermer, onMaj, peutLiberer, peutAjuster }: {
  id: number; onFermer: () => void; onMaj: () => void; peutLiberer: boolean; peutAjuster: boolean;
}) {
  const detail = useChargement(() => api.get(`/lots/${id}`), [id]);
  const [erreur, setErreur] = useState<unknown>(null);
  const [motif, setMotif] = useState('');
  const [quantite, setQuantite] = useState('');
  const [sens, setSens] = useState<'AUGMENTER' | 'REDUIRE'>('AUGMENTER');
  const [motifAjustement, setMotifAjustement] = useState('');
  const [reintro, setReintro] = useState<{ statut_cible: 'QUARANTAINE' | 'CONFORME'; motif: string }>({ statut_cible: 'QUARANTAINE', motif: '' });
  const [message, setMessage] = useState<string | null>(null);

  if (detail.enCours && !detail.donnees) return <Modale titre="Lot" onFermer={onFermer}><Chargement /></Modale>;
  if (detail.erreur) return <Modale titre="Lot" onFermer={onFermer}><AlerteErreur erreur={detail.erreur} /></Modale>;
  const l = detail.donnees!;

  const changerStatut = async (statut: string) => {
    setErreur(null); setMessage(null);
    try {
      await api.post(`/lots/${id}/statut`, { statut, motif: motif || null });
      detail.recharger(); onMaj(); setMotif('');
    } catch (e) { setErreur(e); }
  };

  const ajuster = async () => {
    setErreur(null); setMessage(null);
    try {
      await api.post(`/lots/${id}/ajustement`, { sens, quantite: Number(quantite), motif: motifAjustement });
      setMessage(`Stock ${sens === 'AUGMENTER' ? 'augmente' : 'reduit'} de ${fmtNombre(quantite)} ${l.unite} — mouvement enregistre.`);
      detail.recharger(); onMaj(); setQuantite(''); setMotifAjustement('');
    } catch (e) { setErreur(e); }
  };

  const reintroduire = async () => {
    setErreur(null); setMessage(null);
    try {
      await api.post(`/lots/${id}/reintroduction`, reintro);
      setMessage(`Lot reintroduit en ${reintro.statut_cible === 'CONFORME' ? 'stock conforme' : 'quarantaine'} ; le rejet reste dans l'historique.`);
      detail.recharger(); onMaj(); setReintro({ statut_cible: 'QUARANTAINE', motif: '' });
    } catch (e) { setErreur(e); }
  };

  return (
    <Modale large titre={`Lot ${l.code_lot_interne}`} onFermer={onFermer}>
      {message && <Alerte type="succes">{message}</Alerte>}
      <AlerteErreur erreur={erreur} />
      <dl className="liste-descriptive">
        <dt>Article</dt><dd>{l.code_sku} — {l.designation}</dd>
        <dt>Statut</dt><dd><Badge valeur={l.statut} /></dd>
        <dt>Quantite</dt><dd>{fmtNombre(l.qte_actuelle)} / {fmtNombre(l.qte_initiale)} {l.unite}</dd>
        <dt>DLUO</dt><dd>{fmtDate(l.dluo)}</dd>
        <dt>Lot fournisseur</dt><dd>{l.code_lot_fournisseur ?? '—'} {l.fournisseur ? `(${l.fournisseur})` : ''}</dd>
        <dt>Reception</dt><dd>{l.numero_reception ?? '—'} du {fmtDate(l.date_reception)}</dd>
        {l.code_lot_vrac && <><dt>Lot de vrac d'origine</dt><dd>{l.code_lot_vrac}</dd></>}
        <dt>Cout unitaire</dt><dd>{fmtMontant(l.cout_unitaire)}</dd>
        <dt>Certificat d'analyse</dt>
        <dd>
          {l.coa_fichier
            ? <a href={`/fichiers/${l.coa_fichier}`} target="_blank" rel="noreferrer">Consulter</a>
            : <span style={{ color: 'var(--danger)' }}>Non joint{l.coa_absent_motif ? ` — ${l.coa_absent_motif}` : ''}</span>}
        </dd>
      </dl>

      {!l.coa_fichier && ['MP', 'AC'].includes(l.type) && (
        <Alerte type="info" titre="Certificat de conformite non joint">
          Le certificat est facultatif ; il peut etre ajoute a tout moment.
          {peutLiberer && (
            <div style={{ marginTop: 8 }}>
              <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={async (e) => {
                const fichier = e.target.files?.[0];
                if (!fichier) return;
                setErreur(null);
                try {
                  const televerse = await api.televerser(fichier);
                  await api.post(`/lots/${id}/coa`, { coa_fichier: televerse.fichier });
                  detail.recharger(); onMaj();
                } catch (err) { setErreur(err); }
              }} />
            </div>
          )}
        </Alerte>
      )}

      {peutLiberer && l.statut !== 'REJETE' && (
        <>
          <h3 style={{ marginTop: 18 }}>Decision qualite</h3>
          <Champ libelle="Motif de la decision">
            <input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Controle de reception conforme, analyse hors specification…" />
          </Champ>
          <div className="actions" style={{ marginTop: 10 }}>
            {l.statut !== 'CONFORME' && <button className="bouton primaire" onClick={() => changerStatut('CONFORME')}>Liberer (conforme)</button>}
            {l.statut !== 'BLOQUE' && <button className="bouton" onClick={() => changerStatut('BLOQUE')}>Bloquer</button>}
            <button className="bouton danger" onClick={() => changerStatut('REJETE')}>Rejeter</button>
          </div>
        </>
      )}

      {peutLiberer && l.statut === 'REJETE' && (
        <div className="carte" style={{ marginTop: 18, borderColor: 'var(--alerte)' }}>
          <div className="corps">
            <h3>Reintroduction du lot rejete</h3>
            <p className="secondaire" style={{ margin: '4px 0 10px' }}>
              Decision motivee et tracee ; le rejet initial reste visible dans l'historique des statuts.
            </p>
            <div className="ligne-champs">
              <Champ libelle="Statut apres reintroduction">
                <select value={reintro.statut_cible} onChange={(e) => setReintro({ ...reintro, statut_cible: e.target.value as 'QUARANTAINE' | 'CONFORME' })}>
                  <option value="QUARANTAINE">Quarantaine (nouveau controle)</option>
                  <option value="CONFORME">Conforme (utilisable immediatement)</option>
                </select>
              </Champ>
              <Champ libelle="Motif de la decision" obligatoire aide="10 caracteres minimum">
                <input value={reintro.motif} onChange={(e) => setReintro({ ...reintro, motif: e.target.value })}
                  placeholder="Contre-analyse conforme, derogation qualite n°…" />
              </Champ>
            </div>
            <div className="actions" style={{ marginTop: 10 }}>
              <button className="bouton primaire" onClick={reintroduire} disabled={reintro.motif.trim().length < 10}>Reintroduire en stock</button>
            </div>
          </div>
        </div>
      )}

      {peutAjuster && (
        <div className="carte" style={{ marginTop: 18 }}>
          <div className="corps">
            <h3>Ajustement de la quantite en stock</h3>
            <p className="secondaire" style={{ margin: '4px 0 10px' }}>
              Stock actuel : <strong>{fmtNombre(l.qte_actuelle)} {l.unite}</strong>. Chaque ajustement est enregistre comme un mouvement
              de stock (date, utilisateur, quantite, motif).
            </p>
            <div className="ligne-champs" style={{ alignItems: 'end' }}>
              <Champ libelle="Operation">
                <select value={sens} onChange={(e) => setSens(e.target.value as 'AUGMENTER' | 'REDUIRE')}>
                  <option value="AUGMENTER">Augmenter le stock</option>
                  <option value="REDUIRE">Reduire le stock</option>
                </select>
              </Champ>
              <Champ libelle={`Quantite (${l.unite})`} obligatoire>
                <input type="number" step="0.001" min="0" value={quantite} onChange={(e) => setQuantite(e.target.value)} />
              </Champ>
              <Champ libelle="Motif" obligatoire aide="Inventaire, casse, erreur de saisie…">
                <input value={motifAjustement} onChange={(e) => setMotifAjustement(e.target.value)} />
              </Champ>
            </div>
            {sens === 'REDUIRE' && Number(quantite) > Number(l.qte_actuelle) && (
              <div style={{ marginTop: 8 }}><Alerte type="erreur">La reduction depasse la quantite en stock.</Alerte></div>
            )}
            <div className="actions" style={{ marginTop: 10 }}>
              <button className="bouton primaire" onClick={ajuster}
                disabled={!(Number(quantite) > 0) || motifAjustement.trim().length < 5
                  || (sens === 'REDUIRE' && Number(quantite) > Number(l.qte_actuelle))}>
                Enregistrer l'ajustement
              </button>
            </div>
          </div>
        </div>
      )}

      <h3 style={{ marginTop: 20 }}>Historique des statuts</h3>
      <div className="tableau-conteneur">
        <table className="tableau">
          <thead><tr><th>Date</th><th>Evenement</th><th>Statut</th><th>Motif</th><th>Utilisateur</th></tr></thead>
          <tbody>
            {(l.historique_statuts ?? []).map((h: any) => (
              <tr key={h.id} className={h.nouveau_statut === 'REJETE' ? 'limitant' : undefined}>
                <td>{fmtDateHeure(h.cree_le)}</td>
                <td>{h.nature === 'REINTRODUCTION' ? <Badge valeur="REINTRODUCTION" classe="alerte" />
                  : h.nature === 'RECEPTION' ? 'Reception' : 'Changement de statut'}</td>
                <td>{h.ancien_statut ? <><Badge valeur={h.ancien_statut} /> → </> : null}<Badge valeur={h.nouveau_statut} /></td>
                <td className="secondaire">{h.motif ?? '—'}</td>
                <td className="secondaire">{h.utilisateur ?? '—'}</td>
              </tr>
            ))}
            {!(l.historique_statuts ?? []).length && <tr><td colSpan={5}><Vide texte="Aucun changement de statut." /></td></tr>}
          </tbody>
        </table>
      </div>

      <h3 style={{ marginTop: 20 }}>Historique des mouvements</h3>
      <div className="tableau-conteneur">
        <table className="tableau">
          <thead><tr><th>Date</th><th>Type</th><th className="num">Quantite</th><th>Motif</th><th>Utilisateur</th></tr></thead>
          <tbody>
            {l.mouvements.map((m: any) => (
              <tr key={m.id}>
                <td>{fmtDateHeure(m.date_mouvement)}</td>
                <td><Badge valeur={m.type_mouvement} classe={Number(m.quantite) > 0 ? 'succes' : 'alerte'} /></td>
                <td className="num">{fmtNombre(m.quantite)}</td>
                <td className="secondaire">{m.motif ?? '—'}</td>
                <td className="secondaire">{m.utilisateur ?? '—'}</td>
              </tr>
            ))}
            {l.mouvements.length === 0 && <tr><td colSpan={5}><Vide /></td></tr>}
          </tbody>
        </table>
      </div>
    </Modale>
  );
}

const TYPES_MOUVEMENT = ['AJUSTEMENT', 'ENTREE_RECEPTION', 'SORTIE_PRODUCTION', 'ENTREE_PRODUCTION', 'SORTIE_VENTE', 'ANNULATION'];

/** Journal des mouvements de stock (ajustements par defaut). */
function ModaleJournal({ onFermer }: { onFermer: () => void }) {
  const [type, setType] = useState('AJUSTEMENT');
  const mouvements = useChargement(
    () => api.get(`/stock/mouvements?${new URLSearchParams({ limite: '300', ...(type ? { type_mouvement: type } : {}) })}`),
    [type],
  );
  return (
    <Modale large titre="Journal des mouvements de stock" onFermer={onFermer}>
      <div className="barre-filtres">
        <Champ libelle="Type de mouvement">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Tous</option>
            {TYPES_MOUVEMENT.map((t) => <option key={t} value={t}>{t.replaceAll('_', ' ').toLowerCase()}</option>)}
          </select>
        </Champ>
      </div>
      <div className="tableau-conteneur" style={{ maxHeight: 480, overflowY: 'auto' }}>
        {mouvements.enCours && !mouvements.donnees ? <Chargement /> : (
          <table className="tableau">
            <thead><tr><th>Date</th><th>Lot</th><th>Article</th><th>Type</th><th className="num">Quantite</th><th>Motif</th><th>Utilisateur</th></tr></thead>
            <tbody>
              {(mouvements.donnees ?? []).map((m: any) => (
                <tr key={m.id}>
                  <td>{fmtDateHeure(m.date_mouvement)}</td>
                  <td><strong>{m.code_lot_interne}</strong></td>
                  <td>{m.code_sku}<div className="secondaire">{m.designation}</div></td>
                  <td><Badge valeur={m.type_mouvement} classe={Number(m.quantite) > 0 ? 'succes' : 'alerte'} /></td>
                  <td className="num">{Number(m.quantite) > 0 ? '+' : ''}{fmtNombre(m.quantite)} {m.unite}</td>
                  <td className="secondaire">{m.motif ?? '—'}</td>
                  <td className="secondaire">{m.utilisateur ?? '—'}</td>
                </tr>
              ))}
              {!(mouvements.donnees ?? []).length && <tr><td colSpan={7}><Vide texte="Aucun mouvement." /></td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </Modale>
  );
}
