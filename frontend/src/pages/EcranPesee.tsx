import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, fmtDate, fmtNombre } from '../api';
import { useAuth } from '../auth';
import { Alerte, AlerteErreur, Badge, Chargement, useChargement, Vide } from '../composants/Ui';

/**
 * Ecran de pesee tactile (tablette d'atelier) : grands boutons, clavier
 * numerique integre, lecture douchette, et refus systematique des lots non
 * conformes ou perimes.
 */
export function EcranPesee() {
  const { id } = useParams();
  const naviguer = useNavigate();
  const { utilisateur } = useAuth();
  const dossier = useChargement(() => api.get(`/of/${id}`), [id]);
  const [ligneId, setLigneId] = useState<number | null>(null);

  if (dossier.enCours && !dossier.donnees) return <div className="atelier"><Chargement /></div>;
  if (dossier.erreur) return <div className="atelier"><AlerteErreur erreur={dossier.erreur} /></div>;
  const o = dossier.donnees!;

  return (
    <div className="atelier">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1 style={{ color: '#fff' }}>{o.code_of} — {o.nom_produit}</h1>
          <div style={{ color: '#94a3b8' }}>
            Masse brute {fmtNombre(o.masse_brute_kg)} kg · tolerance ± {fmtNombre(o.tolerance_pesee_pct)} % ·
            operateur {utilisateur?.nom_complet}
          </div>
        </div>
        <div className="actions">
          <button className="bouton atelier" onClick={() => api.ouvrirDocument(`/documents/of/${id}/bon-de-pesee`)}>Bon de pesee</button>
          <button className="bouton atelier" onClick={() => naviguer(`/production/${id}`)}>Quitter l'atelier</button>
        </div>
      </div>

      {o.avancement.pesees_completes && (
        <Alerte type="succes" titre="Toutes les pesees sont validees">
          Le dossier peut passer en fabrication : rejoindre l'ecran de l'ordre de fabrication pour cloturer la pesee
          et generer le lot de vrac.
        </Alerte>
      )}

      <div className="grille deux">
        <section className="carte">
          <header><h2>Fiche de fabrication</h2>
            <span style={{ color: '#94a3b8' }}>{o.avancement.lignes_pesees} / {o.avancement.lignes_totales} lignes soldees</span>
          </header>
          <div className="corps sans-marge tableau-conteneur">
            <table className="tableau">
              <thead><tr><th>Phase</th><th>Matiere</th><th className="num">Consigne</th><th className="num">Pese</th><th>Etat</th></tr></thead>
              <tbody>
                {o.lignes.map((l: any) => (
                  <tr key={l.id} className="cliquable" onClick={() => setLigneId(l.id)}
                    style={ligneId === l.id ? { outline: '2px solid var(--primaire)' } : undefined}>
                    <td>{l.phase}</td>
                    <td><strong>{l.code_sku}</strong><div className="secondaire">{l.designation}</div></td>
                    <td className="num">{fmtNombre(l.masse_theorique_g)} g</td>
                    <td className="num">{l.poids_reel_pesee_g ? `${fmtNombre(l.poids_reel_pesee_g)} g` : '—'}</td>
                    <td>
                      {l.ligne_terminee
                        ? <Badge valeur={l.conforme ? 'CONFORME' : 'ECART ACCEPTE'} classe={l.conforme ? 'succes' : 'alerte'} />
                        : l.poids_reel_pesee_g ? <Badge valeur="PARTIEL" classe="alerte" /> : <Badge valeur="A PESER" classe="info" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {ligneId
          ? <PaneauPesee ofId={Number(id)} ligneId={ligneId} onPesee={() => dossier.recharger()} />
          : <section className="carte"><div className="corps"><Vide texte="Selectionner une ligne a peser." /></div></section>}
      </div>
    </div>
  );
}

function PaneauPesee({ ofId, ligneId, onPesee }: { ofId: number; ligneId: number; onPesee: () => void }) {
  const fefo = useChargement(() => api.get(`/of/${ofId}/lignes/${ligneId}/fefo`), [ofId, ligneId]);
  const [lotId, setLotId] = useState<string>('');
  const [poids, setPoids] = useState('');
  const [erreur, setErreur] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [scan, setScan] = useState('');
  const champScan = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLotId(''); setPoids(''); setErreur(null); setMessage(null); setScan('');
  }, [ligneId]);

  useEffect(() => {
    if (fefo.donnees?.propositions?.length && !lotId) {
      setLotId(String(fefo.donnees.propositions[0].lot_stock_id));
      setPoids(String(fefo.donnees.propositions[0].a_prelever_g));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fefo.donnees]);

  if (fefo.enCours && !fefo.donnees) return <section className="carte"><div className="corps"><Chargement /></div></section>;
  if (fefo.erreur) return <section className="carte"><div className="corps"><AlerteErreur erreur={fefo.erreur} /></div></section>;
  const f = fefo.donnees!;

  const theorique = Number(f.masse_theorique_g);
  const dejaPese = Number(f.deja_pese_g);
  const saisi = Number(poids || 0);
  const cumul = dejaPese + saisi;
  const ecart = theorique ? ((cumul - theorique) / theorique) * 100 : 0;
  const tolerance = 0.5;
  const conforme = Math.abs(ecart) <= tolerance;

  const touche = (t: string) => {
    if (t === 'C') return setPoids('');
    if (t === '←') return setPoids(poids.slice(0, -1));
    if (t === '.' && poids.includes('.')) return;
    setPoids(poids + t);
  };

  const scanner = async () => {
    setErreur(null); setMessage(null);
    try {
      const resultat = await api.get(`/of/${ofId}/scan?code=${encodeURIComponent(scan.trim())}`);
      if (!resultat.utilisable) { setErreur(new Error(resultat.message)); return; }
      if (resultat.ligne?.id !== ligneId) { setErreur(new Error("Ce lot ne correspond pas a la ligne selectionnee.")); return; }
      setLotId(String(resultat.lot.id));
      setMessage(`Lot ${resultat.lot.code_lot_interne} reconnu.`);
      setScan('');
    } catch (e) { setErreur(e); }
  };

  const valider = async (forcer = false) => {
    setErreur(null); setMessage(null);
    try {
      const resultat = await api.post(`/of/${ofId}/pesees`, {
        of_ligne_id: ligneId, lot_stock_id: Number(lotId), poids_reel_pesee_g: saisi, forcer,
      });
      setMessage(resultat.ligne_terminee
        ? `Pesee validee : ligne soldee (${resultat.cumul_g} g).`
        : `Prelevement enregistre : reste ${resultat.reste_a_peser_g} g a peser.`);
      setPoids('');
      fefo.recharger();
      onPesee();
    } catch (e) { setErreur(e); }
  };

  return (
    <section className="carte">
      <header>
        <h2>{f.article.code_sku} — phase {f.phase}</h2>
        <span style={{ color: '#94a3b8' }}>{f.article.designation}</span>
      </header>
      <div className="corps">
        <AlerteErreur erreur={erreur} />
        {message && <Alerte type="succes">{message}</Alerte>}
        {f.consigne && <Alerte type="info" titre="Consigne operatoire">{f.consigne}</Alerte>}

        <div className="consigne-geante">
          <small>Consigne a peser</small>
          {fmtNombre(f.reste_a_peser_g)} g
          {dejaPese > 0 && <small style={{ marginTop: 6 }}>Deja pese : {fmtNombre(f.deja_pese_g)} g sur {fmtNombre(f.masse_theorique_g)} g</small>}
        </div>

        {f.ligne_terminee && <Alerte type="succes" titre="Ligne soldee">Cette ligne a deja ete pesee et validee.</Alerte>}

        {!f.ligne_terminee && (
          <>
            <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
              <input ref={champScan} value={scan} onChange={(e) => setScan(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') scanner(); }}
                placeholder="Scanner le code-barres du lot (douchette)" />
              <button className="bouton" onClick={scanner} disabled={!scan.trim()}>Valider le scan</button>
            </div>

            <label className="champ">
              <span>Lot a prelever — regle FEFO (peremption la plus proche en premier)</span>
              <select value={lotId} onChange={(e) => setLotId(e.target.value)} style={{ minHeight: 56, fontSize: 16 }}>
                <option value="">Selectionner un lot conforme…</option>
                {f.propositions.map((p: any) => (
                  <option key={p.lot_stock_id} value={p.lot_stock_id}>
                    {p.code_lot_interne} · DLUO {p.dluo ? fmtDate(p.dluo) : 'n/a'} ·
                    {` disponible ${fmtNombre(p.disponible_unite_stock)} ${p.unite}`}
                    {p.emplacement ? ` · ${p.emplacement}` : ''}
                  </option>
                ))}
              </select>
            </label>
            {!f.propositions.length && (
              <Alerte type="erreur" titre="Aucun lot utilisable">
                Aucun lot conforme, non perime et disponible pour cette matiere. Les lots en quarantaine, bloques,
                rejetes ou perimes sont volontairement masques.
              </Alerte>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
              <div>
                <label className="champ">
                  <span>Masse reelle pesee (g)</span>
                  <input className="atelier" value={poids} onChange={(e) => setPoids(e.target.value)} inputMode="decimal" />
                </label>
                <div className={`verdict ${conforme ? 'conforme' : 'hors'}`} style={{ marginTop: 12 }}>
                  {saisi > 0
                    ? `Ecart cumule : ${ecart.toFixed(3)} % ${conforme ? '— dans la tolerance' : '— HORS TOLERANCE'}`
                    : 'Saisir la masse relevee sur la balance'}
                </div>
                <div className="actions" style={{ marginTop: 12 }}>
                  <button className="bouton primaire atelier bloc" disabled={!lotId || saisi <= 0} onClick={() => valider(false)}>
                    Valider la pesee
                  </button>
                </div>
                <div className="actions" style={{ marginTop: 8 }}>
                  <button className="bouton bloc" disabled={!lotId || saisi <= 0 || conforme} onClick={() => valider(true)}>
                    Accepter l'ecart (responsable qualite)
                  </button>
                </div>
              </div>
              <div className="clavier">
                {['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '←'].map((t) => (
                  <button key={t} onClick={() => touche(t)}>{t}</button>
                ))}
                <button className="action" onClick={() => touche('C')}>Effacer</button>
                <button className="action" onClick={() => setPoids(String(f.reste_a_peser_g))}>Consigne</button>
                <button className="action" onClick={() => {
                  const proposition = f.propositions.find((p: any) => String(p.lot_stock_id) === lotId);
                  if (proposition) setPoids(String(proposition.a_prelever_g));
                }}>Proposition</button>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
