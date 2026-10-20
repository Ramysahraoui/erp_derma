import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { closePool, pool } from '../src/db/pool.js';
import { api, cycleProductionComplet, demarrer, envoyerFichier, idArticle, idClient, type Contexte } from './aide.js';

let ctx: Contexte;
before(async () => { ctx = await demarrer(); });
after(async () => { await ctx.app.close(); await closePool(); });

/**
 * Remplit le modele telecharge depuis l'application, comme le ferait un
 * utilisateur : la ligne d'aide est conservee, les exemples sont remplaces.
 */
async function classeur(entetes: string[], lignes: unknown[][]): Promise<Buffer> {
  const url = entetes.includes('lot_fournisseur') ? '/api/imports/receptions/modele' : '/api/imports/articles/modele';
  const rep = await ctx.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${ctx.jetons.qualite}` } });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(rep.rawPayload as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  assert.deepEqual((ws.getRow(1).values as unknown[]).filter(Boolean), entetes, 'colonnes du modele');
  // Effacement des lignes d'exemple (les cellules gardent leurs listes de choix).
  for (let r = 3; r <= ws.rowCount; r++) ws.getRow(r).eachCell((c) => { c.value = null; });
  lignes.forEach((l, i) => { ws.getRow(3 + i).values = l as ExcelJS.CellValue[]; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const ENTETES_ARTICLES = ['code_sku', 'designation', 'type', 'unite', 'nom_inci', 'seuil_critique',
  'prix_vente_ht', 'tva_pct', 'contenance_ml', 'densite', 'disponible'];

describe('V2 — critere 1 : import Excel de plusieurs articles avec compte rendu des rejets', () => {
  test('le modele telechargeable contient les colonnes attendues', async () => {
    const rep = await ctx.app.inject({
      method: 'GET', url: '/api/imports/articles/modele', headers: { authorization: `Bearer ${ctx.jetons.qualite}` },
    });
    assert.equal(rep.statusCode, 200);
    assert.match(rep.headers['content-type'] as string, /spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(rep.rawPayload as unknown as ArrayBuffer);
    const entetes = (wb.worksheets[0].getRow(1).values as unknown[]).filter(Boolean);
    assert.deepEqual(entetes, ENTETES_ARTICLES);
  });

  test('apercu puis import : lignes valides creees, rejets motives', async () => {
    const fichier = await classeur(ENTETES_ARTICLES, [
      ['MP-NEW-001', 'Huile d argan', 'MP', 'L', 'Argania Spinosa Kernel Oil', '10', null, null, null, '0,91', 'oui'],
      ['AC-NEW-001', 'Pot verre 30 ml', 'AC', 'U', null, 200, null, null, null, null, null],
      ['PF-NEW-001', 'Serum eclat 30 ml', 'PF', 'U', null, 20, '2450,5', 19, 30, null, 'oui'],
      ['MP-EAU-001', 'Doublon du referentiel', 'MP', 'kg', null, null, null, null, null, null, null],
      ['AC-NEW-001', 'Doublon dans le fichier', 'AC', 'U', null, null, null, null, null, null, null],
      ['MP-NEW-002', null, 'MP', 'kg', null, null, null, null, null, null, null],
      ['MP-NEW-003', 'Seuil illisible', 'MP', 'kg', null, 'beaucoup', null, null, null, null, null],
      ['PF-NEW-002', 'PF sans contenance', 'PF', 'U', null, null, 1200, null, null, null, null],
      ['XX-NEW-001', 'Categorie inconnue', 'XX', 'U', null, null, null, null, null, null, null],
      ['MP-NEW-004', 'Disponibilite illisible', 'MP', 'kg', null, null, null, null, null, null, 'peut-etre'],
    ]);

    const apercu = await envoyerFichier(ctx, 'qualite', '/api/imports/articles/apercu', fichier, 'articles.xlsx');
    assert.equal(apercu.statut, 200, JSON.stringify(apercu.corps));
    assert.deepEqual(apercu.corps.resume, { total: 10, valides: 3, rejetees: 7 });
    const motifs = (ligne: number) => apercu.corps.lignes.find((l: any) => l.numero === ligne).erreurs.join(' | ');
    assert.match(motifs(6), /deja present dans le referentiel/);
    assert.match(motifs(7), /en double dans le fichier \(deja ligne 4\)/);
    assert.match(motifs(8), /Designation : champ obligatoire vide/);
    assert.match(motifs(9), /n'est pas un nombre/);
    assert.match(motifs(10), /contenance/i);
    assert.match(motifs(11), /Categorie/);
    assert.match(motifs(12), /oui ou non/);

    // L'apercu n'ecrit rien.
    const avant = await pool.query("SELECT COUNT(*)::int AS n FROM articles_catalogue WHERE code_sku LIKE '%-NEW-%'");
    assert.equal(avant.rows[0].n, 0);

    const resultat = await envoyerFichier(ctx, 'qualite', '/api/imports/articles', fichier, 'articles.xlsx');
    assert.equal(resultat.statut, 200, JSON.stringify(resultat.corps));
    assert.equal(resultat.corps.importees, 3);
    assert.equal(resultat.corps.rejetees, 7);
    assert.equal(resultat.corps.rejets.length, 7);
    assert.ok(resultat.corps.rejets.every((r: any) => r.ligne && r.motifs.length > 0));

    const crees = await pool.query(
      "SELECT code_sku, type, unite, densite, prix_vente_ht, contenance_ml, actif FROM articles_catalogue WHERE code_sku LIKE '%-NEW-%' ORDER BY code_sku",
    );
    assert.deepEqual(crees.rows.map((r) => r.code_sku), ['AC-NEW-001', 'MP-NEW-001', 'PF-NEW-001']);
    const argan = crees.rows.find((r) => r.code_sku === 'MP-NEW-001');
    assert.equal(argan.unite, 'L');
    assert.equal(Number(argan.densite), 0.91, 'decimale a virgule acceptee');
    const serum = crees.rows.find((r) => r.code_sku === 'PF-NEW-001');
    assert.equal(Number(serum.prix_vente_ht), 2450.5);

    // Rejouer le meme fichier : tout est rejete comme doublon, rien n'est duplique.
    const rejeu = await envoyerFichier(ctx, 'qualite', '/api/imports/articles', fichier, 'articles.xlsx');
    assert.equal(rejeu.corps.importees, 0);
    const apres = await pool.query("SELECT COUNT(*)::int AS n FROM articles_catalogue WHERE code_sku LIKE '%-NEW-%'");
    assert.equal(apres.rows[0].n, 3);
  });

  test("un fichier qui n'est pas un classeur est refuse proprement", async () => {
    const rep = await envoyerFichier(ctx, 'qualite', '/api/imports/articles/apercu', Buffer.from('ceci,est,un,csv'), 'articles.xlsx');
    assert.equal(rep.statut, 422);
    assert.equal(rep.corps.erreur, 'FICHIER_ILLISIBLE');
  });

  test("l'operateur d'atelier ne peut pas importer d'articles", async () => {
    const fichier = await classeur(ENTETES_ARTICLES, []);
    const rep = await envoyerFichier(ctx, 'atelier', '/api/imports/articles', fichier, 'articles.xlsx');
    assert.equal(rep.statut, 403);
  });
});

describe('V2 — critere 2 : code, disponibilite et prix de vente modifiables et traces', () => {
  test('modification tracee champ par champ, historique de l article conserve', async () => {
    const id = await idArticle(ctx, 'MP-BKA-004');
    const avant = await api(ctx, 'qualite', 'GET', `/api/articles/${id}`);
    assert.ok(avant.corps.activite.mouvements > 0 && avant.corps.lots.length > 0);

    const maj = await api(ctx, 'qualite', 'PATCH', `/api/articles/${id}`, {
      code_sku: 'mp-kar-004', actif: false, prix_vente_ht: 1999.5,
    });
    assert.equal(maj.statut, 200, JSON.stringify(maj.corps));
    assert.equal(maj.corps.code_sku, 'MP-KAR-004');
    assert.equal(maj.corps.modifications_enregistrees, 3);

    const detail = await api(ctx, 'qualite', 'GET', `/api/articles/${id}`);
    const parChamp = Object.fromEntries(detail.corps.modifications.map((m: any) => [m.champ, m]));
    assert.equal(parChamp.code_sku.ancienne_valeur, 'MP-BKA-004');
    assert.equal(parChamp.code_sku.nouvelle_valeur, 'MP-KAR-004');
    assert.equal(parChamp.actif.ancienne_valeur, 'true');
    assert.equal(parChamp.actif.nouvelle_valeur, 'false');
    assert.equal(Number(parChamp.prix_vente_ht.nouvelle_valeur), 1999.5);
    assert.ok(detail.corps.modifications.every((m: any) => m.utilisateur && m.cree_le));

    // L'historique reste rattache : memes lots, memes mouvements, formules intactes.
    assert.equal(detail.corps.lots.length, avant.corps.lots.length);
    assert.equal(detail.corps.activite.mouvements, avant.corps.activite.mouvements);
    assert.equal(detail.corps.activite.formules, avant.corps.activite.formules);

    // Une valeur inchangee n'est pas historisee.
    const sansChangement = await api(ctx, 'qualite', 'PATCH', `/api/articles/${id}`, { prix_vente_ht: 1999.5 });
    assert.equal(sansChangement.corps.modifications_enregistrees, 0);

    // Un article indisponible ne peut plus etre receptionne.
    const reception = await api(ctx, 'qualite', 'POST', '/api/receptions', {
      lignes: [{ article_id: id, quantite: 5, code_lot_fournisseur: 'KAR-X', prix_achat_unitaire: 1500 }],
    });
    assert.equal(reception.statut, 422);
    assert.equal(reception.corps.erreur, 'ARTICLE_INDISPONIBLE');

    // Filtre « inactif » : la chaine « false » n'est plus lue comme vraie.
    const inactifs = await api(ctx, 'qualite', 'GET', '/api/articles?actif=false');
    assert.ok(inactifs.corps.some((a: any) => a.id === id));
    assert.ok(inactifs.corps.every((a: any) => a.actif === false));

    await api(ctx, 'qualite', 'PATCH', `/api/articles/${id}`, { code_sku: 'MP-BKA-004', actif: true });
  });

  test('un nouveau code deja attribue est refuse', async () => {
    const id = await idArticle(ctx, 'MP-GLY-002');
    const rep = await api(ctx, 'qualite', 'PATCH', `/api/articles/${id}`, { code_sku: 'MP-EAU-001' });
    assert.equal(rep.statut, 409);
    assert.equal(rep.corps.erreur, 'CODE_DEJA_UTILISE');
  });

  test('un produit fini indisponible ne peut plus etre vendu', async () => {
    const id = await idArticle(ctx, 'PF-BAU-100');
    await api(ctx, 'qualite', 'PATCH', `/api/articles/${id}`, { actif: false });
    const client = await idClient(ctx, 'CLI-PHARMA');
    const devis = await api(ctx, 'commercial', 'POST', '/api/ventes', {
      type_doc: 'DEVIS', client_id: client, lignes: [{ article_id: id, quantite: 1, prix_unitaire: 2400 }],
    });
    assert.equal(devis.statut, 422);
    assert.equal(devis.corps.erreur, 'ARTICLE_INDISPONIBLE');
    await api(ctx, 'qualite', 'PATCH', `/api/articles/${id}`, { actif: true });
  });
});

describe('V2 — critere 3 : reception par Excel sans certificat de conformite', () => {
  const ENTETES = ['code_sku', 'quantite_kg', 'quantite_unites', 'lot_fournisseur', 'dluo', 'prix_achat_unitaire',
    'frais_approche_unitaire', 'emplacement', 'statut'];

  test('reception importee, lots crees sans certificat, rejets motives', async () => {
    const fournisseur = (await api(ctx, 'qualite', 'GET', '/api/fournisseurs')).corps[0];
    const fichier = await classeur(ENTETES, [
      ['MP-EAU-001', '250,5', null, 'EAU-XL-01', new Date(Date.UTC(2029, 0, 31)), 36, 1.5, 'Magasin A', 'quarantaine'],
      ['AC-FLA-050', null, 1000, 'FL-XL-01', null, 61, null, null, 'conforme'],
      ['mp-gly-002', 40, null, 'GLY-XL-01', '15/03/2029', '440', null, null, null],
      ['MP-INCONNU', 10, null, 'X-1', null, 10, null, null, null],
      ['PF-CRH-050', null, 10, 'X-2', null, 10, null, null, null],
      ['MP-EAU-001', 0, null, 'EAU-XL-02', null, 36, null, null, null],
      ['MP-EAU-001', 10, null, 'EAU-XL-03', '31/02/2029', 36, null, null, null],
      ['MP-EAU-001', 10, null, 'EAU-XL-04', '01/01/2020', 36, null, null, null],
      ['MP-EAU-001', 10, null, 'EAU-XL-01', null, 36, null, null, null],
      ['MP-EAU-001', 10, null, null, null, 36, null, null, null],
      // Huile de jojoba geree en litres (masse volumique 0,87) : 87 kg = 100 L.
      ['MP-HUJ-003', 87, null, 'HUJ-XL-01', null, 870, 8.7, null, null],
      ['MP-EAU-001', null, 10, 'EAU-XL-05', null, 36, null, null, null],
      ['AC-FLA-050', 12, null, 'FL-XL-02', null, 61, null, null, null],
      ['AC-FLA-050', null, '10,5', 'FL-XL-03', null, 61, null, null, null],
      ['MP-EAU-001', null, null, 'EAU-XL-06', null, 36, null, null, null],
    ]);
    const apercu = await envoyerFichier(ctx, 'qualite', '/api/imports/receptions/apercu', fichier, 'reception.xlsx');
    assert.equal(apercu.statut, 200, JSON.stringify(apercu.corps));
    assert.deepEqual(apercu.corps.resume, { total: 15, valides: 4, rejetees: 11 });
    const motifs = (ligne: number) => apercu.corps.lignes.find((l: any) => l.numero === ligne).erreurs.join(' | ');
    assert.match(motifs(6), /inconnu/);
    assert.match(motifs(7), /produit fini/);
    assert.match(motifs(8), /strictement positive/);
    assert.match(motifs(9), /n'est pas une date/);
    assert.match(motifs(10), /deja depassee/);
    assert.match(motifs(11), /en double dans le fichier/);
    assert.match(motifs(12), /lot fournisseur : champ obligatoire vide/i);
    assert.deepEqual(motifs(13), '', 'conversion kg -> litres via la masse volumique');
    assert.match(motifs(14), /matiere premiere : saisir la quantite en kilogrammes/);
    assert.match(motifs(15), /article de conditionnement : saisir un nombre d'unites/);
    assert.match(motifs(16), /pas un nombre entier/);
    assert.match(motifs(17), /Quantite \(kg\) : champ obligatoire vide/);

    const rep = await envoyerFichier(ctx, 'qualite', '/api/imports/receptions', fichier, 'reception.xlsx', {
      fournisseur_id: String(fournisseur.id), reference_bl_fournisseur: 'BL-XL-2026-01',
    });
    assert.equal(rep.statut, 200, JSON.stringify(rep.corps));
    assert.equal(rep.corps.importees, 4);
    assert.equal(rep.corps.rejetees, 11);
    assert.equal(rep.corps.reception.reference_bl_fournisseur, 'BL-XL-2026-01');
    assert.equal(rep.corps.reception.fournisseur_id, fournisseur.id);
    assert.equal(rep.corps.lots.length, 4);
    assert.ok(rep.corps.lots.every((l: any) => l.coa_fichier === null), 'aucun certificat exige');

    const eau = rep.corps.lots.find((l: any) => l.code_sku === 'MP-EAU-001');
    assert.equal(Number(eau.qte_actuelle), 250.5);
    assert.equal(eau.dluo.slice(0, 10), '2029-01-31');
    assert.equal(eau.statut, 'QUARANTAINE');
    assert.equal(rep.corps.lots.find((l: any) => l.code_sku === 'AC-FLA-050').statut, 'CONFORME');
    const huile = rep.corps.lots.find((l: any) => l.code_sku === 'MP-HUJ-003');
    assert.equal(Number(huile.qte_actuelle), 100, '87 kg / 0,87 kg/L = 100 L');
    assert.equal(Number(huile.prix_achat_unitaire), 756.9, '870 DZD/kg x 0,87 kg/L = 756,90 DZD/L');
    assert.equal(Number(huile.frais_approche_unitaire), 7.569);

    // Liberation possible sans certificat, certificat joint ensuite.
    const liberation = await api(ctx, 'qualite', 'POST', `/api/lots/${eau.id}/statut`, {
      statut: 'CONFORME', motif: 'Controle visuel conforme, certificat a recevoir',
    });
    assert.equal(liberation.statut, 200, JSON.stringify(liberation.corps));
    const depot = await api(ctx, 'qualite', 'POST', `/api/lots/${eau.id}/coa`, { coa_fichier: 'coa-eau-xl-01.pdf' });
    assert.equal(depot.statut, 200);
    assert.equal(depot.corps.coa_fichier, 'coa-eau-xl-01.pdf');
  });

  test('un fichier rempli sur l ancien modele (quantite sans unite) est refuse', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Reception');
    ws.addRow(['code_sku', 'quantite', 'lot_fournisseur', 'prix_achat_unitaire']);
    ws.addRow(['MP-EAU-001', 10, 'EAU-OLD-1', 36]);
    const fichier = Buffer.from(await wb.xlsx.writeBuffer());
    const apercu = await envoyerFichier(ctx, 'qualite', '/api/imports/receptions/apercu', fichier, 'ancien.xlsx');
    assert.equal(apercu.corps.resume.valides, 0);
    assert.match(apercu.corps.lignes[0].erreurs.join(' '), /Ancien modele/);
  });

  test('un fichier entierement invalide ne cree aucune reception', async () => {
    const avant = (await pool.query('SELECT COUNT(*)::int AS n FROM receptions')).rows[0].n;
    const fichier = await classeur(ENTETES, [['MP-INCONNU', 10, null, 'X', null, 1, null, null, null]]);
    const rep = await envoyerFichier(ctx, 'qualite', '/api/imports/receptions', fichier, 'reception.xlsx');
    assert.equal(rep.corps.importees, 0);
    assert.equal(rep.corps.reception, null);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM receptions')).rows[0].n, avant);
  });
});

describe('V2 — critere 4 : ajustement des quantites et reintroduction d un lot rejete', () => {
  test('augmentation et reduction tracees comme mouvements de stock', async () => {
    const article = await idArticle(ctx, 'MP-GOM-010');
    const lot = (await api(ctx, 'qualite', 'GET', `/api/lots?article_id=${article}&disponible=true`)).corps[0];
    const depart = Number(lot.qte_actuelle);

    const plus = await api(ctx, 'qualite', 'POST', `/api/lots/${lot.id}/ajustement`, {
      sens: 'AUGMENTER', quantite: 10, motif: 'Inventaire tournant : ecart positif',
    });
    assert.equal(plus.statut, 200, JSON.stringify(plus.corps));
    const moins = await api(ctx, 'qualite', 'POST', `/api/lots/${lot.id}/ajustement`, {
      sens: 'REDUIRE', quantite: 4.5, motif: 'Casse constatee en magasin',
    });
    assert.equal(moins.statut, 200);

    const detail = await api(ctx, 'qualite', 'GET', `/api/lots/${lot.id}`);
    assert.equal(Number(detail.corps.qte_actuelle), depart + 10 - 4.5);
    const ajustements = detail.corps.mouvements.filter((m: any) => m.type_mouvement === 'AJUSTEMENT');
    assert.deepEqual(ajustements.map((m: any) => Number(m.quantite)), [10, -4.5]);
    assert.ok(ajustements.every((m: any) => m.utilisateur && m.date_mouvement && m.motif));

    const excessive = await api(ctx, 'qualite', 'POST', `/api/lots/${lot.id}/ajustement`, {
      sens: 'REDUIRE', quantite: 1_000_000, motif: 'Reduction au-dela du stock',
    });
    assert.equal(excessive.statut, 422);
    assert.equal(excessive.corps.erreur, 'STOCK_INSUFFISANT');

    const sansMotif = await api(ctx, 'qualite', 'POST', `/api/lots/${lot.id}/ajustement`, { sens: 'AUGMENTER', quantite: 1, motif: '' });
    assert.equal(sansMotif.statut, 422);
  });

  test('un lot rejete est reintroduit sur decision, le rejet reste dans l historique', async () => {
    const article = await idArticle(ctx, 'AC-CAR-EXP'); // hors nomenclature : sans effet sur la production
    const lot = (await api(ctx, 'qualite', 'GET', `/api/lots?article_id=${article}`)).corps[0];

    const rejet = await api(ctx, 'qualite', 'POST', `/api/lots/${lot.id}/statut`, { statut: 'REJETE', motif: 'pH hors specification fournisseur' });
    assert.equal(rejet.statut, 200);

    // La voie normale reste fermee.
    const direct = await api(ctx, 'qualite', 'POST', `/api/lots/${lot.id}/statut`, { statut: 'CONFORME' });
    assert.equal(direct.statut, 422);
    assert.equal(direct.corps.erreur, 'LOT_REJETE');
    const motifCourt = await api(ctx, 'qualite', 'POST', `/api/lots/${lot.id}/reintroduction`, { motif: 'ok' });
    assert.equal(motifCourt.statut, 422);
    const operateur = await api(ctx, 'atelier', 'POST', `/api/lots/${lot.id}/reintroduction`, { motif: 'Tentative non autorisee' });
    assert.equal(operateur.statut, 403);

    const reintro = await api(ctx, 'qualite', 'POST', `/api/lots/${lot.id}/reintroduction`, {
      statut_cible: 'QUARANTAINE', motif: 'Contre-analyse du laboratoire externe conforme (rapport 2026-118)',
    });
    assert.equal(reintro.statut, 200, JSON.stringify(reintro.corps));
    assert.equal(reintro.corps.statut, 'QUARANTAINE');

    const detail = await api(ctx, 'qualite', 'GET', `/api/lots/${lot.id}`);
    const historique = detail.corps.historique_statuts;
    const rejetTrace = historique.find((h: any) => h.nouveau_statut === 'REJETE');
    const reintroTrace = historique.find((h: any) => h.nature === 'REINTRODUCTION');
    assert.ok(rejetTrace, 'le rejet est conserve');
    assert.equal(rejetTrace.motif, 'pH hors specification fournisseur');
    assert.equal(reintroTrace.ancien_statut, 'REJETE');
    assert.equal(reintroTrace.nouveau_statut, 'QUARANTAINE');
    assert.match(reintroTrace.motif, /Contre-analyse/);
    assert.ok(reintroTrace.utilisateur);
    assert.ok(historique.indexOf(rejetTrace) < historique.indexOf(reintroTrace));

    await assert.rejects(() => pool.query('DELETE FROM lots_statuts_historique WHERE lot_stock_id = $1', [lot.id]),
      /AUDIT_TRAIL_SUPPRESSION_INTERDITE/);
  });
});

describe('V2 — critere 5 : un encaissement apparait dans l etat du client et le solde est correct', () => {
  test('imputation automatique, avoir, impaye et represention sans double compte', async () => {
    const cycle = await cycleProductionComplet(ctx, { masseKg: 25, unites: 300 });
    const pf = await idArticle(ctx, 'PF-CRH-050');
    const clientId = await idClient(ctx, 'CLI-PARA');

    const facturer = async (montant: number) => {
      const bl = await api(ctx, 'commercial', 'POST', '/api/ventes', {
        type_doc: 'BL', client_id: clientId, valider: true,
        lignes: [{ article_id: pf, lot_pf_id: cycle.lot_pf_id, quantite: montant / 1000, prix_unitaire: 1000, tva_pct: 0 }],
      });
      assert.equal(bl.statut, 201, JSON.stringify(bl.corps));
      const f = await api(ctx, 'commercial', 'POST', `/api/ventes/${bl.corps.id}/transformer`, { cible: 'FACTURE', valider: true });
      assert.equal(f.statut, 201, JSON.stringify(f.corps));
      return f.corps;
    };
    const etat = async () => (await api(ctx, 'comptabilite', 'GET', `/api/recouvrement/releve/${clientId}`)).corps;
    const facture = async (id: number) => (await api(ctx, 'comptabilite', 'GET', `/api/ventes/${id}`)).corps;
    const encaisser = async (montant: number, extra: Record<string, unknown> = {}) => {
      const r = await api(ctx, 'comptabilite', 'POST', '/api/recouvrement/encaissements', {
        client_id: clientId, montant_verse: montant, mode_reglement: 'VIREMENT', ...extra,
      });
      assert.equal(r.statut, 201, JSON.stringify(r.corps));
      return r.corps;
    };

    const f1 = await facturer(10000);
    const f2 = await facturer(6000);
    assert.equal((await etat()).totaux.solde_restant_du, '16000.00');

    // 1. Anomalie V1 : encaissement saisi sans ventilation -> desormais impute.
    const e1 = await encaisser(13000);
    assert.equal(e1.imputations_automatiques.length, 2);
    assert.equal((await facture(f1.id)).statut_paiement, 'SOLDEE');
    const f2a = await facture(f2.id);
    assert.equal(f2a.statut_paiement, 'PARTIELLE');
    assert.equal(f2a.montant_paye, '3000.00');
    let releve = await etat();
    assert.equal(releve.totaux.solde_restant_du, '3000.00');
    assert.ok(releve.lignes.some((l: any) => l.nature === 'ENCAISSEMENT' && l.credit === '13000.00'));

    // L'etat client affiche par l'ecran clients concorde.
    const fiche = await api(ctx, 'commercial', 'GET', `/api/clients/${clientId}`);
    assert.equal(fiche.corps.encours.encours_total, '3000.00');

    // 2. Trop-percu : l'excedent devient un avoir qui diminue le solde.
    await encaisser(5000);
    releve = await etat();
    assert.equal((await facture(f2.id)).statut_paiement, 'SOLDEE');
    assert.equal(releve.totaux.avoir_disponible, '2000.00');
    assert.equal(releve.totaux.solde_restant_du, '-2000.00');

    // 3. Nouvelle facture : l'avoir s'impute des sa validation.
    const f3 = await facturer(1500);
    assert.equal((await facture(f3.id)).statut_paiement, 'SOLDEE');
    assert.equal((await etat()).totaux.avoir_disponible, '500.00');

    // 4. Cheque impaye : la facture redevient due, sans double decompte.
    const f4 = await facturer(4000);                       // 500 d'avoir imputes -> reste 3500
    assert.equal((await facture(f4.id)).montant_paye, '500.00');
    const cheque = await encaisser(3500, {
      mode_reglement: 'CHEQUE', cheque_numero: '7788001', cheque_date_emission: '2026-10-01', cheque_statut: 'DEPOSE',
    });
    assert.equal((await facture(f4.id)).statut_paiement, 'SOLDEE');
    assert.equal((await etat()).totaux.solde_restant_du, '0.00');

    const impaye = await api(ctx, 'comptabilite', 'POST', `/api/recouvrement/encaissements/${cheque.id}/cheque`, { statut: 'IMPAYE' });
    assert.equal(impaye.statut, 200);
    assert.equal((await facture(f4.id)).montant_paye, '500.00');
    assert.equal((await etat()).totaux.solde_restant_du, '3500.00');

    // Un second passage en impaye et un recalcul ulterieur ne changent rien.
    await api(ctx, 'comptabilite', 'POST', `/api/recouvrement/encaissements/${cheque.id}/cheque`, { statut: 'IMPAYE' });
    await encaisser(100);
    assert.equal((await facture(f4.id)).montant_paye, '600.00', 'le cheque impaye n est pas recredite');
    assert.equal((await etat()).totaux.solde_restant_du, '3400.00');

    // 5. Cheque represente : il redevient un avoir, sans paiement en double.
    await api(ctx, 'comptabilite', 'POST', `/api/recouvrement/encaissements/${cheque.id}/cheque`, { statut: 'ENCAISSE' });
    const f4b = await facture(f4.id);
    assert.equal(f4b.statut_paiement, 'SOLDEE');
    assert.equal(f4b.montant_paye, f4b.total_ttc, 'jamais plus que le total facture');
    releve = await etat();
    assert.equal(releve.totaux.avoir_disponible, '100.00');
    assert.equal(releve.totaux.solde_restant_du, '-100.00');

    // Le releve est coherent : son solde progressif final egale le solde du.
    const derniere = releve.lignes[releve.lignes.length - 1];
    assert.equal(derniere.solde, releve.totaux.solde_restant_du);
    // L'historique du cheque reste lisible : encaissement, impaye, representation.
    const evenements = releve.lignes.filter((l: any) => l.piece === cheque.numero).map((l: any) => l.nature);
    assert.deepEqual(evenements, ['ENCAISSEMENT', 'IMPAYE', 'REPRESENTATION']);

    // Releve imprimable.
    const doc = await ctx.app.inject({
      method: 'GET', url: `/api/documents/clients/${clientId}/releve?format=html`,
      headers: { authorization: `Bearer ${ctx.jetons.commercial}` },
    });
    assert.equal(doc.statusCode, 200);
    assert.match(doc.body, /RELEVE DE COMPTE/);
    assert.match(doc.body, /Solde restant du/);
  });

  test('un paiement avant facturation reduit immediatement l encours (plafond de credit)', async () => {
    const clientId = await idClient(ctx, 'CLI-INSTI');
    const avant = (await api(ctx, 'commercial', 'GET', `/api/clients/${clientId}/encours`)).corps;
    await api(ctx, 'comptabilite', 'POST', '/api/recouvrement/encaissements', {
      client_id: clientId, montant_verse: 20000, mode_reglement: 'ESPECES',
    });
    const apres = (await api(ctx, 'commercial', 'GET', `/api/clients/${clientId}/encours`)).corps;
    assert.equal(apres.avoir_disponible, '20000.00');
    assert.equal(Number(apres.disponible), Number(avant.disponible) + 20000, 'le credit disponible augmente');
  });
});
