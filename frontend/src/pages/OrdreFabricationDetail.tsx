import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, fmtDateHeure, fmtEntier, fmtMontant, fmtNombre, fmtPct } from '../api';
import { useAuth } from '../auth';
import { Alerte, AlerteErreur, Badge, Champ, Chargement, Indicateur, Modale, useChargement, Vide } from '../composants/Ui';

/** Dossier de lot electronique : les trois etapes reglementaires de l'OF. */
export function OrdreFabricationDetail() {
  const { id } = useParams();
  const { peut } = useAuth();
  const dossier = useChargement(() => api.get(`/of/${id}`), [id]);
  const [erreur, setErreur] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [modale, setModale] = useState<'controle' | 'conditionnement' | null>(null);

  if (dossier.enCours && !dossier.donnees) return <Chargement />;
  if (dossier.erreur) return <AlerteErreur erreur={dossier.erreur} />;
  const o = dossier.donnees!;

  const action = async (fn: () => Promise<any>, texte: string) => {
    setErreur(null); setMessage(null);
    try { await fn(); setMessage(texte); dossier.recharger(); }
    catch (e) { setErreur(e); }
  };

  const etape = ['BROUILLON', 'PESEE'].includes(o.statut_of) ? 1
    : ['FABRICATION'].includes(o.statut_of) ? 2
    : ['VRAC_LIBERE', 'CONDITIONNEMENT'].includes(o.statut_of) ? 3 : 4;

  return (
    <>
      <section className="carte">
        <header>
          <div>
            <h2>{o.code_of} — {o.nom_produit} <Badge valeur={o.statut_of} /></h2>
            <div className="secondaire">
              Formule {o.code_formule} v{o.formule_version} · masse nette {fmtNombre(o.masse_cible_kg)} kg
              (brute {fmtNombre(o.masse_brute_kg)} kg, surdosage {fmtNombre(o.surdosage_pct)} %)
              {o.code_lot_vrac ? ` · vrac ${o.code_lot_vrac}` : ''}
            </div>
          </div>
          <div className="actions">
            <button className="bouton" onClick={() => api.ouvrirDocument(`/documents/of/${id}/bon-de-pesee`)}>Bon de pesee</button>
            <button className="bouton" onClick={() => api.ouvrirDocument(`/documents/of/${id}/dossier-de-lot`)}>Dossier de lot</button>
            {peut('production:peser') && etape === 1 && (
              <Link className="bouton primaire" to={`/production/${id}/pesee`}>Ouvrir l'ecran de pesee</Link>
            )}
          </div>
        </header>
        <div className="corps">
          <AlerteErreur erreur={erreur} />
          {message && <Alerte type="succes">{message}</Alerte>}
          <div className="grille quatre">
            <Indicateur libelle="Etape 1 — pesee atelier"
              valeur={`${o.avancement.lignes_pesees} / ${o.avancement.lignes_totales}`}
              detail={`${fmtNombre(o.avancement.masse_pesee_g)} g peses sur ${fmtNombre(o.avancement.masse_theorique_g)} g`}
              ton={o.avancement.pesees_completes ? 'succes' : undefined} />
            <Indicateur libelle="Etape 2 — controle de cuve"
              valeur={o.statut_vrac ? String(o.statut_vrac).replaceAll('_', ' ') : 'En attente'}
              detail={o.ph_mesure ? `pH ${o.ph_mesure} · ${fmtNombre(o.viscosite_mesuree, 0)} mPa·s` : undefined}
              ton={o.statut_vrac === 'LIBERE' ? 'succes' : o.statut_vrac === 'REJETE' ? 'danger' : undefined} />
            <Indicateur libelle="Etape 3 — conditionnement" valeur={fmtEntier(o.unites_produites)}
              detail={`${fmtEntier(o.unites_rebut)} rebut(s) · rendement ${o.rendement_pct ? fmtPct(o.rendement_pct) : '—'}`} />
            {peut('finance:lire') && (
              <Indicateur libelle="Cout de revient unitaire" valeur={o.cru ? fmtMontant(o.cru) : '—'}
                detail={o.cru ? `MP ${fmtMontant(o.cout_mp)} · AC ${fmtMontant(o.cout_ac)}` : 'Calcule a la cloture'} />
            )}
          </div>

          <div className="actions" style={{ marginTop: 16 }}>
            {peut('production:cuve') && o.statut_of === 'PESEE' && (
              <button className="bouton primaire" disabled={!o.avancement.pesees_completes}
                onClick={() => action(() => api.post(`/of/${id}/fabrication`, {}), 'Fabrication cloturee : matieres destockees et lot de vrac genere.')}>
                Cloturer la fabrication et generer le lot de vrac
              </button>
            )}
            {peut('stock:liberer') && o.statut_of === 'FABRICATION' && (
              <button className="bouton primaire" onClick={() => setModale('controle')}>Saisir le controle de cuve</button>
            )}
            {peut('production:conditionner') && ['VRAC_LIBERE', 'CONDITIONNEMENT'].includes(o.statut_of) && (
              <button className="bouton primaire" onClick={() => setModale('conditionnement')}>Declarer un conditionnement</button>
            )}
            {peut('production:cloturer') && o.statut_of === 'CONDITIONNEMENT' && (
              <button className="bouton primaire"
                onClick={() => action(() => api.post(`/of/${id}/cloturer`), "Ordre de fabrication cloture : cout de revient unitaire calcule.")}>
                Cloturer l'OF et calculer le CRU
              </button>
            )}
          </div>
          {!o.avancement.pesees_completes && o.statut_of === 'PESEE' && (
            <div style={{ marginTop: 12 }}>
              <Alerte type="attention" titre="Validation bloquante">
                Toutes les pesees doivent etre validees avant le passage en fabrication : {o.avancement.lignes_totales - o.avancement.lignes_pesees} ligne(s) restante(s).
              </Alerte>
            </div>
          )}
        </div>
      </section>

      <section className="carte">
        <header><h2>Etape 1 — fiche de fabrication et pesees</h2></header>
        <div className="corps sans-marge tableau-conteneur">
          <table className="tableau">
            <thead><tr><th>Phase</th><th>Matiere premiere</th><th className="num">Consigne</th><th className="num">Pese</th>
              <th className="num">Ecart</th><th>Lot(s) consomme(s)</th><th>Operateur</th><th>Consigne operatoire</th></tr></thead>
            <tbody>
              {o.lignes.map((l: any) => (
                <tr key={l.id} className={l.conforme === false ? 'limitant' : undefined}>
                  <td>{l.phase}</td>
                  <td><strong>{l.code_sku}</strong><div className="secondaire">{l.designation}</div></td>
                  <td className="num">{fmtNombre(l.masse_theorique_g)} g</td>
                  <td className="num">{l.poids_reel_pesee_g ? `${fmtNombre(l.poids_reel_pesee_g)} g` : '—'}</td>
                  <td className="num">{l.ecart_pct != null ? fmtPct(l.ecart_pct, 3) : '—'}</td>
                  <td>{l.code_lot_interne ?? '—'}
                    {l.dluo && <div className="secondaire">DLUO {fmtDate(l.dluo)}</div>}</td>
                  <td className="secondaire">{l.operateur ?? '—'}<div>{l.date_pesee ? fmtDateHeure(l.date_pesee) : ''}</div></td>
                  <td className="secondaire">{l.consigne ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {o.code_lot_vrac && (
        <section className="carte">
          <header><h2>Etape 2 — lot de vrac {o.code_lot_vrac} <Badge valeur={o.statut_vrac} /></h2></header>
          <div className="corps">
            <dl className="liste-descriptive">
              <dt>Masse nette</dt><dd>{fmtNombre(o.masse_nette_kg)} kg (restant {fmtNombre(o.masse_restante_kg)} kg)</dd>
              <dt>Melange</dt><dd>{fmtDateHeure(o.date_debut_melange)} → {fmtDateHeure(o.date_fin_melange)}</dd>
              <dt>pH mesure</dt><dd>{o.ph_mesure ?? '—'} {o.ph_min != null && <span className="secondaire">(specification {o.ph_min} – {o.ph_max})</span>}</dd>
              <dt>Viscosite</dt><dd>{o.viscosite_mesuree ? `${fmtNombre(o.viscosite_mesuree, 0)} mPa·s` : '—'}</dd>
              <dt>Aspect / couleur / odeur</dt><dd>{[o.aspect, o.couleur, o.odeur].filter(Boolean).join(' · ') || '—'}</dd>
              <dt>Liberation</dt><dd>{o.libere_par_nom ?? '—'} {o.libere_le ? `le ${fmtDateHeure(o.libere_le)}` : ''}</dd>
            </dl>
          </div>
        </section>
      )}

      {(o.conditionnement.length > 0 || o.lots_pf.length > 0) && (
        <section className="carte">
          <header><h2>Etape 3 — conditionnement et produits finis</h2></header>
          <div className="corps sans-marge tableau-conteneur">
            <table className="tableau">
              <thead><tr><th>Article de conditionnement</th><th>Lot</th><th className="num">Consomme</th><th className="num">Rebut</th></tr></thead>
              <tbody>
                {o.conditionnement.map((c: any) => (
                  <tr key={c.id}>
                    <td><strong>{c.code_sku}</strong><div className="secondaire">{c.designation}</div></td>
                    <td>{c.code_lot_interne}</td>
                    <td className="num">{fmtNombre(c.qte_consommee)}</td>
                    <td className="num">{fmtNombre(c.qte_rebut)}</td>
                  </tr>
                ))}
                {!o.conditionnement.length && <tr><td colSpan={4}><Vide texte="Conditionnement non declare." /></td></tr>}
              </tbody>
            </table>
            <table className="tableau">
              <thead><tr><th>Lot de produit fini</th><th>Article</th><th className="num">Unites produites</th>
                <th className="num">En stock</th><th>DLUO</th><th>Statut</th><th /></tr></thead>
              <tbody>
                {o.lots_pf.map((l: any) => (
                  <tr key={l.id}>
                    <td><strong>{l.code_lot_interne}</strong></td>
                    <td>{l.code_sku}<div className="secondaire">{l.designation}</div></td>
                    <td className="num">{fmtNombre(l.qte_initiale, 0)}</td>
                    <td className="num">{fmtNombre(l.qte_actuelle, 0)}</td>
                    <td>{fmtDate(l.dluo)}</td>
                    <td><Badge valeur={l.statut} /></td>
                    <td><button className="bouton petit" onClick={() => api.ouvrirDocument(`/documents/lots/${l.id}/etiquette`)}>Etiquette</button></td>
                  </tr>
                ))}
                {!o.lots_pf.length && <tr><td colSpan={7}><Vide texte="Aucun lot de produit fini genere." /></td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {peut('finance:lire') && o.statut_of === 'CLOTURE' && (
        <section className="carte">
          <header><h2>Cout de revient reel</h2></header>
          <div className="corps">
            <div className="grille quatre">
              <Indicateur libelle="Matieres premieres" valeur={fmtMontant(o.cout_mp)} />
              <Indicateur libelle="Articles de conditionnement" valeur={fmtMontant(o.cout_ac)} />
              <Indicateur libelle={`Main d'oeuvre (${fmtNombre(o.heures_production, 2)} h)`} valeur={fmtMontant(o.cout_main_oeuvre)} />
              <Indicateur libelle="Charges indirectes imputees" valeur={fmtMontant(o.cout_charges_indirectes)} />
              <Indicateur libelle="Unites conformes" valeur={fmtEntier(o.unites_produites)} />
              <Indicateur libelle="Cout de revient unitaire" valeur={fmtMontant(o.cru)} ton="succes" />
            </div>
          </div>
        </section>
      )}

      {modale === 'controle' && (
        <ModaleControleCuve ofId={Number(id)} formule={o} onFermer={() => setModale(null)}
          onFait={() => { setModale(null); dossier.recharger(); }} />
      )}
      {modale === 'conditionnement' && (
        <ModaleConditionnement ofId={Number(id)} of={o} onFermer={() => setModale(null)}
          onFait={() => { setModale(null); dossier.recharger(); }} />
      )}
    </>
  );
}

function ModaleControleCuve({ ofId, formule, onFermer, onFait }: { ofId: number; formule: any; onFermer: () => void; onFait: () => void }) {
  const [form, setForm] = useState<any>({ conforme_organoleptique: true, aspect: '', couleur: '', odeur: '' });
  const [erreur, setErreur] = useState<unknown>(null);

  const soumettre = async (decision: 'LIBERE' | 'REJETE') => {
    setErreur(null);
    try {
      await api.post(`/of/${ofId}/vrac/controle`, {
        ph_mesure: Number(form.ph_mesure),
        viscosite_mesuree: form.viscosite_mesuree ? Number(form.viscosite_mesuree) : null,
        aspect: form.aspect, couleur: form.couleur, odeur: form.odeur,
        conforme_organoleptique: form.conforme_organoleptique,
        decision, commentaire: form.commentaire || null,
      });
      onFait();
    } catch (e) { setErreur(e); }
  };

  return (
    <Modale titre="Controle de liberation du vrac" onFermer={onFermer}
      actions={<>
        <button className="bouton" onClick={onFermer}>Annuler</button>
        <button className="bouton danger" onClick={() => soumettre('REJETE')}>Rejeter le vrac</button>
        <button className="bouton primaire" onClick={() => soumettre('LIBERE')}>Liberer le vrac</button>
      </>}>
      <AlerteErreur erreur={erreur} />
      <Alerte type="info">
        Specification de la formule : pH {formule.ph_min ?? '—'} – {formule.ph_max ?? '—'},
        viscosite {formule.viscosite_min ? `${fmtNombre(formule.viscosite_min, 0)} – ${fmtNombre(formule.viscosite_max, 0)} mPa·s` : '—'}.
        Une liberation hors specification est refusee par le systeme.
      </Alerte>
      <div className="ligne-champs">
        <Champ libelle="pH mesure" obligatoire>
          <input type="number" step="0.01" value={form.ph_mesure ?? ''} onChange={(e) => setForm({ ...form, ph_mesure: e.target.value })} />
        </Champ>
        <Champ libelle="Viscosite mesuree (mPa·s)">
          <input type="number" step="1" value={form.viscosite_mesuree ?? ''} onChange={(e) => setForm({ ...form, viscosite_mesuree: e.target.value })} />
        </Champ>
      </div>
      <div className="ligne-champs" style={{ marginTop: 12 }}>
        <Champ libelle="Aspect" obligatoire><input value={form.aspect} onChange={(e) => setForm({ ...form, aspect: e.target.value })} placeholder="Creme onctueuse homogene" /></Champ>
        <Champ libelle="Couleur" obligatoire><input value={form.couleur} onChange={(e) => setForm({ ...form, couleur: e.target.value })} placeholder="Blanc nacre" /></Champ>
        <Champ libelle="Odeur" obligatoire><input value={form.odeur} onChange={(e) => setForm({ ...form, odeur: e.target.value })} placeholder="Caracteristique" /></Champ>
      </div>
      <div style={{ marginTop: 12 }}>
        <Champ libelle="Controle organoleptique">
          <select value={String(form.conforme_organoleptique)} onChange={(e) => setForm({ ...form, conforme_organoleptique: e.target.value === 'true' })}>
            <option value="true">Conforme</option>
            <option value="false">Non conforme</option>
          </select>
        </Champ>
      </div>
      <div style={{ marginTop: 12 }}>
        <Champ libelle="Commentaire qualite">
          <textarea value={form.commentaire ?? ''} onChange={(e) => setForm({ ...form, commentaire: e.target.value })} />
        </Champ>
      </div>
    </Modale>
  );
}

function ModaleConditionnement({ ofId, of, onFermer, onFait }: { ofId: number; of: any; onFermer: () => void; onFait: () => void }) {
  const lotsAc = useChargement(() => api.get('/lots?type=AC&statut=CONFORME&disponible=true'));
  const nomenclature = useChargement(() => (of.article_pf_id ? api.get(`/articles/${of.article_pf_id}`) : Promise.resolve(null)));
  const [unites, setUnites] = useState('');
  const [rebut, setRebut] = useState('0');
  const [dluo, setDluo] = useState('');
  const [consommations, setConsommations] = useState<any[]>([]);
  const [erreur, setErreur] = useState<unknown>(null);

  // Pre-remplissage a partir de la nomenclature du produit fini : un lot
  // conforme est propose par defaut pour chaque article de conditionnement.
  useEffect(() => {
    if (consommations.length || !nomenclature.donnees || !lotsAc.donnees) return;
    const composants = nomenclature.donnees.nomenclature ?? [];
    setConsommations(composants.map((c: any) => {
      const lot = (lotsAc.donnees ?? []).find((l: any) => l.article_id === c.article_ac_id);
      return {
        article_ac_id: c.article_ac_id, code_sku: c.code_sku, designation: c.designation,
        qte_par_unite: Number(c.qte_par_unite), lot_stock_id: lot?.id ?? '', qte_rebut: '0',
      };
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nomenclature.donnees, lotsAc.donnees]);

  const soumettre = async () => {
    setErreur(null);
    try {
      await api.post(`/of/${ofId}/conditionnement`, {
        unites_produites: Number(unites),
        unites_rebut: Number(rebut || 0),
        dluo: dluo || null,
        consommations: consommations.map((c) => ({
          article_ac_id: c.article_ac_id,
          lot_stock_id: Number(c.lot_stock_id),
          qte_consommee: Number(unites) * c.qte_par_unite,
          qte_rebut: Number(c.qte_rebut || 0),
        })),
      });
      onFait();
    } catch (e) { setErreur(e); }
  };

  return (
    <Modale large titre="Declaration de conditionnement" onFermer={onFermer}
      actions={<><button className="bouton" onClick={onFermer}>Annuler</button>
        <button className="bouton primaire" onClick={soumettre} disabled={!unites || !consommations.length}>
          Declarer et generer le lot de produit fini</button></>}>
      <AlerteErreur erreur={erreur} />
      <Alerte type="info">
        Vrac {of.code_lot_vrac} — {fmtNombre(of.masse_restante_kg)} kg restants.
        Le lot de produit fini genere restera rattache a ce lot de vrac (tracabilite ascendante).
      </Alerte>
      <div className="ligne-champs">
        <Champ libelle="Unites conformes produites" obligatoire>
          <input type="number" min="1" value={unites} onChange={(e) => setUnites(e.target.value)} />
        </Champ>
        <Champ libelle="Unites rebutees">
          <input type="number" min="0" value={rebut} onChange={(e) => setRebut(e.target.value)} />
        </Champ>
        <Champ libelle="DLUO du produit fini">
          <input type="date" value={dluo} onChange={(e) => setDluo(e.target.value)} />
        </Champ>
      </div>
      <h3 style={{ margin: '18px 0 8px' }}>Articles de conditionnement consommes</h3>
      <div className="tableau-conteneur">
        <table className="tableau">
          <thead><tr><th>Article</th><th className="num">Par unite</th><th className="num">Total consomme</th><th>Lot</th><th className="num">Rebut packaging</th></tr></thead>
          <tbody>
            {consommations.map((c, i) => (
              <tr key={c.article_ac_id}>
                <td><strong>{c.code_sku}</strong><div className="secondaire">{c.designation}</div></td>
                <td className="num">{fmtNombre(c.qte_par_unite)}</td>
                <td className="num">{unites ? fmtNombre(Number(unites) * c.qte_par_unite, 0) : '—'}</td>
                <td>
                  <select value={c.lot_stock_id} onChange={(e) => {
                    const copie = [...consommations]; copie[i] = { ...c, lot_stock_id: e.target.value }; setConsommations(copie);
                  }}>
                    <option value="">Selectionner…</option>
                    {(lotsAc.donnees ?? []).filter((l: any) => l.article_id === c.article_ac_id).map((l: any) => (
                      <option key={l.id} value={l.id}>{l.code_lot_interne} ({fmtNombre(l.qte_actuelle, 0)} U)</option>
                    ))}
                  </select>
                </td>
                <td className="num">
                  <input type="number" min="0" value={c.qte_rebut} style={{ textAlign: 'right' }} onChange={(e) => {
                    const copie = [...consommations]; copie[i] = { ...c, qte_rebut: e.target.value }; setConsommations(copie);
                  }} />
                </td>
              </tr>
            ))}
            {!consommations.length && <tr><td colSpan={5}><Vide texte="Nomenclature de conditionnement non definie pour ce produit fini." /></td></tr>}
          </tbody>
        </table>
      </div>
    </Modale>
  );
}
