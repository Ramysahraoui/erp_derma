import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, aujourdhui, fmtDate, fmtMontant, fmtNombre } from '../api';
import { useAuth } from '../auth';
import { Alerte, AlerteErreur, Badge, Champ, Chargement, Modale, useChargement, Vide } from '../composants/Ui';

const TYPES = [
  { cle: '', libelle: 'Tous les documents' },
  { cle: 'DEVIS', libelle: 'Devis' },
  { cle: 'BC', libelle: 'Bons de commande' },
  { cle: 'BL', libelle: 'Bons de livraison' },
  { cle: 'FACTURE', libelle: 'Factures' },
];

export function Ventes() {
  const { peut } = useAuth();
  const naviguer = useNavigate();
  const [type, setType] = useState('');
  const [recherche, setRecherche] = useState('');
  const [creation, setCreation] = useState(false);
  const liste = useChargement(
    () => api.get(`/ventes?${new URLSearchParams({ ...(type ? { type_doc: type } : {}), ...(recherche ? { recherche } : {}) })}`),
    [type, recherche],
  );

  return (
    <>
      <div className="barre-filtres">
        <Champ libelle="Recherche"><input value={recherche} onChange={(e) => setRecherche(e.target.value)} placeholder="N° de piece ou client" /></Champ>
        <Champ libelle="Type de document">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => <option key={t.cle} value={t.cle}>{t.libelle}</option>)}
          </select>
        </Champ>
        <div style={{ flex: 1 }} />
        {peut('vente:ecrire') && <button className="bouton primaire" onClick={() => setCreation(true)}>Nouveau document</button>}
      </div>

      <section className="carte">
        <div className="corps sans-marge tableau-conteneur">
          {liste.enCours && !liste.donnees ? <Chargement /> : liste.erreur ? <AlerteErreur erreur={liste.erreur} /> :
            !liste.donnees?.length ? <Vide texte="Aucun document." /> : (
            <table className="tableau">
              <thead><tr><th>Piece</th><th>Type</th><th>Client</th><th>Date</th><th>Echeance</th>
                <th className="num">Total HT</th><th className="num">Total TTC</th><th>Statut</th></tr></thead>
              <tbody>
                {liste.donnees.map((d: any) => (
                  <tr key={d.id} className="cliquable" onClick={() => naviguer(`/ventes/${d.id}`)}>
                    <td><strong>{d.numero_piece}</strong></td>
                    <td><Badge valeur={d.type_doc} classe="info" /></td>
                    <td>{d.raison_sociale}<div className="secondaire">{d.client_code}</div></td>
                    <td>{fmtDate(d.date_doc)}</td>
                    <td>{fmtDate(d.date_echeance)}</td>
                    <td className="num">{fmtMontant(d.total_ht)}</td>
                    <td className="num">{fmtMontant(d.total_ttc)}</td>
                    <td>
                      <Badge valeur={d.statut} />
                      {d.type_doc === 'FACTURE' && d.statut === 'VALIDE' && <> <Badge valeur={d.statut_paiement} /></>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {creation && <ModaleVente onFermer={() => setCreation(false)} onCree={(id) => naviguer(`/ventes/${id}`)} />}
    </>
  );
}

interface LigneVente { article_id: string; lot_pf_id: string; quantite: string; prix_unitaire: string; remise_pct: string; tva_pct: string }

export function ModaleVente({ onFermer, onCree }: { onFermer: () => void; onCree: (id: number) => void }) {
  const clients = useChargement(() => api.get('/clients?actif=true'));
  const produits = useChargement(() => api.get('/articles?type=PF'));
  const [typeDoc, setTypeDoc] = useState<'DEVIS' | 'BC' | 'BL' | 'FACTURE'>('DEVIS');
  const [clientId, setClientId] = useState('');
  const [dateDoc, setDateDoc] = useState(aujourdhui());
  const [lignes, setLignes] = useState<LigneVente[]>([{ article_id: '', lot_pf_id: '', quantite: '1', prix_unitaire: '', remise_pct: '0', tva_pct: '19' }]);
  const [lotsParArticle, setLotsParArticle] = useState<Record<string, any[]>>({});
  const [erreur, setErreur] = useState<unknown>(null);
  const [deblocage, setDeblocage] = useState<{ email: string; mot_de_passe: string; motif: string } | null>(null);
  const [enCours, setEnCours] = useState(false);

  const client = (clients.donnees ?? []).find((c: any) => String(c.id) === clientId);
  const exigeLot = typeDoc === 'BL';

  const majLigne = async (i: number, champ: keyof LigneVente, valeur: string) => {
    setLignes((ls) => ls.map((l, j) => (j === i ? { ...l, [champ]: valeur } : l)));
    if (champ === 'article_id' && valeur && !lotsParArticle[valeur]) {
      try {
        const lots = await api.get(`/ventes/lots-disponibles/${valeur}`);
        setLotsParArticle((m) => ({ ...m, [valeur]: lots }));
      } catch { /* lots indisponibles */ }
      const produit = (produits.donnees ?? []).find((p: any) => String(p.id) === valeur);
      if (produit) setLignes((ls) => ls.map((l, j) => (j === i ? { ...l, prix_unitaire: String(produit.prix_vente_ht), tva_pct: String(produit.tva_pct) } : l)));
    }
  };

  const totaux = lignes.reduce((acc, l) => {
    const net = Number(l.quantite || 0) * Number(l.prix_unitaire || 0) * (1 - Number(l.remise_pct || 0) / 100);
    return { ht: acc.ht + net, tva: acc.tva + (net * Number(l.tva_pct || 0)) / 100 };
  }, { ht: 0, tva: 0 });

  const enregistrer = async (valider: boolean) => {
    setErreur(null); setEnCours(true);
    try {
      const doc = await api.post('/ventes', {
        type_doc: typeDoc,
        client_id: Number(clientId),
        date_doc: dateDoc,
        valider,
        deblocage: deblocage && deblocage.mot_de_passe ? deblocage : null,
        lignes: lignes.map((l) => ({
          article_id: Number(l.article_id),
          lot_pf_id: l.lot_pf_id ? Number(l.lot_pf_id) : null,
          quantite: Number(l.quantite),
          prix_unitaire: Number(l.prix_unitaire),
          remise_pct: Number(l.remise_pct || 0),
          tva_pct: Number(l.tva_pct || 0),
        })),
      });
      onCree(doc.id);
    } catch (e: any) {
      setErreur(e);
      if (e?.code === 'PLAFOND_CREDIT_DEPASSE') setDeblocage({ email: '', mot_de_passe: '', motif: '' });
    } finally { setEnCours(false); }
  };

  return (
    <Modale large titre="Nouveau document de vente" onFermer={onFermer}
      actions={<>
        <button className="bouton" onClick={onFermer}>Annuler</button>
        <button className="bouton" onClick={() => enregistrer(false)} disabled={!clientId || enCours}>Enregistrer en brouillon</button>
        <button className="bouton primaire" onClick={() => enregistrer(true)} disabled={!clientId || enCours}>Enregistrer et valider</button>
      </>}>
      <AlerteErreur erreur={erreur} />
      {deblocage && (
        <div className="carte" style={{ marginBottom: 14, borderColor: 'var(--danger)' }}>
          <div className="corps">
            <Alerte type="attention" titre="Autorisation superviseur requise">
              Le plafond d'encours du client est depasse. Un administrateur doit autoriser la sortie en saisissant
              ses identifiants.
            </Alerte>
            <div className="ligne-champs">
              <Champ libelle="E-mail administrateur" obligatoire>
                <input type="email" value={deblocage.email} onChange={(e) => setDeblocage({ ...deblocage, email: e.target.value })} />
              </Champ>
              <Champ libelle="Mot de passe" obligatoire>
                <input type="password" value={deblocage.mot_de_passe} onChange={(e) => setDeblocage({ ...deblocage, mot_de_passe: e.target.value })} />
              </Champ>
              <Champ libelle="Motif du deblocage">
                <input value={deblocage.motif} onChange={(e) => setDeblocage({ ...deblocage, motif: e.target.value })} />
              </Champ>
            </div>
          </div>
        </div>
      )}

      <div className="ligne-champs">
        <Champ libelle="Type de document" obligatoire>
          <select value={typeDoc} onChange={(e) => setTypeDoc(e.target.value as any)}>
            <option value="DEVIS">Devis</option>
            <option value="BC">Bon de commande</option>
            <option value="BL">Bon de livraison</option>
            <option value="FACTURE">Facture</option>
          </select>
        </Champ>
        <Champ libelle="Client" obligatoire>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">Selectionner…</option>
            {(clients.donnees ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.code} — {c.raison_sociale}</option>)}
          </select>
        </Champ>
        <Champ libelle="Date du document"><input type="date" value={dateDoc} onChange={(e) => setDateDoc(e.target.value)} /></Champ>
      </div>

      {client && (
        <div className="secondaire" style={{ marginTop: 8 }}>
          Plafond {fmtMontant(client.plafond_credit)} · encours {fmtMontant(client.encours_total)} ·
          credit disponible <strong>{fmtMontant(client.credit_disponible)}</strong> · delai {client.delai_paiement_jours} jours
        </div>
      )}

      {exigeLot && (
        <Alerte type="attention" titre="Tracabilite des expeditions">
          Un bon de livraison exige l'affectation d'un numero de lot de produit fini pour chaque ligne :
          la validation est refusee dans le cas contraire.
        </Alerte>
      )}

      <h3 style={{ margin: '16px 0 8px' }}>Lignes</h3>
      <div className="tableau-conteneur">
        <table className="tableau">
          <thead><tr><th style={{ minWidth: 200 }}>Produit fini</th>{exigeLot && <th style={{ minWidth: 190 }}>Lot expedie</th>}
            <th className="num">Quantite</th><th className="num">PU HT</th><th className="num">Remise %</th>
            <th className="num">TVA %</th><th className="num">Montant HT</th><th /></tr></thead>
          <tbody>
            {lignes.map((l, i) => {
              const net = Number(l.quantite || 0) * Number(l.prix_unitaire || 0) * (1 - Number(l.remise_pct || 0) / 100);
              return (
                <tr key={i}>
                  <td>
                    <select value={l.article_id} onChange={(e) => majLigne(i, 'article_id', e.target.value)}>
                      <option value="">Selectionner…</option>
                      {(produits.donnees ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.code_sku} — {p.designation}</option>)}
                    </select>
                  </td>
                  {exigeLot && (
                    <td>
                      <select value={l.lot_pf_id} onChange={(e) => majLigne(i, 'lot_pf_id', e.target.value)}>
                        <option value="">Lot obligatoire…</option>
                        {(lotsParArticle[l.article_id] ?? []).map((lot: any) => (
                          <option key={lot.id} value={lot.id}>
                            {lot.code_lot_interne} · {fmtNombre(lot.qte_actuelle, 0)} U{lot.dluo ? ` · DLUO ${fmtDate(lot.dluo)}` : ''}
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                  <td className="num"><input type="number" step="0.001" value={l.quantite} style={{ textAlign: 'right' }} onChange={(e) => majLigne(i, 'quantite', e.target.value)} /></td>
                  <td className="num"><input type="number" step="0.01" value={l.prix_unitaire} style={{ textAlign: 'right' }} onChange={(e) => majLigne(i, 'prix_unitaire', e.target.value)} /></td>
                  <td className="num"><input type="number" step="0.01" value={l.remise_pct} style={{ textAlign: 'right' }} onChange={(e) => majLigne(i, 'remise_pct', e.target.value)} /></td>
                  <td className="num"><input type="number" step="0.01" value={l.tva_pct} style={{ textAlign: 'right' }} onChange={(e) => majLigne(i, 'tva_pct', e.target.value)} /></td>
                  <td className="num">{fmtMontant(net)}</td>
                  <td>{lignes.length > 1 && <button className="bouton petit danger" onClick={() => setLignes(lignes.filter((_, j) => j !== i))}>×</button>}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr><td colSpan={exigeLot ? 6 : 5}>Total HT</td><td className="num">{fmtMontant(totaux.ht)}</td><td /></tr>
            <tr><td colSpan={exigeLot ? 6 : 5}>TVA</td><td className="num">{fmtMontant(totaux.tva)}</td><td /></tr>
            <tr><td colSpan={exigeLot ? 6 : 5}><strong>Total TTC</strong></td><td className="num"><strong>{fmtMontant(totaux.ht + totaux.tva)}</strong></td><td /></tr>
          </tfoot>
        </table>
      </div>
      <button className="bouton petit" style={{ marginTop: 10 }}
        onClick={() => setLignes([...lignes, { article_id: '', lot_pf_id: '', quantite: '1', prix_unitaire: '', remise_pct: '0', tva_pct: '19' }])}>
        Ajouter une ligne
      </button>
    </Modale>
  );
}
