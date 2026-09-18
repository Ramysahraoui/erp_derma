import { codeBarresSvg } from './codebarres.js';
import { d, m2, q3 } from '../../core/nombres.js';
import { env } from '../../env.js';

const echapper = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const dateFr = (v: unknown): string => {
  if (!v) return '—';
  const date = new Date(String(v));
  return Number.isNaN(date.getTime()) ? String(v) : date.toLocaleDateString('fr-FR');
};
const dateHeureFr = (v: unknown): string => {
  if (!v) return '—';
  const date = new Date(String(v));
  return Number.isNaN(date.getTime()) ? String(v) : date.toLocaleString('fr-FR');
};
const montant = (v: unknown): string =>
  `${Number(m2(v as string)).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${env.devise}`;

const STYLE = `
  @page { size: A4; margin: 14mm 12mm 16mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 10.5px; color: #16202b; margin: 0; }
  h1 { font-size: 17px; margin: 0 0 2px; letter-spacing: .3px; }
  h2 { font-size: 12px; margin: 14px 0 6px; padding-bottom: 3px; border-bottom: 1.5px solid #0f766e; color: #0f766e;
       text-transform: uppercase; letter-spacing: .6px; }
  .entete { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0f766e; padding-bottom: 8px; }
  .societe { font-size: 10px; color: #475569; line-height: 1.45; }
  .piece { text-align: right; }
  .piece .num { font-size: 15px; font-weight: 700; color: #0f766e; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 9px; font-size: 9px; font-weight: 700;
           border: 1px solid currentColor; text-transform: uppercase; letter-spacing: .4px; }
  .ok { color: #047857; } .attention { color: #b45309; } .ko { color: #b91c1c; } .neutre { color: #475569; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th { background: #f1f5f9; text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: .4px;
       padding: 5px 6px; border-bottom: 1px solid #cbd5e1; }
  td { padding: 4.5px 6px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .grille { display: flex; gap: 10px; flex-wrap: wrap; }
  .carte { flex: 1 1 30%; border: 1px solid #e2e8f0; border-radius: 6px; padding: 7px 9px; background: #f8fafc; }
  .carte .libelle { font-size: 8.5px; text-transform: uppercase; color: #64748b; letter-spacing: .5px; }
  .carte .valeur { font-size: 13px; font-weight: 700; margin-top: 2px; }
  .signatures { display: flex; gap: 16px; margin-top: 22px; }
  .signature { flex: 1; border: 1px dashed #94a3b8; border-radius: 6px; height: 68px; padding: 5px 8px; font-size: 9px; color: #64748b; }
  .pied { position: fixed; bottom: 0; left: 0; right: 0; font-size: 8.5px; color: #64748b;
          border-top: 1px solid #e2e8f0; padding-top: 4px; display: flex; justify-content: space-between; }
  .mention { font-size: 9px; color: #64748b; margin-top: 8px; font-style: italic; }
  .totaux { width: 46%; margin-left: auto; margin-top: 8px; }
  .totaux td { border: none; padding: 3px 6px; }
  .totaux .ttc { font-weight: 700; font-size: 12.5px; border-top: 1.5px solid #0f766e; color: #0f766e; }
  .phase { background: #ecfdf5; font-weight: 700; color: #065f46; }
  .hors-tolerance { color: #b91c1c; font-weight: 700; }
`;

export interface EnteteSociete {
  nom: string; adresse?: string; telephone?: string; email?: string; rc?: string; nif?: string;
}

const SOCIETE: EnteteSociete = {
  nom: process.env.SOCIETE_NOM ?? 'Laboratoire Dermo-Cosmetique',
  adresse: process.env.SOCIETE_ADRESSE ?? 'Zone industrielle — Unite de fabrication',
  telephone: process.env.SOCIETE_TEL ?? '',
  email: process.env.SOCIETE_EMAIL ?? '',
  rc: process.env.SOCIETE_RC ?? '',
  nif: process.env.SOCIETE_NIF ?? '',
};

