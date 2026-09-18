import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, fmtDate, fmtDateHeure, fmtMontant, fmtNombre } from '../api';
import { useAuth } from '../auth';
import { AlerteErreur, Badge, Champ, Chargement, Modale, useChargement, Vide } from '../composants/Ui';

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

  if (detail.enCours && !detail.donnees) return <Modale titre="Lot" onFermer={onFermer}><Chargement /></Modale>;
  if (detail.erreur) return <Modale titre="Lot" onFermer={onFermer}><AlerteErreur erreur={detail.erreur} /></Modale>;
  const l = detail.donnees!;

  const changerStatut = async (statut: string) => {
    setErreur(null);
    try {
      await api.post(`/lots/${id}/statut`, { statut, motif: motif || null });
      detail.recharger(); onMaj(); setMotif('');
    } catch (e) { setErreur(e); }
  };

  const ajuster = async () => {
    setErreur(null);
    try {
      await api.post(`/lots/${id}/ajustement`, { quantite: Number(quantite), motif });
      detail.recharger(); onMaj(); setQuantite(''); setMotif('');
    } catch (e) { setErreur(e); }
  };

  return (
    <Modale large titre={`Lot ${l.code_lot_interne}`} onFermer={onFermer}>
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
        <dd>{l.coa_fichier ? <a href={`/fichiers/${l.coa_fichier}`} target="_blank" rel="noreferrer">Consulter</a> : 'Non joint'}</dd>
      </dl>

      {(peutLiberer || peutAjuster) && l.statut !== 'REJETE' && (
        <>
          <h3 style={{ marginTop: 18 }}>Decision qualite / correction</h3>
          <Champ libelle="Motif" aide="Obligatoire pour un ajustement de stock (audit trail)">
            <input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Certificat d'analyse conforme, inventaire physique…" />
          </Champ>
          <div className="actions" style={{ marginTop: 10 }}>
            {peutLiberer && l.statut !== 'CONFORME' && <button className="bouton primaire" onClick={() => changerStatut('CONFORME')}>Liberer (conforme)</button>}
            {peutLiberer && l.statut !== 'BLOQUE' && <button className="bouton" onClick={() => changerStatut('BLOQUE')}>Bloquer</button>}
            {peutLiberer && <button className="bouton danger" onClick={() => changerStatut('REJETE')}>Rejeter definitivement</button>}
          </div>
          {peutAjuster && (
            <div className="ligne-champs" style={{ marginTop: 14, alignItems: 'end' }}>
              <Champ libelle="Ajustement de quantite" aide="Valeur signee : negative pour une sortie">
                <input type="number" step="0.001" value={quantite} onChange={(e) => setQuantite(e.target.value)} />
              </Champ>
              <button className="bouton" onClick={ajuster} disabled={!quantite || motif.trim().length < 5}>Enregistrer l'ajustement</button>
            </div>
          )}
        </>
      )}

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
