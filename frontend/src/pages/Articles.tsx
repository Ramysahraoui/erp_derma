import { useState } from 'react';
import { api, fmtMontant, fmtNombre } from '../api';
import { useAuth } from '../auth';
import { Alerte, AlerteErreur, Badge, Champ, Chargement, Modale, useChargement, Vide } from '../composants/Ui';

const UNITES: Record<string, string[]> = { MP: ['kg', 'g', 'L', 'ml'], AC: ['U'], PF: ['U'] };

export function Articles() {
  const { peut } = useAuth();
  const [type, setType] = useState('');
  const [recherche, setRecherche] = useState('');
  const [creation, setCreation] = useState(false);
  const [detail, setDetail] = useState<number | null>(null);

  const liste = useChargement(
    () => api.get(`/articles?${new URLSearchParams({ ...(type ? { type } : {}), ...(recherche ? { recherche } : {}) })}`),
    [type, recherche],
  );

  return (
    <>
      <div className="barre-filtres">
        <Champ libelle="Recherche">
          <input value={recherche} onChange={(e) => setRecherche(e.target.value)} placeholder="Code SKU ou designation" />
        </Champ>
        <Champ libelle="Categorie">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Toutes</option>
            <option value="MP">Matieres premieres</option>
            <option value="AC">Articles de conditionnement</option>
            <option value="PF">Produits finis</option>
          </select>
        </Champ>
        <div style={{ flex: 1 }} />
        {peut('article:ecrire') && <button className="bouton primaire" onClick={() => setCreation(true)}>Nouvel article</button>}
      </div>

      <section className="carte">
        <div className="corps sans-marge tableau-conteneur">
          {liste.enCours && !liste.donnees ? <Chargement /> : liste.erreur ? <AlerteErreur erreur={liste.erreur} /> :
            !liste.donnees?.length ? <Vide /> : (
            <table className="tableau">
              <thead>
                <tr>
                  <th>Code SKU</th><th>Designation</th><th>Type</th>
                  <th className="num">Disponible</th><th className="num">Quarantaine</th>
                  <th className="num">Seuil</th><th className="num">PAMP</th><th className="num">Prix de vente</th>
                </tr>
              </thead>
              <tbody>
                {liste.donnees.map((a: any) => (
                  <tr key={a.id} className="cliquable" onClick={() => setDetail(a.id)}>
                    <td><strong>{a.code_sku}</strong></td>
                    <td>{a.designation}<div className="secondaire">{a.nom_inci ?? ''}</div></td>
                    <td><Badge valeur={a.type} classe="info" /></td>
                    <td className="num" style={a.sous_seuil ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>
                      {fmtNombre(a.qte_disponible)} {a.unite}
                    </td>
                    <td className="num">{fmtNombre(a.qte_quarantaine)}</td>
                    <td className="num">{fmtNombre(a.seuil_critique)}</td>
                    <td className="num">{fmtMontant(a.pamp)}</td>
                    <td className="num">{a.type === 'PF' ? fmtMontant(a.prix_vente_ht) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {creation && <ModaleArticle onFermer={() => setCreation(false)} onCree={() => { setCreation(false); liste.recharger(); }} />}
      {detail && <ModaleDetail id={detail} onFermer={() => setDetail(null)} onMaj={liste.recharger} />}
    </>
  );
}

function ModaleArticle({ onFermer, onCree }: { onFermer: () => void; onCree: () => void }) {
  const [form, setForm] = useState<any>({ type: 'MP', unite: 'kg', seuil_critique: 0, prix_vente_ht: 0, tva_pct: 19 });
  const [erreur, setErreur] = useState<unknown>(null);
  const maj = (champ: string, valeur: unknown) => setForm((f: any) => ({ ...f, [champ]: valeur }));

  const enregistrer = async () => {
    setErreur(null);
    try {
      await api.post('/articles', {
        ...form,
        contenance_ml: form.type === 'PF' ? Number(form.contenance_ml) || null : null,
        densite: form.type === 'MP' && form.densite ? Number(form.densite) : null,
      });
      onCree();
    } catch (e) { setErreur(e); }
  };

  return (
    <Modale titre="Nouvel article" onFermer={onFermer}
      actions={<><button className="bouton" onClick={onFermer}>Annuler</button>
        <button className="bouton primaire" onClick={enregistrer}>Creer l'article</button></>}>
      <AlerteErreur erreur={erreur} />
      <div className="ligne-champs">
        <Champ libelle="Categorie" obligatoire>
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value, unite: UNITES[e.target.value][0] })}>
            <option value="MP">Matiere premiere</option>
            <option value="AC">Article de conditionnement</option>
            <option value="PF">Produit fini</option>
          </select>
        </Champ>
        <Champ libelle="Code SKU" obligatoire>
          <input value={form.code_sku ?? ''} onChange={(e) => maj('code_sku', e.target.value.toUpperCase())} placeholder="MP-XXX-001" />
        </Champ>
        <Champ libelle="Unite" obligatoire>
          <select value={form.unite} onChange={(e) => maj('unite', e.target.value)}>
            {UNITES[form.type].map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </Champ>
      </div>
      <div style={{ marginTop: 12 }}>
        <Champ libelle="Designation" obligatoire>
          <input value={form.designation ?? ''} onChange={(e) => maj('designation', e.target.value)} />
        </Champ>
      </div>
      <div className="ligne-champs" style={{ marginTop: 12 }}>
        {form.type === 'MP' && (
          <>
            <Champ libelle="Nom INCI"><input value={form.nom_inci ?? ''} onChange={(e) => maj('nom_inci', e.target.value)} /></Champ>
            <Champ libelle="Masse volumique (g/ml)" aide="Pour les matieres achetees au volume">
              <input type="number" step="0.0001" value={form.densite ?? ''} onChange={(e) => maj('densite', e.target.value)} />
            </Champ>
          </>
        )}
        {form.type === 'PF' && (
          <>
            <Champ libelle="Contenance (ml)" obligatoire>
              <input type="number" step="0.001" value={form.contenance_ml ?? ''} onChange={(e) => maj('contenance_ml', e.target.value)} />
            </Champ>
            <Champ libelle="Prix de vente HT">
              <input type="number" step="0.01" value={form.prix_vente_ht} onChange={(e) => maj('prix_vente_ht', e.target.value)} />
            </Champ>
          </>
        )}
        <Champ libelle="Seuil critique">
          <input type="number" step="0.001" value={form.seuil_critique} onChange={(e) => maj('seuil_critique', e.target.value)} />
        </Champ>
      </div>
    </Modale>
  );
}

function ModaleDetail({ id, onFermer, onMaj }: { id: number; onFermer: () => void; onMaj: () => void }) {
  const { peut } = useAuth();
  const detail = useChargement(() => api.get(`/articles/${id}`), [id]);
  const tousAc = useChargement(() => api.get('/articles?type=AC'));
  const [nomenclature, setNomenclature] = useState<any[] | null>(null);
  const [erreur, setErreur] = useState<unknown>(null);

  if (detail.enCours && !detail.donnees) return <Modale titre="Article" onFermer={onFermer}><Chargement /></Modale>;
  if (detail.erreur) return <Modale titre="Article" onFermer={onFermer}><AlerteErreur erreur={detail.erreur} /></Modale>;
  const a = detail.donnees!;
  const lignes = nomenclature ?? a.nomenclature ?? [];

  const enregistrerNomenclature = async () => {
    setErreur(null);
    try {
      await api.put(`/articles/${id}/nomenclature`, lignes.map((l: any) => ({
        article_ac_id: Number(l.article_ac_id), qte_par_unite: Number(l.qte_par_unite), obligatoire: true,
      })));
      detail.recharger();
      setNomenclature(null);
      onMaj();
    } catch (e) { setErreur(e); }
  };

  return (
    <Modale large titre={`${a.code_sku} — ${a.designation}`} onFermer={onFermer}>
      <AlerteErreur erreur={erreur} />
      <dl className="liste-descriptive">
        <dt>Categorie</dt><dd><Badge valeur={a.type} classe="info" /></dd>
        <dt>Unite de gestion</dt><dd>{a.unite}</dd>
        {a.nom_inci && <><dt>Nom INCI</dt><dd>{a.nom_inci}</dd></>}
        {a.contenance_ml && <><dt>Contenance</dt><dd>{fmtNombre(a.contenance_ml)} ml</dd></>}
        <dt>Stock disponible</dt><dd>{fmtNombre(a.qte_disponible)} {a.unite}</dd>
        <dt>Quarantaine / bloque</dt><dd>{fmtNombre(a.qte_quarantaine)} / {fmtNombre(a.qte_bloquee)} {a.unite}</dd>
        <dt>PAMP</dt><dd>{fmtMontant(a.pamp)}</dd>
        <dt>Valeur du stock</dt><dd>{fmtMontant(a.valeur_stock)}</dd>
      </dl>

      {a.type === 'PF' && (
        <>
          <h3 style={{ marginTop: 20 }}>Nomenclature de conditionnement</h3>
          <div className="tableau-conteneur">
            <table className="tableau">
              <thead><tr><th>Article de conditionnement</th><th className="num">Quantite par unite</th>{peut('article:ecrire') && <th />}</tr></thead>
              <tbody>
                {lignes.map((l: any, i: number) => (
                  <tr key={i}>
                    <td>
                      {peut('article:ecrire') ? (
                        <select value={l.article_ac_id} onChange={(e) => {
                          const copie = [...lignes]; copie[i] = { ...l, article_ac_id: e.target.value }; setNomenclature(copie);
                        }}>
                          {(tousAc.donnees ?? []).map((ac: any) => <option key={ac.id} value={ac.id}>{ac.code_sku} — {ac.designation}</option>)}
                        </select>
                      ) : `${l.code_sku} — ${l.designation}`}
                    </td>
                    <td className="num">
                      {peut('article:ecrire') ? (
                        <input type="number" step="0.001" value={l.qte_par_unite} onChange={(e) => {
                          const copie = [...lignes]; copie[i] = { ...l, qte_par_unite: e.target.value }; setNomenclature(copie);
                        }} />
                      ) : fmtNombre(l.qte_par_unite)}
                    </td>
                    {peut('article:ecrire') && (
                      <td><button className="bouton petit danger" onClick={() => setNomenclature(lignes.filter((_: any, j: number) => j !== i))}>Retirer</button></td>
                    )}
                  </tr>
                ))}
                {lignes.length === 0 && <tr><td colSpan={3}><Vide texte="Aucun article de conditionnement associe." /></td></tr>}
              </tbody>
            </table>
          </div>
          {peut('article:ecrire') && (
            <div className="actions" style={{ marginTop: 10 }}>
              <button className="bouton petit" onClick={() => setNomenclature([...lignes, { article_ac_id: tousAc.donnees?.[0]?.id, qte_par_unite: 1 }])}>
                Ajouter un composant
              </button>
              <button className="bouton petit primaire" onClick={enregistrerNomenclature} disabled={!nomenclature}>Enregistrer la nomenclature</button>
            </div>
          )}
        </>
      )}

      <h3 style={{ marginTop: 20 }}>Lots en stock</h3>
      <div className="tableau-conteneur">
        <table className="tableau">
          <thead><tr><th>Lot interne</th><th>Lot fournisseur</th><th>DLUO</th><th>Statut</th><th className="num">Quantite</th><th className="num">Cout unitaire</th></tr></thead>
          <tbody>
            {a.lots.map((l: any) => (
              <tr key={l.id}>
                <td><strong>{l.code_lot_interne}</strong></td>
                <td>{l.code_lot_fournisseur ?? '—'}</td>
                <td>{l.dluo ? new Date(l.dluo).toLocaleDateString('fr-FR') : '—'}</td>
                <td><Badge valeur={l.statut} /></td>
                <td className="num">{fmtNombre(l.qte_actuelle)} {a.unite}</td>
                <td className="num">{fmtMontant(l.cout_unitaire)}</td>
              </tr>
            ))}
            {a.lots.length === 0 && <tr><td colSpan={6}><Vide texte="Aucun lot en stock." /></td></tr>}
          </tbody>
        </table>
      </div>
      {a.type === 'PF' && a.lots.length === 0 && (
        <Alerte type="info" titre="Produit fini">
          Un lot de produit fini ne peut naitre que du conditionnement d'un lot de vrac libere par le controle qualite.
        </Alerte>
      )}
    </Modale>
  );
}
