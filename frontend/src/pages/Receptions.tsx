import { useState } from 'react';
import { api, aujourdhui, fmtDate, fmtMontant, fmtNombre } from '../api';
import { useAuth } from '../auth';
import { Alerte, AlerteErreur, Badge, Champ, Chargement, Modale, useChargement, Vide } from '../composants/Ui';

interface LigneSaisie {
  article_id: string; quantite: string; code_lot_fournisseur: string; dluo: string;
  prix_achat_unitaire: string; frais_approche_unitaire: string; statut: 'QUARANTAINE' | 'CONFORME';
  coa_fichier: string | null; coa_nom: string | null; emplacement: string;
}

const ligneVide = (): LigneSaisie => ({
  article_id: '', quantite: '', code_lot_fournisseur: '', dluo: '', prix_achat_unitaire: '',
  frais_approche_unitaire: '0', statut: 'QUARANTAINE', coa_fichier: null, coa_nom: null, emplacement: '',
});

export function Receptions() {
  const { peut } = useAuth();
  const [saisie, setSaisie] = useState(false);
  const [detail, setDetail] = useState<number | null>(null);
  const liste = useChargement(() => api.get('/receptions'));

  return (
    <>
      <div className="barre-filtres">
        <div style={{ flex: 1 }} />
        {peut('stock:receptionner') && <button className="bouton primaire" onClick={() => setSaisie(true)}>Saisir une reception</button>}
      </div>
      <section className="carte">
        <div className="corps sans-marge tableau-conteneur">
          {liste.enCours && !liste.donnees ? <Chargement /> : liste.erreur ? <AlerteErreur erreur={liste.erreur} /> :
            !liste.donnees?.length ? <Vide texte="Aucune reception enregistree." /> : (
            <table className="tableau">
              <thead><tr><th>Numero</th><th>Date</th><th>Fournisseur</th><th>BL fournisseur</th><th className="num">Lots</th><th>Commentaire</th></tr></thead>
              <tbody>
                {liste.donnees.map((r: any) => (
                  <tr key={r.id} className="cliquable" onClick={() => setDetail(r.id)}>
                    <td><strong>{r.numero}</strong></td>
                    <td>{fmtDate(r.date_reception)}</td>
                    <td>{r.fournisseur ?? '—'}</td>
                    <td>{r.reference_bl_fournisseur ?? '—'}</td>
                    <td className="num">{r.nb_lots}</td>
                    <td className="secondaire">{r.commentaire ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
      {saisie && <ModaleReception onFermer={() => setSaisie(false)} onCree={() => { setSaisie(false); liste.recharger(); }} />}
      {detail && <ModaleDetailReception id={detail} onFermer={() => setDetail(null)} />}
    </>
  );
}

function ModaleReception({ onFermer, onCree }: { onFermer: () => void; onCree: () => void }) {
  const articles = useChargement(() => api.get('/articles'));
  const fournisseurs = useChargement(() => api.get('/fournisseurs'));
  const [entete, setEntete] = useState({ fournisseur_id: '', date_reception: aujourdhui(), reference_bl_fournisseur: '', commentaire: '' });
  const [lignes, setLignes] = useState<LigneSaisie[]>([ligneVide()]);
  const [erreur, setErreur] = useState<unknown>(null);
  const [enCours, setEnCours] = useState(false);

  const majLigne = (i: number, champ: keyof LigneSaisie, valeur: any) =>
    setLignes((ls) => ls.map((l, j) => (j === i ? { ...l, [champ]: valeur } : l)));

  const televerser = async (i: number, fichier: File | undefined) => {
    if (!fichier) return;
    try {
      const resultat = await api.televerser(fichier);
      majLigne(i, 'coa_fichier', resultat.fichier);
      majLigne(i, 'coa_nom', fichier.name);
    } catch (e) { setErreur(e); }
  };

  const enregistrer = async () => {
    setErreur(null);
    setEnCours(true);
    try {
      await api.post('/receptions', {
        fournisseur_id: entete.fournisseur_id ? Number(entete.fournisseur_id) : null,
        date_reception: entete.date_reception,
        reference_bl_fournisseur: entete.reference_bl_fournisseur || null,
        commentaire: entete.commentaire || null,
        lignes: lignes.map((l) => ({
          article_id: Number(l.article_id),
          quantite: Number(l.quantite),
          code_lot_fournisseur: l.code_lot_fournisseur,
          dluo: l.dluo || null,
          prix_achat_unitaire: Number(l.prix_achat_unitaire || 0),
          frais_approche_unitaire: Number(l.frais_approche_unitaire || 0),
          statut: l.statut,
          coa_fichier: l.coa_fichier,
          emplacement: l.emplacement || null,
        })),
      });
      onCree();
    } catch (e) { setErreur(e); } finally { setEnCours(false); }
  };

  const articlesReceptionnables = (articles.donnees ?? []).filter((a: any) => a.type !== 'PF');

  return (
    <Modale large titre="Reception fournisseur" onFermer={onFermer}
      actions={<><button className="bouton" onClick={onFermer}>Annuler</button>
        <button className="bouton primaire" onClick={enregistrer} disabled={enCours}>
          {enCours ? 'Enregistrement…' : 'Enregistrer la reception'}</button></>}>
      <AlerteErreur erreur={erreur} />
      <Alerte type="info">
        Chaque ligne genere un numero de lot interne unique. Les lots entrent par defaut en quarantaine :
        seul le responsable qualite peut les liberer apres controle du certificat d'analyse.
      </Alerte>
      <div className="ligne-champs">
        <Champ libelle="Fournisseur">
          <select value={entete.fournisseur_id} onChange={(e) => setEntete({ ...entete, fournisseur_id: e.target.value })}>
            <option value="">—</option>
            {(fournisseurs.donnees ?? []).map((f: any) => <option key={f.id} value={f.id}>{f.raison_sociale}</option>)}
          </select>
        </Champ>
        <Champ libelle="Date de reception" obligatoire>
          <input type="date" value={entete.date_reception} onChange={(e) => setEntete({ ...entete, date_reception: e.target.value })} />
        </Champ>
        <Champ libelle="BL fournisseur">
          <input value={entete.reference_bl_fournisseur} onChange={(e) => setEntete({ ...entete, reference_bl_fournisseur: e.target.value })} />
        </Champ>
      </div>

      <h3 style={{ margin: '18px 0 8px' }}>Lignes receptionnees</h3>
      {lignes.map((l, i) => (
        <div key={i} className="carte" style={{ marginBottom: 10 }}>
          <div className="corps">
            <div className="ligne-champs">
              <Champ libelle="Article" obligatoire>
                <select value={l.article_id} onChange={(e) => majLigne(i, 'article_id', e.target.value)}>
                  <option value="">Selectionner…</option>
                  {articlesReceptionnables.map((a: any) => (
                    <option key={a.id} value={a.id}>{a.code_sku} — {a.designation} ({a.unite})</option>
                  ))}
                </select>
              </Champ>
              <Champ libelle="Quantite recue" obligatoire>
                <input type="number" step="0.001" value={l.quantite} onChange={(e) => majLigne(i, 'quantite', e.target.value)} />
              </Champ>
              <Champ libelle="N° lot fournisseur" obligatoire>
                <input value={l.code_lot_fournisseur} onChange={(e) => majLigne(i, 'code_lot_fournisseur', e.target.value)} />
              </Champ>
              <Champ libelle="DLUO / peremption">
                <input type="date" value={l.dluo} onChange={(e) => majLigne(i, 'dluo', e.target.value)} />
              </Champ>
            </div>
            <div className="ligne-champs" style={{ marginTop: 10 }}>
              <Champ libelle="Prix d'achat unitaire HT" obligatoire>
                <input type="number" step="0.0001" value={l.prix_achat_unitaire} onChange={(e) => majLigne(i, 'prix_achat_unitaire', e.target.value)} />
              </Champ>
              <Champ libelle="Frais d'approche unitaire" aide="Douane, transport, assurance">
                <input type="number" step="0.0001" value={l.frais_approche_unitaire} onChange={(e) => majLigne(i, 'frais_approche_unitaire', e.target.value)} />
              </Champ>
              <Champ libelle="Emplacement">
                <input value={l.emplacement} onChange={(e) => majLigne(i, 'emplacement', e.target.value)} placeholder="Magasin A / Rayon 3" />
              </Champ>
              <Champ libelle="Statut a l'entree">
                <select value={l.statut} onChange={(e) => majLigne(i, 'statut', e.target.value)}>
                  <option value="QUARANTAINE">Quarantaine (controle a venir)</option>
                  <option value="CONFORME">Conforme (CoA valide)</option>
                </select>
              </Champ>
              <Champ libelle="Certificat d'analyse (PDF / image)">
                <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={(e) => televerser(i, e.target.files?.[0])} />
                {l.coa_nom && <span className="aide">Joint : {l.coa_nom}</span>}
              </Champ>
            </div>
            {lignes.length > 1 && (
              <div className="actions" style={{ marginTop: 10 }}>
                <button className="bouton petit danger" onClick={() => setLignes(lignes.filter((_, j) => j !== i))}>Retirer la ligne</button>
              </div>
            )}
          </div>
        </div>
      ))}
      <button className="bouton petit" onClick={() => setLignes([...lignes, ligneVide()])}>Ajouter une ligne</button>
    </Modale>
  );
}

function ModaleDetailReception({ id, onFermer }: { id: number; onFermer: () => void }) {
  const detail = useChargement(() => api.get(`/receptions/${id}`), [id]);
  if (detail.enCours && !detail.donnees) return <Modale titre="Reception" onFermer={onFermer}><Chargement /></Modale>;
  const r = detail.donnees!;
  return (
    <Modale large titre={`Reception ${r.numero}`} onFermer={onFermer}>
      <dl className="liste-descriptive">
        <dt>Date</dt><dd>{fmtDate(r.date_reception)}</dd>
        <dt>Fournisseur</dt><dd>{r.fournisseur ?? '—'}</dd>
        <dt>BL fournisseur</dt><dd>{r.reference_bl_fournisseur ?? '—'}</dd>
        <dt>Commentaire</dt><dd>{r.commentaire ?? '—'}</dd>
      </dl>
      <div className="tableau-conteneur" style={{ marginTop: 16 }}>
        <table className="tableau">
          <thead><tr><th>Lot interne</th><th>Article</th><th>Lot fournisseur</th><th>DLUO</th>
            <th className="num">Quantite</th><th className="num">Cout unitaire</th><th>Statut</th><th>CoA</th></tr></thead>
          <tbody>
            {r.lots.map((l: any) => (
              <tr key={l.id}>
                <td><strong>{l.code_lot_interne}</strong></td>
                <td>{l.code_sku}<div className="secondaire">{l.designation}</div></td>
                <td>{l.code_lot_fournisseur ?? '—'}</td>
                <td>{fmtDate(l.dluo)}</td>
                <td className="num">{fmtNombre(l.qte_actuelle)} {l.unite}</td>
                <td className="num">{fmtMontant(l.cout_unitaire)}</td>
                <td><Badge valeur={l.statut} /></td>
                <td>{l.coa_fichier ? <a href={`/fichiers/${l.coa_fichier}`} target="_blank" rel="noreferrer">Ouvrir</a> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modale>
  );
}
