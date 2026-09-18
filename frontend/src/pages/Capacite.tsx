import { useState } from 'react';
import { api, fmtEntier, fmtNombre } from '../api';
import { useAuth } from '../auth';
import { Alerte, AlerteErreur, Badge, Champ, Chargement, Indicateur, useChargement, Vide } from '../composants/Ui';

/**
 * Simulateur d'usine : capacite maximale theorique par produit fini,
 * identification du composant limitant et generation de la commande d'achat.
 */
export function Capacite() {
  const { peut } = useAuth();
  const produits = useChargement(() => api.get('/articles?type=PF'));
  const [selection, setSelection] = useState<Record<number, string>>({});
  const [resultat, setResultat] = useState<any>(null);
  const [erreur, setErreur] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);

  const basculer = (id: number) =>
    setSelection((s) => {
      const copie = { ...s };
      if (id in copie) delete copie[id]; else copie[id] = '';
      return copie;
    });

  const simuler = async () => {
    setErreur(null); setMessage(null); setEnCours(true);
    try {
      const reponse = await api.post('/capacite/simulation', {
        produits: Object.entries(selection).map(([id, cible]) => ({
          article_pf_id: Number(id),
          unites_cibles: cible ? Number(cible) : null,
        })),
      });
      setResultat(reponse);
    } catch (e) { setErreur(e); setResultat(null); } finally { setEnCours(false); }
  };

  const genererCommande = async () => {
    setErreur(null); setMessage(null);
    try {
      const manquants = resultat.besoins_consolides.filter((b: any) => !b.couvert);
      const commande = await api.post('/capacite/commande-achat', {
        origine: 'Simulateur de capacite predictive',
        lignes: manquants.map((m: any) => ({ article_id: m.article_id, quantite: Number(m.manquant) })),
      });
      setMessage(`Commande d'achat ${commande.numero} generee pour ${manquants.length} article(s).`);
    } catch (e) { setErreur(e); }
  };

  return (
    <>
      <Alerte type="info" titre="Moteur de capacite predictive">
        Pour chaque composant de la formule et chaque element de packaging, le systeme calcule le nombre d'unites
        fabricables (stock disponible / besoin unitaire). La capacite retenue est le minimum : le composant
        correspondant est le goulot d'etranglement.
      </Alerte>

      <section className="carte">
        <header><h2>Selection des produits finis</h2>
          <button className="bouton primaire" onClick={simuler} disabled={!Object.keys(selection).length || enCours}>
            {enCours ? 'Calcul…' : 'Lancer la simulation'}
          </button>
        </header>
        <div className="corps sans-marge tableau-conteneur">
          {produits.enCours && !produits.donnees ? <Chargement /> : (
            <table className="tableau">
              <thead><tr><th style={{ width: 60 }} /><th>Produit fini</th><th className="num">Stock actuel</th><th style={{ width: 220 }}>Objectif (unites)</th></tr></thead>
              <tbody>
                {(produits.donnees ?? []).map((p: any) => (
                  <tr key={p.id}>
                    <td><input type="checkbox" style={{ width: 22, height: 22, minHeight: 22 }}
                      checked={p.id in selection} onChange={() => basculer(p.id)} /></td>
                    <td><strong>{p.code_sku}</strong><div className="secondaire">{p.designation}</div></td>
                    <td className="num">{fmtNombre(p.qte_disponible, 0)} U</td>
                    <td>
                      <input type="number" min="1" placeholder="Capacite maximale" disabled={!(p.id in selection)}
                        value={selection[p.id] ?? ''} onChange={(e) => setSelection({ ...selection, [p.id]: e.target.value })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <AlerteErreur erreur={erreur} />
      {message && <Alerte type="succes">{message}</Alerte>}

      {resultat?.simulations?.map((sim: any) => (
        <section className="carte" key={sim.article_pf_id}>
          <header>
            <h2>{sim.code_sku} — {sim.designation}</h2>
            <span className="secondaire">Formule {sim.code_formule} v{sim.version} — {fmtNombre(sim.masse_unitaire_g)} g de vrac par unite</span>
          </header>
          <div className="corps">
            <div className="grille trois" style={{ marginBottom: 14 }}>
              <Indicateur libelle="Unites maximales fabricables" valeur={fmtEntier(sim.unites_max_fabricables)} />
              <Indicateur libelle="Composant limitant" valeur={sim.composant_limitant?.code_sku ?? '—'}
                detail={sim.composant_limitant?.designation} ton="danger" />
              <Indicateur libelle="Objectif" valeur={sim.unites_cibles ? fmtEntier(sim.unites_cibles) : 'Capacite max'}
                detail={sim.cible_atteignable ? 'Objectif atteignable' : 'Objectif non couvert par le stock'}
                ton={sim.cible_atteignable ? 'succes' : 'danger'} />
            </div>
            <div className="tableau-conteneur">
              <table className="tableau">
                <thead><tr><th>Composant</th><th>Type</th><th>Phase</th><th className="num">Besoin unitaire</th>
                  <th className="num">Stock disponible</th><th className="num">Unites fabricables</th><th className="num">Manquant</th></tr></thead>
                <tbody>
                  {sim.composants.map((c: any) => (
                    <tr key={c.article_id} className={c.limitant ? 'limitant' : undefined}>
                      <td><strong>{c.code_sku}</strong><div className="secondaire">{c.designation}</div></td>
                      <td><Badge valeur={c.type} classe="info" /></td>
                      <td>{c.phase ?? '—'}</td>
                      <td className="num">{fmtNombre(c.besoin_unitaire)} {c.unite}</td>
                      <td className="num">{fmtNombre(c.stock_disponible)} {c.unite}</td>
                      <td className="num"><strong>{fmtEntier(c.unites_fabricables)}</strong></td>
                      <td className="num" style={Number(c.manquant_pour_cible) > 0 ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>
                        {Number(c.manquant_pour_cible) > 0 ? `${fmtNombre(c.manquant_pour_cible)} ${c.unite}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ))}

      {resultat && (
        <section className="carte">
          <header>
            <h2>Besoins consolides</h2>
            {peut('achat:ecrire') && resultat.approvisionnement_necessaire && (
              <button className="bouton primaire" onClick={genererCommande}>Generer la commande d'achat</button>
            )}
          </header>
          <div className="corps sans-marge tableau-conteneur">
            {!resultat.besoins_consolides.length ? <Vide /> : (
              <table className="tableau">
                <thead><tr><th>Article</th><th>Type</th><th className="num">Besoin total</th>
                  <th className="num">Stock</th><th className="num">A commander</th><th>Couverture</th></tr></thead>
                <tbody>
                  {resultat.besoins_consolides.map((b: any) => (
                    <tr key={b.article_id} className={!b.couvert ? 'limitant' : undefined}>
                      <td><strong>{b.code_sku}</strong><div className="secondaire">{b.designation}</div></td>
                      <td><Badge valeur={b.type} classe="info" /></td>
                      <td className="num">{fmtNombre(b.besoin_total)} {b.unite}</td>
                      <td className="num">{fmtNombre(b.stock_disponible)} {b.unite}</td>
                      <td className="num">{Number(b.manquant) > 0 ? `${fmtNombre(b.manquant)} ${b.unite}` : '—'}</td>
                      <td><Badge valeur={b.couvert ? 'CONFORME' : 'A COMMANDER'} classe={b.couvert ? 'succes' : 'danger'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}
    </>
  );
}
