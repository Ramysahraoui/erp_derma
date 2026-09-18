import { Link } from 'react-router-dom';
import { api, fmtDate, fmtEntier, fmtMontant, fmtNombre, fmtPct } from '../api';
import { useAuth } from '../auth';
import { AlerteErreur, Badge, Chargement, Indicateur, useChargement, Vide } from '../composants/Ui';

export function TableauDeBord() {
  const { peut } = useAuth();
  const tdb = useChargement(() => api.get('/tableau-de-bord'));
  const alertes = useChargement(() => api.get('/stock/alertes'));

  if (tdb.enCours && !tdb.donnees) return <Chargement />;
  if (tdb.erreur) return <AlerteErreur erreur={tdb.erreur} />;
  const d = tdb.donnees!;

  return (
    <>
      <div className="grille quatre" style={{ marginBottom: 16 }}>
        {peut('finance:lire') && (
          <>
            <Indicateur libelle="Chiffre d'affaires du mois" valeur={fmtMontant(d.ventes.ca_ht_mois)}
              detail={`${fmtEntier(d.ventes.nb_factures)} facture(s) emise(s)`} />
            <Indicateur libelle="Marge brute du mois" valeur={fmtMontant(d.ventes.marge_mois)} ton="succes" />
            <Indicateur libelle="Creances en cours" valeur={fmtMontant(d.creances.total)}
              detail={`${fmtEntier(d.creances.nombre)} facture(s) non soldee(s)`} ton="alerte" />
            <Indicateur libelle="Depenses du mois" valeur={fmtMontant(d.depenses.total_mois)} />
          </>
        )}
        <Indicateur libelle="OF en cours" valeur={fmtEntier(d.production.of_en_cours)}
          detail={`${fmtEntier(d.production.of_clotures_mois)} cloture(s) ce mois`} />
        <Indicateur libelle="Rendement moyen" valeur={fmtPct(d.production.rendement_moyen)} />
        {peut('finance:lire') && <Indicateur libelle="Valeur du stock" valeur={fmtMontant(d.stock.valeur_totale)} />}
        <Indicateur libelle="Articles sous seuil" valeur={fmtEntier(d.stock.articles_sous_seuil)}
          ton={Number(d.stock.articles_sous_seuil) > 0 ? 'danger' : undefined} />
        <Indicateur libelle="Lots en quarantaine" valeur={fmtEntier(d.qualite.lots_quarantaine)} ton="alerte"
          detail={`${fmtEntier(d.qualite.lots_perimes)} lot(s) perime(s) en stock`} />
      </div>

      <div className="grille deux">
        <section className="carte">
          <header>
            <h2>Alertes de reapprovisionnement</h2>
            <Link className="bouton petit" to="/capacite">Simulateur</Link>
          </header>
          <div className="corps sans-marge tableau-conteneur">
            {alertes.enCours && !alertes.donnees ? <Chargement /> : !alertes.donnees?.sous_seuil?.length ? (
              <Vide texte="Aucun article sous son seuil critique." />
            ) : (
              <table className="tableau">
                <thead><tr><th>Article</th><th>Type</th><th className="num">Disponible</th><th className="num">Seuil</th></tr></thead>
                <tbody>
                  {alertes.donnees.sous_seuil.map((a: any) => (
                    <tr key={a.article_id}>
                      <td><strong>{a.code_sku}</strong><div className="secondaire">{a.designation}</div></td>
                      <td><Badge valeur={a.type} classe="info" /></td>
                      <td className="num">{fmtNombre(a.qte_disponible)} {a.unite}</td>
                      <td className="num">{fmtNombre(a.seuil_critique)} {a.unite}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="carte">
          <header><h2>Peremptions a surveiller (90 jours)</h2></header>
          <div className="corps sans-marge tableau-conteneur">
            {alertes.enCours && !alertes.donnees ? <Chargement /> : !alertes.donnees?.peremptions_proches?.length ? (
              <Vide texte="Aucune peremption proche." />
            ) : (
              <table className="tableau">
                <thead><tr><th>Lot</th><th>Article</th><th>DLUO</th><th className="num">Quantite</th></tr></thead>
                <tbody>
                  {alertes.donnees.peremptions_proches.slice(0, 12).map((l: any) => (
                    <tr key={l.id}>
                      <td><strong>{l.code_lot_interne}</strong></td>
                      <td>{l.code_sku}<div className="secondaire">{l.designation}</div></td>
                      <td>
                        {fmtDate(l.dluo)}
                        <div className="secondaire">{Number(l.jours_restants) < 0 ? 'Perime' : `J-${l.jours_restants}`}</div>
                      </td>
                      <td className="num">{fmtNombre(l.qte_actuelle)} {l.unite}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="carte">
          <header>
            <h2>Lots en quarantaine</h2>
            <Link className="bouton petit" to="/lots?statut=QUARANTAINE">Voir tout</Link>
          </header>
          <div className="corps sans-marge tableau-conteneur">
            {alertes.enCours && !alertes.donnees ? <Chargement /> : !alertes.donnees?.en_quarantaine?.length ? (
              <Vide texte="Aucun lot en attente de liberation." />
            ) : (
              <table className="tableau">
                <thead><tr><th>Lot</th><th>Article</th><th>Recu le</th><th className="num">Quantite</th></tr></thead>
                <tbody>
                  {alertes.donnees.en_quarantaine.map((l: any) => (
                    <tr key={l.id}>
                      <td><strong>{l.code_lot_interne}</strong></td>
                      <td>{l.code_sku}<div className="secondaire">{l.designation}</div></td>
                      <td>{fmtDate(l.date_reception)}</td>
                      <td className="num">{fmtNombre(l.qte_actuelle)} {l.unite}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
