import { useState } from 'react';
import { api, fmtDate, fmtEntier, fmtMontant, fmtNombre, fmtPct } from '../api';
import { AlerteErreur, Badge, Champ, Chargement, Indicateur, Onglets, useChargement, Vide } from '../composants/Ui';

/** Analyse de rentabilite : marge par produit et cout de revient par OF cloture. */
export function Rentabilite() {
  const [onglet, setOnglet] = useState('produits');
  const [depuis, setDepuis] = useState('');
  const [jusqua, setJusqua] = useState('');
  const analyse = useChargement(
    () => api.get(`/analyse/rentabilite?${new URLSearchParams({ ...(depuis ? { depuis } : {}), ...(jusqua ? { jusqua } : {}) })}`),
    [depuis, jusqua],
  );

  if (analyse.enCours && !analyse.donnees) return <Chargement />;
  if (analyse.erreur) return <AlerteErreur erreur={analyse.erreur} />;
  const d = analyse.donnees!;

  const ca = d.par_produit.reduce((t: number, p: any) => t + Number(p.ca_ht), 0);
  const marge = d.par_produit.reduce((t: number, p: any) => t + Number(p.marge_brute), 0);
  const cruMoyen = d.par_ordre_fabrication.length
    ? d.par_ordre_fabrication.reduce((t: number, o: any) => t + Number(o.cru ?? 0), 0) / d.par_ordre_fabrication.length
    : 0;

  return (
    <>
      <div className="barre-filtres">
        <Champ libelle="Depuis"><input type="date" value={depuis} onChange={(e) => setDepuis(e.target.value)} /></Champ>
        <Champ libelle="Jusqu'au"><input type="date" value={jusqua} onChange={(e) => setJusqua(e.target.value)} /></Champ>
      </div>

      <div className="grille quatre" style={{ marginBottom: 16 }}>
        <Indicateur libelle="Chiffre d'affaires facture" valeur={fmtMontant(ca)} />
        <Indicateur libelle="Marge brute" valeur={fmtMontant(marge)} ton="succes"
          detail={ca > 0 ? `Taux de marge ${fmtPct((marge / ca) * 100)}` : undefined} />
        <Indicateur libelle="OF clotures" valeur={fmtEntier(d.par_ordre_fabrication.length)} />
        <Indicateur libelle="CRU moyen" valeur={fmtMontant(cruMoyen)} />
      </div>

      <Onglets actif={onglet} onChange={setOnglet} onglets={[
        { cle: 'produits', libelle: 'Rentabilite par produit' },
        { cle: 'of', libelle: 'Cout de revient par ordre de fabrication' },
      ]} />

      {onglet === 'produits' && (
        <section className="carte">
          <div className="corps sans-marge tableau-conteneur">
            <table className="tableau">
              <thead><tr><th>Produit fini</th><th className="num">Quantite vendue</th><th className="num">CA HT</th>
                <th className="num">Cout de revient</th><th className="num">Marge brute</th><th className="num">Taux de marge</th>
                <th className="num">Prix de vente</th><th className="num">Cout moyen</th></tr></thead>
              <tbody>
                {d.par_produit.map((p: any) => {
                  const taux = Number(p.ca_ht) > 0 ? (Number(p.marge_brute) / Number(p.ca_ht)) * 100 : 0;
                  return (
                    <tr key={p.article_id}>
                      <td><strong>{p.code_sku}</strong><div className="secondaire">{p.designation}</div></td>
                      <td className="num">{fmtNombre(p.quantite_vendue, 0)}</td>
                      <td className="num">{fmtMontant(p.ca_ht)}</td>
                      <td className="num">{fmtMontant(p.cout_revient_total)}</td>
                      <td className="num" style={{ color: Number(p.marge_brute) >= 0 ? 'var(--succes)' : 'var(--danger)', fontWeight: 650 }}>
                        {fmtMontant(p.marge_brute)}
                      </td>
                      <td className="num">{fmtPct(taux)}</td>
                      <td className="num">{fmtMontant(p.prix_vente_ht)}</td>
                      <td className="num">{fmtMontant(p.cout_moyen)}</td>
                    </tr>
                  );
                })}
                {!d.par_produit.length && <tr><td colSpan={8}><Vide /></td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {onglet === 'of' && (
        <section className="carte">
          <div className="corps sans-marge tableau-conteneur">
            <table className="tableau">
              <thead><tr><th>OF</th><th>Produit</th><th>Cloture</th><th className="num">Unites</th><th className="num">Rendement</th>
                <th className="num">MP</th><th className="num">AC</th><th className="num">MO</th><th className="num">Indirects</th>
                <th className="num">CRU</th><th className="num">Marge unitaire</th></tr></thead>
              <tbody>
                {d.par_ordre_fabrication.map((o: any) => (
                  <tr key={o.id}>
                    <td><strong>{o.code_of}</strong></td>
                    <td>{o.nom_produit}<div className="secondaire">{o.code_sku}</div></td>
                    <td>{fmtDate(o.date_cloture)}</td>
                    <td className="num">{fmtEntier(o.unites_produites)}</td>
                    <td className="num">{o.rendement_pct ? fmtPct(o.rendement_pct) : '—'}</td>
                    <td className="num">{fmtMontant(o.cout_mp)}</td>
                    <td className="num">{fmtMontant(o.cout_ac)}</td>
                    <td className="num">{fmtMontant(o.cout_main_oeuvre)}</td>
                    <td className="num">{fmtMontant(o.cout_charges_indirectes)}</td>
                    <td className="num"><strong>{fmtMontant(o.cru)}</strong></td>
                    <td className="num">
                      {o.marge_unitaire != null
                        ? <Badge valeur={fmtMontant(o.marge_unitaire)} classe={Number(o.marge_unitaire) >= 0 ? 'succes' : 'danger'} />
                        : '—'}
                    </td>
                  </tr>
                ))}
                {!d.par_ordre_fabrication.length && <tr><td colSpan={11}><Vide texte="Aucun ordre de fabrication cloture sur la periode." /></td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
