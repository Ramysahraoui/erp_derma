import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, fmtDate, fmtDateHeure, fmtMontant, fmtNombre } from '../api';
import { useAuth } from '../auth';
import { Alerte, AlerteErreur, Badge, Champ, Chargement, Indicateur, Modale, useChargement, Vide } from '../composants/Ui';

const SUITES: Record<string, string[]> = { DEVIS: ['BC'], BC: ['BL', 'FACTURE'], BL: ['FACTURE'], FACTURE: [] };

export function VenteDetail() {
  const { id } = useParams();
  const naviguer = useNavigate();
  const { peut } = useAuth();
  const doc = useChargement(() => api.get(`/ventes/${id}`), [id]);
  const [erreur, setErreur] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [transformation, setTransformation] = useState<string | null>(null);

  if (doc.enCours && !doc.donnees) return <Chargement />;
  if (doc.erreur) return <AlerteErreur erreur={doc.erreur} />;
  const d = doc.donnees!;

  const valider = async () => {
    setErreur(null); setMessage(null);
    try { await api.post(`/ventes/${id}/valider`); setMessage('Document valide.'); doc.recharger(); }
    catch (e) { setErreur(e); }
  };

  const annuler = async () => {
    const motif = prompt('Motif d\'annulation (trace dans le journal d\'audit) :');
    if (!motif || motif.length < 5) return;
    setErreur(null);
    try { await api.post(`/ventes/${id}/annuler`, { motif }); doc.recharger(); }
    catch (e) { setErreur(e); }
  };

  return (
    <>
      <section className="carte">
        <header>
          <div>
            <h2>{d.numero_piece} <Badge valeur={d.type_doc} classe="info" /> <Badge valeur={d.statut} />
              {d.type_doc === 'FACTURE' && d.statut === 'VALIDE' && <> <Badge valeur={d.statut_paiement} /></>}</h2>
            <div className="secondaire">
              {d.raison_sociale} ({d.client_code}) · emis le {fmtDate(d.date_doc)}
              {d.date_echeance ? ` · echeance ${fmtDate(d.date_echeance)}` : ''}
              {d.document_parent_numero ? ` · issu de ${d.document_parent_numero}` : ''}
            </div>
          </div>
          <div className="actions">
            <button className="bouton" onClick={() => api.ouvrirDocument(`/documents/ventes/${id}`)}>Imprimer (PDF)</button>
            {peut('vente:ecrire') && d.statut === 'BROUILLON' && <button className="bouton primaire" onClick={valider}>Valider</button>}
            {peut('vente:ecrire') && d.statut === 'VALIDE' && SUITES[d.type_doc].map((cible) => (
              <button key={cible} className="bouton" onClick={() => setTransformation(cible)}>Transformer en {cible}</button>
            ))}
            {peut('vente:ecrire') && d.statut !== 'ANNULE' && Number(d.montant_paye) === 0 && (
              <button className="bouton danger" onClick={annuler}>Annuler</button>
            )}
          </div>
        </header>
        <div className="corps">
          <AlerteErreur erreur={erreur} />
          {message && <Alerte type="succes">{message}</Alerte>}
          {d.deblocage_motif && (
            <Alerte type="attention" titre="Deblocage d'encours">
              Sortie autorisee par un superviseur — motif : {d.deblocage_motif}
            </Alerte>
          )}
          <div className="grille quatre">
            <Indicateur libelle="Total HT" valeur={fmtMontant(d.total_ht)} />
            <Indicateur libelle="TVA" valeur={fmtMontant(d.total_tva)} />
            <Indicateur libelle="Total TTC" valeur={fmtMontant(d.total_ttc)} />
            {d.type_doc === 'FACTURE'
              ? <Indicateur libelle="Reste du" valeur={fmtMontant(Number(d.total_ttc) - Number(d.montant_paye))}
                  detail={`Regle : ${fmtMontant(d.montant_paye)}`} ton={Number(d.montant_paye) >= Number(d.total_ttc) ? 'succes' : 'alerte'} />
              : peut('finance:lire') && d.marge_brute != null
                ? <Indicateur libelle="Marge brute" valeur={fmtMontant(d.marge_brute)} ton="succes" />
                : <Indicateur libelle="Lignes" valeur={d.lignes.length} />}
          </div>
        </div>
      </section>

      <section className="carte">
        <header><h2>Lignes</h2></header>
        <div className="corps sans-marge tableau-conteneur">
          <table className="tableau">
            <thead><tr><th>Article</th>{d.type_doc === 'BL' && <th>Lot expedie</th>}<th className="num">Quantite</th>
              <th className="num">PU HT</th><th className="num">Remise</th><th className="num">TVA</th><th className="num">Montant HT</th></tr></thead>
            <tbody>
              {d.lignes.map((l: any) => {
                const net = Number(l.quantite) * Number(l.prix_unitaire) * (1 - Number(l.remise_pct) / 100);
                return (
                  <tr key={l.id}>
                    <td><strong>{l.code_sku}</strong><div className="secondaire">{l.designation}</div></td>
                    {d.type_doc === 'BL' && (
                      <td>{l.code_lot_interne ?? '—'}
                        <div className="secondaire">{l.code_of ? `OF ${l.code_of}` : ''}{l.dluo ? ` · DLUO ${fmtDate(l.dluo)}` : ''}</div></td>
                    )}
                    <td className="num">{fmtNombre(l.quantite, 0)}</td>
                    <td className="num">{fmtMontant(l.prix_unitaire)}</td>
                    <td className="num">{fmtNombre(l.remise_pct, 2)} %</td>
                    <td className="num">{fmtNombre(l.tva_pct, 2)} %</td>
                    <td className="num">{fmtMontant(net)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {d.reglements?.length > 0 && (
        <section className="carte">
          <header><h2>Reglements affectes</h2></header>
          <div className="corps sans-marge tableau-conteneur">
            <table className="tableau">
              <thead><tr><th>Encaissement</th><th>Mode</th><th>Date</th><th>Cheque</th><th className="num">Montant affecte</th></tr></thead>
              <tbody>
                {d.reglements.map((r: any) => (
                  <tr key={r.id}>
                    <td><strong>{r.numero}</strong></td>
                    <td><Badge valeur={r.mode_reglement} classe="info" /></td>
                    <td>{fmtDate(r.date_reglement)}</td>
                    <td>{r.cheque_numero ? <>{r.cheque_numero} <Badge valeur={r.cheque_statut} /></> : '—'}</td>
                    <td className="num">{fmtMontant(r.montant_affecte)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {d.documents_lies?.length > 0 && (
        <section className="carte">
          <header><h2>Documents lies</h2></header>
          <div className="corps sans-marge tableau-conteneur">
            <table className="tableau">
              <thead><tr><th>Piece</th><th>Type</th><th>Statut</th><th className="num">Total TTC</th><th /></tr></thead>
              <tbody>
                {d.documents_lies.map((e: any) => (
                  <tr key={e.id}>
                    <td><strong>{e.numero_piece}</strong></td>
                    <td><Badge valeur={e.type_doc} classe="info" /></td>
                    <td><Badge valeur={e.statut} /></td>
                    <td className="num">{fmtMontant(e.total_ttc)}</td>
                    <td><button className="bouton petit" onClick={() => naviguer(`/ventes/${e.id}`)}>Ouvrir</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {transformation && (
        <ModaleTransformation documentId={Number(id)} document={d} cible={transformation}
          onFermer={() => setTransformation(null)} onFait={(nouvelId) => { setTransformation(null); naviguer(`/ventes/${nouvelId}`); }} />
      )}
    </>
  );
}

function ModaleTransformation({ documentId, document, cible, onFermer, onFait }: {
  documentId: number; document: any; cible: string; onFermer: () => void; onFait: (id: number) => void;
}) {
  const [affectations, setAffectations] = useState<Record<number, string>>({});
  const [lots, setLots] = useState<Record<number, any[]>>({});
  const [erreur, setErreur] = useState<unknown>(null);
  const [deblocage, setDeblocage] = useState<{ email: string; mot_de_passe: string; motif: string } | null>(null);
  const exigeLot = cible === 'BL';

  // Chargement des lots de produits finis disponibles pour chaque ligne du BL.
  useEffect(() => {
    if (!exigeLot) return;
    let annule = false;
    (async () => {
      for (const ligne of document.lignes) {
        try {
          const disponibles = await api.get(`/ventes/lots-disponibles/${ligne.article_id}`);
          if (!annule) setLots((m) => (m[ligne.article_id] ? m : { ...m, [ligne.article_id]: disponibles }));
        } catch { /* lots indisponibles */ }
      }
    })();
    return () => { annule = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exigeLot, document.id]);

  const transformer = async (valider: boolean) => {
    setErreur(null);
    try {
      const nouveau = await api.post(`/ventes/${documentId}/transformer`, {
        cible, valider,
        affectations: exigeLot
          ? document.lignes.map((l: any) => ({ ligne_id: l.id, lot_pf_id: Number(affectations[l.id]) })).filter((a: any) => a.lot_pf_id)
          : null,
        deblocage: deblocage && deblocage.mot_de_passe ? deblocage : null,
      });
      onFait(nouveau.id);
    } catch (e: any) {
      setErreur(e);
      if (e?.code === 'PLAFOND_CREDIT_DEPASSE') setDeblocage({ email: '', mot_de_passe: '', motif: '' });
    }
  };

  return (
    <Modale large titre={`Transformer ${document.numero_piece} en ${cible}`} onFermer={onFermer}
      actions={<>
        <button className="bouton" onClick={onFermer}>Annuler</button>
        <button className="bouton" onClick={() => transformer(false)}>Creer en brouillon</button>
        <button className="bouton primaire" onClick={() => transformer(true)}>Creer et valider</button>
      </>}>
      <AlerteErreur erreur={erreur} />
      {deblocage && (
        <div className="ligne-champs" style={{ marginBottom: 14 }}>
          <Champ libelle="E-mail administrateur" obligatoire>
            <input type="email" value={deblocage.email} onChange={(e) => setDeblocage({ ...deblocage, email: e.target.value })} />
          </Champ>
          <Champ libelle="Mot de passe superviseur" obligatoire>
            <input type="password" value={deblocage.mot_de_passe} onChange={(e) => setDeblocage({ ...deblocage, mot_de_passe: e.target.value })} />
          </Champ>
          <Champ libelle="Motif"><input value={deblocage.motif} onChange={(e) => setDeblocage({ ...deblocage, motif: e.target.value })} /></Champ>
        </div>
      )}
      {exigeLot && (
        <>
          <Alerte type="attention" titre="Affectation obligatoire des lots">
            Chaque ligne du bon de livraison doit etre rattachee a un lot physique de produit fini en stock.
          </Alerte>
          <div className="tableau-conteneur">
            <table className="tableau">
              <thead><tr><th>Article</th><th className="num">Quantite</th><th>Lot de produit fini</th></tr></thead>
              <tbody>
                {document.lignes.map((l: any) => (
                  <tr key={l.id}>
                    <td><strong>{l.code_sku}</strong><div className="secondaire">{l.designation}</div></td>
                    <td className="num">{fmtNombre(l.quantite, 0)}</td>
                    <td>
                      <select value={affectations[l.id] ?? ''} onChange={(e) => setAffectations({ ...affectations, [l.id]: e.target.value })}>
                        <option value="">Selectionner un lot…</option>
                        {(lots[l.article_id] ?? []).map((lot: any) => (
                          <option key={lot.id} value={lot.id}>
                            {lot.code_lot_interne} · {fmtNombre(lot.qte_actuelle, 0)} U{lot.dluo ? ` · DLUO ${fmtDate(lot.dluo)}` : ''}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {!exigeLot && <p className="secondaire">Les lignes du document source seront reprises a l'identique.</p>}
      <div className="secondaire" style={{ marginTop: 12 }}>Document source valide le {fmtDateHeure(document.valide_le)}.</div>
    </Modale>
  );
}
