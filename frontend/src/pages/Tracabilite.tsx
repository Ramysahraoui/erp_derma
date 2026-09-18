import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, fmtDateHeure, fmtNombre, fmtPct } from '../api';
import { Alerte, AlerteErreur, Badge, Champ, Chargement, Indicateur, useChargement, Vide } from '../composants/Ui';

/**
 * Tracabilite reglementaire : d'un lot de matiere premiere vers les clients
 * livres (descendante) et d'un lot de produit fini vers ses composants
 * (ascendante).
 */
export function Tracabilite() {
  const [code, setCode] = useState('');
  const [recherche, setRecherche] = useState('');
  const [resultat, setResultat] = useState<any>(null);
  const [erreur, setErreur] = useState<unknown>(null);
  const [enCours, setEnCours] = useState(false);
  const suggestions = useChargement(
    () => (recherche.length >= 2 ? api.get(`/tracabilite/recherche?code=${encodeURIComponent(recherche)}`) : Promise.resolve([])),
    [recherche],
  );

  const tracer = async (valeur: string) => {
    setErreur(null); setEnCours(true); setResultat(null);
    try { setResultat(await api.get(`/tracabilite/lot?code=${encodeURIComponent(valeur)}`)); }
    catch (e) { setErreur(e); } finally { setEnCours(false); }
  };

  const descendante = resultat?.sens === 'DESCENDANTE' ? resultat : resultat?.descendante;
  const ascendante = resultat?.sens === 'ASCENDANTE' ? resultat : null;

  return (
    <>
      <section className="carte">
        <header><h2>Recherche par numero de lot</h2></header>
        <div className="corps">
          <Alerte type="info">
            Saisir ou scanner un numero de lot interne (LOT-MP, LOT-AC, LOT-PF) ou un numero de lot fournisseur.
            Le systeme deroule automatiquement la tracabilite dans le sens pertinent.
          </Alerte>
          <div style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
            <Champ libelle="Numero de lot">
              <input value={code} onChange={(e) => { setCode(e.target.value); setRecherche(e.target.value); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && code.trim()) tracer(code.trim()); }}
                placeholder="LOT-MP-2026-00007 ou HYA-9031" style={{ minWidth: 320 }} />
            </Champ>
            <button className="bouton primaire" onClick={() => tracer(code.trim())} disabled={!code.trim() || enCours}>
              {enCours ? 'Recherche…' : 'Tracer le lot'}
            </button>
          </div>
          {!!(suggestions.donnees ?? []).length && !resultat && (
            <div className="tableau-conteneur" style={{ marginTop: 14 }}>
              <table className="tableau">
                <thead><tr><th>Lot interne</th><th>Article</th><th>Lot fournisseur</th><th>Statut</th><th className="num">Quantite</th><th /></tr></thead>
                <tbody>
                  {suggestions.donnees.map((l: any) => (
                    <tr key={l.id} className="cliquable" onClick={() => { setCode(l.code_lot_interne); tracer(l.code_lot_interne); }}>
                      <td><strong>{l.code_lot_interne}</strong></td>
                      <td>{l.code_sku}<div className="secondaire">{l.designation}</div></td>
                      <td>{l.code_lot_fournisseur ?? '—'}</td>
                      <td><Badge valeur={l.statut} /></td>
                      <td className="num">{fmtNombre(l.qte_actuelle)} {l.unite}</td>
                      <td><button className="bouton petit">Tracer</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <AlerteErreur erreur={erreur} />
        </div>
      </section>

      {ascendante && (
        <section className="carte">
          <header><h2>Tracabilite ascendante — lot {ascendante.lot_pf.code_lot_interne}</h2></header>
          <div className="corps">
            <div className="grille quatre" style={{ marginBottom: 14 }}>
              <Indicateur libelle="Produit" valeur={ascendante.lot_pf.code_sku} detail={ascendante.lot_pf.designation} />
              <Indicateur libelle="Lot de vrac" valeur={ascendante.lot_pf.code_lot_vrac ?? '—'}
                detail={ascendante.lot_pf.code_of ? `OF ${ascendante.lot_pf.code_of}` : undefined} />
              <Indicateur libelle="Controle de cuve"
                valeur={ascendante.lot_pf.ph_mesure ? `pH ${ascendante.lot_pf.ph_mesure}` : '—'}
                detail={ascendante.lot_pf.viscosite_mesuree ? `${fmtNombre(ascendante.lot_pf.viscosite_mesuree, 0)} mPa·s` : undefined} />
              <Indicateur libelle="Rendement / CRU"
                valeur={ascendante.lot_pf.rendement_pct ? fmtPct(ascendante.lot_pf.rendement_pct) : '—'}
                detail={ascendante.lot_pf.formule_version ? `Formule ${ascendante.lot_pf.code_formule} v${ascendante.lot_pf.formule_version}` : undefined} />
            </div>
            <h3>Matieres premieres consommees</h3>
            <div className="tableau-conteneur">
              <table className="tableau">
                <thead><tr><th>Phase</th><th>Matiere</th><th>Lot consomme</th><th>Lot fournisseur</th><th>Fournisseur</th>
                  <th>DLUO</th><th className="num">Masse pesee</th><th>CoA</th></tr></thead>
                <tbody>
                  {ascendante.matieres_premieres.map((m: any, i: number) => (
                    <tr key={i}>
                      <td>{m.phase}</td>
                      <td><strong>{m.code_sku}</strong><div className="secondaire">{m.designation}</div></td>
                      <td>{m.code_lot_interne}</td>
                      <td>{m.code_lot_fournisseur ?? '—'}</td>
                      <td>{m.fournisseur ?? '—'}</td>
                      <td>{fmtDate(m.dluo)}</td>
                      <td className="num">{fmtNombre(m.poids_reel_pesee_g)} g</td>
                      <td>{m.coa_fichier ? <a href={`/fichiers/${m.coa_fichier}`} target="_blank" rel="noreferrer">Ouvrir</a> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!!ascendante.articles_conditionnement.length && (
              <>
                <h3 style={{ marginTop: 18 }}>Articles de conditionnement</h3>
                <div className="tableau-conteneur">
                  <table className="tableau">
                    <thead><tr><th>Article</th><th>Lot</th><th>Fournisseur</th><th className="num">Consomme</th></tr></thead>
                    <tbody>
                      {ascendante.articles_conditionnement.map((c: any, i: number) => (
                        <tr key={i}>
                          <td><strong>{c.code_sku}</strong><div className="secondaire">{c.designation}</div></td>
                          <td>{c.code_lot_interne}</td>
                          <td>{c.fournisseur ?? '—'}</td>
                          <td className="num">{fmtNombre(c.qte_consommee, 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {descendante && (
        <>
          <section className="carte">
            <header>
              <h2>Tracabilite descendante — lot {descendante.lot_origine.code_lot_interne}</h2>
              <span className="secondaire">{descendante.lot_origine.code_sku} — {descendante.lot_origine.designation}</span>
            </header>
            <div className="corps">
              <div className="grille quatre" style={{ marginBottom: 14 }}>
                <Indicateur libelle="Ordres de fabrication" valeur={descendante.synthese.nb_of} />
                <Indicateur libelle="Lots de produits finis" valeur={descendante.synthese.nb_lots_pf} />
                <Indicateur libelle="Documents d'expedition" valeur={descendante.synthese.nb_documents} />
                <Indicateur libelle="Clients livres" valeur={descendante.synthese.nb_clients} ton="danger" />
              </div>
              <dl className="liste-descriptive">
                <dt>Lot fournisseur</dt><dd>{descendante.lot_origine.code_lot_fournisseur ?? '—'} ({descendante.lot_origine.fournisseur ?? '—'})</dd>
                <dt>Reception</dt><dd>{descendante.lot_origine.numero_reception ?? '—'} du {fmtDate(descendante.lot_origine.date_reception)}</dd>
                <dt>DLUO</dt><dd>{fmtDate(descendante.lot_origine.dluo)}</dd>
                <dt>Statut</dt><dd><Badge valeur={descendante.lot_origine.statut} /></dd>
              </dl>
            </div>
          </section>

          <section className="carte">
            <header><h2>Ordres de fabrication ayant consomme ce lot</h2></header>
            <div className="corps sans-marge tableau-conteneur">
              {!descendante.ordres_fabrication.length ? <Vide texte="Ce lot n'a pas encore ete consomme." /> : (
                <table className="tableau">
                  <thead><tr><th>OF</th><th>Produit</th><th>Lot de vrac</th><th>Origine</th>
                    <th className="num">Quantite consommee</th><th className="num">Unites produites</th><th>Statut</th><th /></tr></thead>
                  <tbody>
                    {descendante.ordres_fabrication.map((o: any) => (
                      <tr key={`${o.id}-${o.origine}`}>
                        <td><strong>{o.code_of}</strong></td>
                        <td>{o.nom_produit}<div className="secondaire">{o.code_formule}</div></td>
                        <td>{o.code_lot_vrac ?? '—'}</td>
                        <td><Badge valeur={o.origine} classe="info" /></td>
                        <td className="num">{fmtNombre(o.quantite_consommee)}</td>
                        <td className="num">{fmtNombre(o.unites_produites, 0)}</td>
                        <td><Badge valeur={o.statut_of} /></td>
                        <td><Link className="bouton petit" to={`/production/${o.id}`}>Dossier de lot</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section className="carte">
            <header><h2>Lots de produits finis generes</h2></header>
            <div className="corps sans-marge tableau-conteneur">
              {!descendante.lots_pf.length ? <Vide /> : (
                <table className="tableau">
                  <thead><tr><th>Lot PF</th><th>Produit</th><th>Lot de vrac</th><th>Fabrication</th><th>DLUO</th>
                    <th className="num">Produit</th><th className="num">En stock</th><th>Statut</th></tr></thead>
                  <tbody>
                    {descendante.lots_pf.map((l: any) => (
                      <tr key={l.id}>
                        <td><strong>{l.code_lot_interne}</strong></td>
                        <td>{l.code_sku}<div className="secondaire">{l.designation}</div></td>
                        <td>{l.code_lot_vrac ?? '—'}</td>
                        <td>{fmtDate(l.date_fabrication)}</td>
                        <td>{fmtDate(l.dluo)}</td>
                        <td className="num">{fmtNombre(l.qte_initiale, 0)}</td>
                        <td className="num">{fmtNombre(l.qte_actuelle, 0)}</td>
                        <td><Badge valeur={l.statut} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section className="carte">
            <header><h2>Clients livres (rappel de lot)</h2></header>
            <div className="corps sans-marge tableau-conteneur">
              {!descendante.clients_livres.length ? <Vide texte="Aucune expedition a ce jour." /> : (
                <table className="tableau">
                  <thead><tr><th>Client</th><th>Contact</th><th className="num">Quantite livree</th><th>Bons de livraison</th></tr></thead>
                  <tbody>
                    {descendante.clients_livres.map((c: any) => (
                      <tr key={c.client_id}>
                        <td><strong>{c.raison_sociale}</strong><div className="secondaire">{c.code}</div></td>
                        <td>{c.contact ?? '—'}</td>
                        <td className="num">{fmtNombre(c.quantite_livree, 0)}</td>
                        <td className="secondaire">{c.documents.join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          {!!descendante.livraisons.length && (
            <section className="carte">
              <header><h2>Detail des expeditions</h2></header>
              <div className="corps sans-marge tableau-conteneur">
                <table className="tableau">
                  <thead><tr><th>Piece</th><th>Type</th><th>Date</th><th>Client</th><th className="num">Quantite</th></tr></thead>
                  <tbody>
                    {descendante.livraisons.map((l: any, i: number) => (
                      <tr key={i}>
                        <td><strong>{l.numero_piece}</strong></td>
                        <td><Badge valeur={l.type_doc} classe="info" /></td>
                        <td>{fmtDateHeure(l.date_doc)}</td>
                        <td>{l.raison_sociale}</td>
                        <td className="num">{fmtNombre(l.quantite, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}