function layout(titre: string, sousTitre: string, corps: string, reference: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${echapper(titre)}</title><style>${STYLE}</style></head>
<body>
  <div class="entete">
    <div>
      <h1>${echapper(SOCIETE.nom)}</h1>
      <div class="societe">
        ${echapper(SOCIETE.adresse)}<br>
        ${[SOCIETE.telephone, SOCIETE.email].filter(Boolean).map(echapper).join(' — ')}
        ${SOCIETE.rc ? `<br>RC : ${echapper(SOCIETE.rc)}` : ''}${SOCIETE.nif ? ` — NIF : ${echapper(SOCIETE.nif)}` : ''}
      </div>
    </div>
    <div class="piece">
      <div class="num">${echapper(titre)}</div>
      <div class="societe">${sousTitre}</div>
    </div>
  </div>
  ${corps}
  <div class="pied">
    <span>${echapper(SOCIETE.nom)} — document genere par le systeme de gestion integre</span>
    <span>${echapper(reference)} — edite le ${dateHeureFr(new Date().toISOString())}</span>
  </div>
</body></html>`;
}

const badgeStatut = (statut: string): string => {
  const classe = ['CONFORME', 'LIBERE', 'VALIDE', 'SOLDEE', 'CLOTURE'].includes(statut)
    ? 'ok'
    : ['QUARANTAINE', 'PARTIELLE', 'BROUILLON'].includes(statut)
      ? 'attention'
      : ['REJETE', 'BLOQUE', 'ANNULE', 'NON_PAYEE'].includes(statut)
        ? 'ko'
        : 'neutre';
  return `<span class="badge ${classe}">${echapper(String(statut).replaceAll('_', ' '))}</span>`;
};

// ---------------------------------------------------------------------
// Bon de pesee (atelier)
// ---------------------------------------------------------------------
export function modeleBonDePesee(dossier: any): string {
  const lignes = dossier.lignes
    .map(
      (l: any) => `<tr>
        <td>${echapper(l.phase)}</td>
        <td><strong>${echapper(l.code_sku)}</strong><br><span class="societe">${echapper(l.designation)}</span></td>
        <td class="num">${q3(l.masse_theorique_g)} g</td>
        <td class="num">${l.poids_reel_pesee_g ? `${q3(l.poids_reel_pesee_g)} g` : '____________'}</td>
        <td class="num ${l.ecart_pct && !l.conforme ? 'hors-tolerance' : ''}">${l.ecart_pct != null ? `${Number(l.ecart_pct).toFixed(3)} %` : '—'}</td>
        <td>${echapper(l.code_lot_interne ?? '____________')}</td>
        <td>${echapper(l.consigne ?? '')}</td>
      </tr>`,
    )
    .join('');
  const corps = `
    <div class="grille" style="margin-top:12px">
      <div class="carte"><div class="libelle">Ordre de fabrication</div><div class="valeur">${echapper(dossier.code_of)}</div></div>
      <div class="carte"><div class="libelle">Formule</div><div class="valeur">${echapper(dossier.code_formule)} v${echapper(dossier.formule_version)}</div></div>
      <div class="carte"><div class="libelle">Masse brute a peser</div><div class="valeur">${q3(dossier.masse_brute_kg)} kg</div></div>
      <div class="carte"><div class="libelle">Tolerance de pesee</div><div class="valeur">± ${Number(dossier.tolerance_pesee_pct).toFixed(3)} %</div></div>
    </div>
    <h2>Fiche de pesee — ${echapper(dossier.nom_produit)}</h2>
    <table>
      <thead><tr>
        <th>Phase</th><th>Matiere premiere</th><th class="num">Consigne</th><th class="num">Pesee reelle</th>
        <th class="num">Ecart</th><th>Lot interne</th><th>Consigne operatoire</th>
      </tr></thead>
      <tbody>${lignes}</tbody>
    </table>
    <p class="mention">Masse cible nette : ${q3(dossier.masse_cible_kg)} kg — surdosage technique applique : ${Number(dossier.surdosage_pct).toFixed(3)} %.
    Toute pesee hors tolerance doit etre validee par le responsable qualite avant poursuite de la fabrication.</p>
    <div class="signatures">
      <div class="signature">Operateur de pesee<br>Nom, date et visa</div>
      <div class="signature">Verification (double controle)<br>Nom, date et visa</div>
      <div class="signature">Responsable qualite<br>Nom, date et visa</div>
    </div>`;
  return layout(`BON DE PESEE ${dossier.code_of}`, `Emis le ${dateFr(dossier.cree_le)}`, corps, dossier.code_of);
}

// ---------------------------------------------------------------------
// Fiche suiveuse de cuve / dossier de lot electronique
// ---------------------------------------------------------------------
export function modeleFicheSuiveuse(dossier: any): string {
  const pesees = dossier.lignes
    .map(
      (l: any) => `<tr>
        <td>${echapper(l.phase)}</td>
        <td><strong>${echapper(l.code_sku)}</strong><br><span class="societe">${echapper(l.designation)}</span></td>
        <td class="num">${q3(l.masse_theorique_g)}</td>
        <td class="num">${l.poids_reel_pesee_g ? q3(l.poids_reel_pesee_g) : '—'}</td>
        <td class="num ${l.conforme === false ? 'hors-tolerance' : ''}">${l.ecart_pct != null ? Number(l.ecart_pct).toFixed(3) : '—'}</td>
        <td>${echapper(l.code_lot_interne ?? '—')}<br><span class="societe">${echapper(l.code_lot_fournisseur ?? '')}</span></td>
        <td>${dateFr(l.dluo)}</td>
        <td>${echapper(l.operateur ?? '—')}<br><span class="societe">${dateHeureFr(l.date_pesee)}</span></td>
      </tr>`,
    )
    .join('');
  const conditionnement = dossier.conditionnement.length
    ? dossier.conditionnement
        .map(
          (c: any) => `<tr>
            <td><strong>${echapper(c.code_sku)}</strong> — ${echapper(c.designation)}</td>
            <td>${echapper(c.code_lot_interne)}</td>
            <td class="num">${q3(c.qte_consommee)}</td>
            <td class="num">${q3(c.qte_rebut)}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="4">Conditionnement non declare.</td></tr>';
  const lotsPf = dossier.lots_pf.length
    ? dossier.lots_pf
        .map(
          (l: any) => `<tr><td>${echapper(l.code_lot_interne)}</td><td>${echapper(l.code_sku)}</td>
            <td class="num">${q3(l.qte_initiale)}</td><td>${dateFr(l.dluo)}</td><td>${badgeStatut(l.statut)}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="5">Aucun lot de produit fini genere.</td></tr>';

  const corps = `
    <div class="grille" style="margin-top:12px">
      <div class="carte"><div class="libelle">Ordre de fabrication</div><div class="valeur">${echapper(dossier.code_of)}</div></div>
      <div class="carte"><div class="libelle">Lot de vrac</div><div class="valeur">${echapper(dossier.code_lot_vrac ?? '—')}</div></div>
      <div class="carte"><div class="libelle">Statut</div><div class="valeur">${badgeStatut(dossier.statut_of)}</div></div>
      <div class="carte"><div class="libelle">Rendement reel</div><div class="valeur">${dossier.rendement_pct ? `${Number(dossier.rendement_pct).toFixed(2)} %` : '—'}</div></div>
    </div>
    <h2>Identification</h2>
    <table>
      <tr><th style="width:22%">Produit</th><td>${echapper(dossier.nom_produit)} ${dossier.pf_code_sku ? `(${echapper(dossier.pf_code_sku)})` : ''}</td>
          <th style="width:22%">Formule</th><td>${echapper(dossier.code_formule)} version ${echapper(dossier.formule_version)}</td></tr>
      <tr><th>Masse nette cible</th><td>${q3(dossier.masse_cible_kg)} kg (brute ${q3(dossier.masse_brute_kg)} kg)</td>
          <th>Densite</th><td>${Number(dossier.densite).toFixed(4)}</td></tr>
      <tr><th>Debut de melange</th><td>${dateHeureFr(dossier.date_debut_melange)}</td>
          <th>Fin de melange</th><td>${dateHeureFr(dossier.date_fin_melange)}</td></tr>
      <tr><th>Ouvert par</th><td>${echapper(dossier.cree_par_nom ?? '—')}</td>
          <th>Cloture le</th><td>${dateHeureFr(dossier.date_cloture)}</td></tr>
    </table>
    <h2>Etape 1 — Pesees matieres premieres</h2>
    <table>
      <thead><tr><th>Phase</th><th>Matiere</th><th class="num">Theorique (g)</th><th class="num">Reel (g)</th>
        <th class="num">Ecart (%)</th><th>Lot consomme</th><th>DLUO</th><th>Operateur</th></tr></thead>
      <tbody>${pesees}</tbody>
    </table>
    <h2>Etape 2 — Controle de liberation du vrac</h2>
    <table>
      <tr><th style="width:22%">pH mesure</th><td>${dossier.ph_mesure ?? '—'} ${dossier.ph_min != null ? `<span class="societe">(intervalle ${dossier.ph_min} – ${dossier.ph_max})</span>` : ''}</td>
          <th style="width:22%">Viscosite</th><td>${dossier.viscosite_mesuree ? Number(dossier.viscosite_mesuree).toLocaleString('fr-FR') : '—'} mPa·s ${dossier.viscosite_min != null ? `<span class="societe">(${Number(dossier.viscosite_min).toLocaleString('fr-FR')} – ${Number(dossier.viscosite_max).toLocaleString('fr-FR')})</span>` : ''}</td></tr>
      <tr><th>Aspect</th><td>${echapper(dossier.aspect ?? '—')}</td><th>Couleur</th><td>${echapper(dossier.couleur ?? '—')}</td></tr>
      <tr><th>Odeur</th><td>${echapper(dossier.odeur ?? '—')}</td><th>Organoleptique</th><td>${dossier.conforme_organoleptique === null || dossier.conforme_organoleptique === undefined ? '—' : dossier.conforme_organoleptique ? badgeStatut('CONFORME') : badgeStatut('REJETE')}</td></tr>
      <tr><th>Decision</th><td>${badgeStatut(dossier.statut_vrac ?? 'EN_COURS')}</td>
          <th>Liberation</th><td>${dossier.libere_le ? `${echapper(dossier.libere_par_nom ?? '')} — ${dateHeureFr(dossier.libere_le)}` : 'Non liberee'}</td></tr>
    </table>
    <h2>Etape 3 — Conditionnement</h2>
    <table>
      <thead><tr><th>Article de conditionnement</th><th>Lot</th><th class="num">Consomme</th><th class="num">Rebut</th></tr></thead>
      <tbody>${conditionnement}</tbody>
    </table>
    <table style="margin-top:8px">
      <thead><tr><th>Lot de produit fini</th><th>Reference</th><th class="num">Unites</th><th>DLUO</th><th>Statut</th></tr></thead>
      <tbody>${lotsPf}</tbody>
    </table>
    ${
      dossier.cru
        ? `<h2>Cout de revient reel</h2>
    <table>
      <tr><th>Matieres premieres</th><td class="num">${montant(dossier.cout_mp)}</td>
          <th>Articles de conditionnement</th><td class="num">${montant(dossier.cout_ac)}</td></tr>
      <tr><th>Main d'oeuvre (${Number(dossier.heures_production).toFixed(2)} h)</th><td class="num">${montant(dossier.cout_main_oeuvre)}</td>
          <th>Charges indirectes</th><td class="num">${montant(dossier.cout_charges_indirectes)}</td></tr>
      <tr><th>Unites conformes</th><td class="num">${dossier.unites_produites}</td>
          <th>Cout de revient unitaire</th><td class="num"><strong>${montant(dossier.cru)}</strong></td></tr>
    </table>`
        : ''
    }
    <div class="signatures">
      <div class="signature">Production<br>Nom, date et visa</div>
      <div class="signature">Controle qualite<br>Nom, date et visa</div>
      <div class="signature">Liberation finale<br>Nom, date et visa</div>
    </div>`;
  return layout(`DOSSIER DE LOT ${dossier.code_of}`, `Fiche suiveuse de cuve — ${echapper(dossier.code_lot_vrac ?? 'vrac non genere')}`, corps, dossier.code_of);
}

// ---------------------------------------------------------------------
// Bon de livraison / facture
// ---------------------------------------------------------------------
export function modeleDocumentVente(doc: any): string {
  const estBl = doc.type_doc === 'BL';
  const titres: Record<string, string> = { DEVIS: 'DEVIS', BC: 'BON DE COMMANDE', BL: 'BON DE LIVRAISON', FACTURE: 'FACTURE' };
  const lignes = doc.lignes
    .map((l: any) => {
      const net = d(l.quantite).times(l.prix_unitaire).times(d(100).minus(d(l.remise_pct)).dividedBy(100));
      return `<tr>
        <td><strong>${echapper(l.code_sku)}</strong><br><span class="societe">${echapper(l.designation)}</span></td>
        ${estBl ? `<td>${echapper(l.code_lot_interne ?? '—')}<br><span class="societe">DLUO ${dateFr(l.dluo)}</span></td>` : ''}
        <td class="num">${q3(l.quantite)}</td>
        <td class="num">${montant(l.prix_unitaire)}</td>
        <td class="num">${Number(l.remise_pct).toFixed(2)} %</td>
        <td class="num">${Number(l.tva_pct).toFixed(2)} %</td>
        <td class="num">${montant(net)}</td>
      </tr>`;
    })
    .join('');

  const corps = `
    <div class="grille" style="margin-top:12px">
      <div class="carte" style="flex:1 1 48%">
        <div class="libelle">Client</div>
        <div class="valeur">${echapper(doc.raison_sociale)}</div>
        <div class="societe">${echapper(doc.client_code)}<br>${echapper(estBl ? (doc.adresse_livraison ?? doc.adresse_facturation ?? '') : (doc.adresse_facturation ?? ''))}
        ${doc.nif ? `<br>NIF : ${echapper(doc.nif)}` : ''}${doc.registre_commerce ? ` — RC : ${echapper(doc.registre_commerce)}` : ''}</div>
      </div>
      <div class="carte" style="flex:1 1 48%">
        <div class="libelle">Piece</div>
        <div class="valeur">${echapper(doc.numero_piece)}</div>
        <div class="societe">Date : ${dateFr(doc.date_doc)}
        ${doc.date_echeance ? `<br>Echeance : ${dateFr(doc.date_echeance)} (${doc.delai_paiement_jours} jours)` : ''}
        ${doc.document_parent_numero ? `<br>Reference : ${echapper(doc.document_parent_numero)}` : ''}
        <br>Statut : ${badgeStatut(doc.statut)} ${doc.type_doc === 'FACTURE' ? badgeStatut(doc.statut_paiement) : ''}</div>
      </div>
    </div>
    <h2>${titres[doc.type_doc] ?? doc.type_doc}</h2>
    <table>
      <thead><tr>
        <th>Designation</th>${estBl ? '<th>Lot expedie</th>' : ''}
        <th class="num">Quantite</th><th class="num">PU HT</th><th class="num">Remise</th><th class="num">TVA</th><th class="num">Montant HT</th>
      </tr></thead>
      <tbody>${lignes}</tbody>
    </table>
    <table class="totaux">
      <tr><td>Total HT</td><td class="num">${montant(doc.total_ht)}</td></tr>
      <tr><td>TVA</td><td class="num">${montant(doc.total_tva)}</td></tr>
      <tr class="ttc"><td>Total TTC</td><td class="num">${montant(doc.total_ttc)}</td></tr>
      ${doc.type_doc === 'FACTURE' ? `<tr><td>Deja regle</td><td class="num">${montant(doc.montant_paye)}</td></tr>
      <tr><td><strong>Reste du</strong></td><td class="num"><strong>${montant(d(doc.total_ttc).minus(doc.montant_paye))}</strong></td></tr>` : ''}
    </table>
    ${estBl ? `<p class="mention">Les numeros de lots mentionnes engagent la tracabilite complete des produits expedies (BPF / ISO 22716).</p>` : ''}
    ${doc.deblocage_motif ? `<p class="mention">Deblocage d'encours autorise : ${echapper(doc.deblocage_motif)}</p>` : ''}
    <div class="signatures">
      <div class="signature">${estBl ? 'Preparateur / expedition' : 'Emetteur'}<br>Nom, date et visa</div>
      <div class="signature">${estBl ? 'Transporteur' : 'Service commercial'}<br>Nom, date et visa</div>
      <div class="signature">${estBl ? 'Client (reception conforme)' : 'Client'}<br>Nom, date et visa</div>
    </div>`;
  return layout(`${titres[doc.type_doc] ?? doc.type_doc} ${doc.numero_piece}`, `${echapper(doc.raison_sociale)} — ${dateFr(doc.date_doc)}`, corps, doc.numero_piece);
}

// ---------------------------------------------------------------------
// Etiquette de lot (code-barres Code 128)
// ---------------------------------------------------------------------
export function modeleEtiquetteLot(lot: any): string {
  const corps = `
    <h2>Etiquette de lot</h2>
    <div class="grille">
      <div class="carte" style="flex:1 1 100%">
        <div class="libelle">Article</div>
        <div class="valeur">${echapper(lot.code_sku)} — ${echapper(lot.designation)}</div>
      </div>
      <div class="carte"><div class="libelle">Lot interne</div><div class="valeur">${echapper(lot.code_lot_interne)}</div></div>
      <div class="carte"><div class="libelle">Lot fournisseur</div><div class="valeur">${echapper(lot.code_lot_fournisseur ?? '—')}</div></div>
      <div class="carte"><div class="libelle">DLUO</div><div class="valeur">${dateFr(lot.dluo)}</div></div>
      <div class="carte"><div class="libelle">Quantite</div><div class="valeur">${q3(lot.qte_actuelle)} ${echapper(lot.unite)}</div></div>
      <div class="carte"><div class="libelle">Statut</div><div class="valeur">${badgeStatut(lot.statut)}</div></div>
      <div class="carte"><div class="libelle">Emplacement</div><div class="valeur">${echapper(lot.emplacement ?? '—')}</div></div>
    </div>
    <div style="margin-top:16px;text-align:center">${codeBarresSvg(lot.code_lot_interne, { hauteur: 54, largeurModule: 1.8 })}</div>
    <p class="mention" style="text-align:center">Code 128 — lecture par douchette USB / Bluetooth sur l'ecran de pesee.</p>`;
  return layout(`ETIQUETTE ${lot.code_lot_interne}`, `${echapper(lot.designation)}`, corps, lot.code_lot_interne);
}

// ---------------------------------------------------------------------
// Bon de commande d'achat
// ---------------------------------------------------------------------
export function modeleCommandeAchat(commande: any): string {
  const lignes = (commande.lignes ?? [])
    .map(
      (l: any) => `<tr>
        <td><strong>${echapper(l.code_sku)}</strong><br><span class="societe">${echapper(l.designation)}</span></td>
        <td class="num">${q3(l.quantite)} ${echapper(l.unite)}</td>
        <td class="num">${montant(l.prix_unitaire)}</td>
        <td class="num">${montant(d(l.quantite).times(l.prix_unitaire))}</td>
      </tr>`,
    )
    .join('');
  const corps = `
    <div class="grille" style="margin-top:12px">
      <div class="carte"><div class="libelle">Fournisseur</div><div class="valeur">${echapper(commande.fournisseur ?? 'A definir')}</div></div>
      <div class="carte"><div class="libelle">Date</div><div class="valeur">${dateFr(commande.date_commande)}</div></div>
      <div class="carte"><div class="libelle">Origine</div><div class="valeur">${echapper(commande.origine ?? '—')}</div></div>
    </div>
    <h2>Articles commandes</h2>
    <table>
      <thead><tr><th>Article</th><th class="num">Quantite</th><th class="num">PU estime</th><th class="num">Montant</th></tr></thead>
      <tbody>${lignes}</tbody>
    </table>
    <table class="totaux"><tr class="ttc"><td>Total HT estime</td><td class="num">${montant(commande.total_ht)}</td></tr></table>
    <p class="mention">Quantites calculees par le moteur de capacite predictive pour couvrir le volume cible de production.</p>`;
  return layout(`BON DE COMMANDE ${commande.numero}`, `${echapper(commande.fournisseur ?? '')}`, corps, commande.numero);
}
