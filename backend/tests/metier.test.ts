import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, pool } from '../src/db/pool.js';
import { api, cycleProductionComplet, demarrer, idArticle, idClient, idFormule, type Contexte } from './aide.js';

let ctx: Contexte;

before(async () => { ctx = await demarrer(); });
after(async () => { await ctx.app.close(); await closePool(); });

describe('Regles metier industrielles', () => {
  test("mise a l'echelle : masses proportionnelles et surdosage technique", async () => {
    const formule = await idFormule(ctx, 'FOR-CRH-01');
    const echelle = await api(ctx, 'qualite', 'POST', `/api/formules/${formule}/mise-a-echelle`, {
      masse_nette_kg: 150, surdosage_pct: 1.5,
    });
    assert.equal(echelle.statut, 200);
    assert.equal(echelle.corps.masse_brute_kg, '152.250');            // 150 x 1,015
    assert.equal(echelle.corps.total_masse_g, '152250.000');          // somme = masse brute
    const eau = echelle.corps.lignes.find((l: any) => l.code_sku === 'MP-EAU-001');
    assert.equal(eau.masse_theorique_g, '104291.250');                // 152 250 g x 68,5 %
    const parfum = echelle.corps.lignes.find((l: any) => l.code_sku === 'MP-PAR-009');
    assert.equal(parfum.masse_theorique_g, '1979.250');               // 152 250 g x 1,3 %
  });

  test("mise a l'echelle par nombre d'unites : conversion volume -> masse via la densite", async () => {
    const formule = await idFormule(ctx, 'FOR-CRH-01');
    const echelle = await api(ctx, 'qualite', 'POST', `/api/formules/${formule}/mise-a-echelle`, {
      unites_pf: 3000, surdosage_pct: 0,
    });
    // 3 000 flacons x 50 ml x 0,98 g/ml = 147 000 g = 147 kg
    assert.equal(echelle.corps.masse_nette_kg, '147.000');
    assert.equal(echelle.corps.volume_litres, '150.000');
  });

  test('allocation FEFO : priorite au lot dont la peremption est la plus proche', async () => {
    const article = await idArticle(ctx, 'MP-BKA-004');
    const reception = await api(ctx, 'qualite', 'POST', '/api/receptions', {
      lignes: [
        { article_id: article, quantite: 10, code_lot_fournisseur: 'KAR-LOIN', dluo: '2030-01-01', prix_achat_unitaire: 1500, statut: 'CONFORME' },
        { article_id: article, quantite: 5, code_lot_fournisseur: 'KAR-PROCHE', dluo: '2027-01-01', prix_achat_unitaire: 1500, statut: 'CONFORME' },
      ],
    });
    assert.equal(reception.statut, 201);
    const fefo = await api(ctx, 'qualite', 'GET', `/api/stock/fefo?article_id=${article}&quantite=7`);
    assert.equal(fefo.statut, 200);
    // Le lot du jeu initial (DLUO a +400 j) passe en premier, puis 2027, puis 2030.
    const dluos = fefo.corps.lignes.map((l: any) => l.dluo);
    const triees = [...dluos].sort();
    assert.deepEqual(dluos, triees, 'les lots sont servis par peremption croissante');
    assert.equal(fefo.corps.quantite_manquante, '0.000');
  });

  test('pesee hors tolerance : refus operateur, acceptation tracee par la qualite', async () => {
    const formule = await idFormule(ctx, 'FOR-SER-01');
    const of = await api(ctx, 'qualite', 'POST', '/api/of', { formule_id: formule, masse_nette_kg: 5 });
    assert.equal(of.statut, 201);
    const dossier = await api(ctx, 'atelier', 'GET', `/api/of/${of.corps.id}`);
    const ligne = dossier.corps.lignes[0];
    const lots = await api(ctx, 'atelier', 'GET', `/api/of/${of.corps.id}/lignes/${ligne.id}/lots`);

    const horsTolerance = Number(ligne.masse_theorique_g) * 1.05; // +5 % (tolerance 0,5 %)
    const refus = await api(ctx, 'atelier', 'POST', `/api/of/${of.corps.id}/pesees`, {
      of_ligne_id: ligne.id, lot_stock_id: lots.corps[0].id, poids_reel_pesee_g: horsTolerance,
    });
    assert.equal(refus.statut, 422);
    assert.equal(refus.corps.erreur, 'PESEE_HORS_TOLERANCE');
    assert.equal(refus.corps.details.tolerance_pct, '0.500');

    // L operateur ne peut pas forcer lui-meme.
    const forcageOperateur = await api(ctx, 'atelier', 'POST', `/api/of/${of.corps.id}/pesees`, {
      of_ligne_id: ligne.id, lot_stock_id: lots.corps[0].id, poids_reel_pesee_g: horsTolerance, forcer: true,
    });
    assert.equal(forcageOperateur.statut, 403);

    // Le responsable qualite peut accepter l ecart, qui reste marque non conforme.
    const accepte = await api(ctx, 'qualite', 'POST', `/api/of/${of.corps.id}/pesees`, {
      of_ligne_id: ligne.id, lot_stock_id: lots.corps[0].id, poids_reel_pesee_g: horsTolerance,
      forcer: true, commentaire: 'Ecart accepte : ajustement compense en phase E',
    });
    assert.equal(accepte.statut, 201);
    assert.equal(accepte.corps.conforme, false);
  });

  test('cloture impossible tant que toutes les pesees ne sont pas validees (trigger base)', async () => {
    const formule = await idFormule(ctx, 'FOR-SER-01');
    const of = await api(ctx, 'qualite', 'POST', '/api/of', { formule_id: formule, masse_nette_kg: 5 });
    const ofId = of.corps.id;
    const dossier = await api(ctx, 'atelier', 'GET', `/api/of/${ofId}`);

    // Une seule ligne pesee sur les huit : la fabrication est bloquee.
    const ligne = dossier.corps.lignes[0];
    const lots = await api(ctx, 'atelier', 'GET', `/api/of/${ofId}/lignes/${ligne.id}/lots`);
    await api(ctx, 'atelier', 'POST', `/api/of/${ofId}/pesees`, {
      of_ligne_id: ligne.id, lot_stock_id: lots.corps[0].id, poids_reel_pesee_g: Number(ligne.masse_theorique_g),
    });
    const fabrication = await api(ctx, 'atelier', 'POST', `/api/of/${ofId}/fabrication`, {});
    assert.equal(fabrication.statut, 422);
    assert.equal(fabrication.corps.erreur, 'PESEES_INCOMPLETES');

    // Le trigger de la base refuse egalement la cloture forcee en SQL direct.
    await assert.rejects(
      () => pool.query("UPDATE ordres_fabrication SET statut_of = 'CLOTURE' WHERE id = $1", [ofId]),
      /PESEES_INCOMPLETES/,
    );
  });

  test('audit trail : aucune suppression possible sur les tables de tracabilite', async () => {
    const cycle = await cycleProductionComplet(ctx, { masseKg: 12, unites: 150 });
    for (const table of ['mouvements_stock', 'of_pesees_reelles', 'lots_stock', 'ordres_fabrication', 'lots_vrac']) {
      await assert.rejects(
        () => pool.query(`DELETE FROM ${table} WHERE id = (SELECT MIN(id) FROM ${table})`),
        /AUDIT_TRAIL_SUPPRESSION_INTERDITE/,
        `la table ${table} doit etre immuable`,
      );
    }
    // Un mouvement de stock ne peut pas etre reecrit.
    await assert.rejects(
      () => pool.query('UPDATE mouvements_stock SET quantite = quantite * 2 WHERE id = (SELECT MIN(id) FROM mouvements_stock)'),
      /AUDIT_TRAIL_MODIFICATION_INTERDITE/,
    );
    assert.ok(cycle.lot_pf_id);
  });

  test("lot de produit fini impossible sans lot de vrac libere", async () => {
    const pf = await idArticle(ctx, 'PF-CRH-050');
    await assert.rejects(
      () => pool.query(
        `INSERT INTO lots_stock (article_id, code_lot_interne, qte_initiale, qte_actuelle, statut)
         VALUES ($1, 'LOT-PF-FRAUDE', 100, 100, 'CONFORME')`,
        [pf],
      ),
      /LOT_PF_SANS_VRAC/,
    );
  });

  test('cout de revient unitaire : somme des couts rapportee aux unites conformes', async () => {
    const cycle = await cycleProductionComplet(ctx, { masseKg: 30, unites: 400 });
    const cru = cycle.cru;
    const total = Number(cru.cout_mp) + Number(cru.cout_ac) + Number(cru.cout_main_oeuvre) + Number(cru.cout_charges_indirectes);
    assert.ok(Math.abs(total - Number(cru.cout_total)) < 0.01, 'le cout total est la somme de ses composantes');
    assert.ok(Math.abs(Number(cru.cru) - total / cru.unites_produites) < 0.0001, 'CRU = cout total / unites produites');
    assert.equal(cru.unites_produites, 400);
    assert.equal(cru.heures_production, '6.00');
    // Main d'oeuvre : 6 h x 850 (taux parametre) = 5 100
    assert.equal(Number(cru.cout_main_oeuvre).toFixed(2), '5100.00');
    assert.ok(Number(cru.cout_mp) > 0 && Number(cru.cout_ac) > 0);

    // Le lot de produit fini est valorise au cout reel.
    const lot = await api(ctx, 'qualite', 'GET', `/api/lots/${cycle.lot_pf_id}`);
    assert.equal(Number(lot.corps.cout_unitaire).toFixed(4), Number(cru.cru).toFixed(4));
  });

  test('rendement reel et decrementation du vrac au conditionnement', async () => {
    const cycle = await cycleProductionComplet(ctx, { masseKg: 20, unites: 380 });
    const dossier = await api(ctx, 'qualite', 'GET', `/api/of/${cycle.of_id}`);
    // 20 kg nets + 1,5 % de surdosage -> ~20,3 kg pesee ; 380 x 50 ml x 0,98 = 18,62 kg consommes
    assert.ok(Number(dossier.corps.rendement_pct) > 85 && Number(dossier.corps.rendement_pct) < 100);
    assert.ok(Number(dossier.corps.masse_restante_kg) > 0);
    assert.equal(dossier.corps.statut_of, 'CLOTURE');
    assert.equal(dossier.corps.avancement.pesees_completes, true);
  });

  test('vrac hors specification : liberation refusee', async () => {
    const formule = await idFormule(ctx, 'FOR-CRH-01');
    const of = await api(ctx, 'qualite', 'POST', '/api/of', { formule_id: formule, masse_nette_kg: 8 });
    const ofId = of.corps.id;
    const dossier = await api(ctx, 'atelier', 'GET', `/api/of/${ofId}`);
    for (const ligne of dossier.corps.lignes) {
      const lots = await api(ctx, 'atelier', 'GET', `/api/of/${ofId}/lignes/${ligne.id}/lots`);
      await api(ctx, 'atelier', 'POST', `/api/of/${ofId}/pesees`, {
        of_ligne_id: ligne.id, lot_stock_id: lots.corps[0].id, poids_reel_pesee_g: Number(ligne.masse_theorique_g),
      });
    }
    await api(ctx, 'atelier', 'POST', `/api/of/${ofId}/fabrication`, {});
    const horsSpec = await api(ctx, 'qualite', 'POST', `/api/of/${ofId}/vrac/controle`, {
      ph_mesure: 7.2, viscosite_mesuree: 16000, aspect: 'Correct', couleur: 'Blanc',
      odeur: 'Caracteristique', conforme_organoleptique: true, decision: 'LIBERE',
    });
    assert.equal(horsSpec.statut, 422);
    assert.equal(horsSpec.corps.erreur, 'VRAC_HORS_SPECIFICATION');
    assert.match(horsSpec.corps.details.hors_specification[0], /pH/);
  });
});

describe('Chaine commerciale, recouvrement et analytique', () => {
  test('chaine documentaire devis -> BC -> BL -> facture avec deduction de stock', async () => {
    const cycle = await cycleProductionComplet(ctx, { masseKg: 25, unites: 300 });
    const pf = await idArticle(ctx, 'PF-CRH-050');
    const client = await idClient(ctx, 'CLI-PHARMA');

    const devis = await api(ctx, 'commercial', 'POST', '/api/ventes', {
      type_doc: 'DEVIS', client_id: client, valider: true,
      lignes: [{ article_id: pf, quantite: 100, prix_unitaire: 1850 }],
    });
    assert.equal(devis.statut, 201);
    assert.equal(devis.corps.total_ht, '185000.00');
    assert.equal(devis.corps.total_ttc, '220150.00'); // TVA 19 %

    const bc = await api(ctx, 'commercial', 'POST', `/api/ventes/${devis.corps.id}/transformer`, { cible: 'BC', valider: true });
    assert.equal(bc.statut, 201);

    // Sans affectation de lot, la transformation en BL est refusee.
    const blSansLot = await api(ctx, 'commercial', 'POST', `/api/ventes/${bc.corps.id}/transformer`, { cible: 'BL' });
    assert.equal(blSansLot.statut, 422);
    assert.equal(blSansLot.corps.erreur, 'LOT_PF_OBLIGATOIRE');

    const lignesBc = (await api(ctx, 'commercial', 'GET', `/api/ventes/${bc.corps.id}`)).corps.lignes;
    const stockAvant = (await api(ctx, 'commercial', 'GET', `/api/lots/${cycle.lot_pf_id}`)).corps.qte_actuelle;
    const bl = await api(ctx, 'commercial', 'POST', `/api/ventes/${bc.corps.id}/transformer`, {
      cible: 'BL', valider: true,
      affectations: [{ ligne_id: lignesBc[0].id, lot_pf_id: cycle.lot_pf_id }],
    });
    assert.equal(bl.statut, 201);
    const stockApres = (await api(ctx, 'commercial', 'GET', `/api/lots/${cycle.lot_pf_id}`)).corps.qte_actuelle;
    assert.equal(Number(stockAvant) - Number(stockApres), 100, 'le stock physique est decremente a la validation du BL');

    const facture = await api(ctx, 'commercial', 'POST', `/api/ventes/${bl.corps.id}/transformer`, { cible: 'FACTURE', valider: true });
    assert.equal(facture.statut, 201);
    assert.ok(facture.corps.date_echeance, 'l echeance est calculee selon le delai accorde');
    assert.ok(Number(facture.corps.marge_brute) > 0, 'la marge brute est valorisee');
  });

  test('encaissement multi-factures, paiement partiel et cheque impaye', async () => {
    const cycle = await cycleProductionComplet(ctx, { masseKg: 25, unites: 300 });
    const pf = await idArticle(ctx, 'PF-CRH-050');
    const client = await idClient(ctx, 'CLI-DISTRI');

    const creerFacture = async (quantite: number) => {
      const bl = await api(ctx, 'commercial', 'POST', '/api/ventes', {
        type_doc: 'BL', client_id: client, valider: true,
        lignes: [{ article_id: pf, lot_pf_id: cycle.lot_pf_id, quantite, prix_unitaire: 1000, tva_pct: 0 }],
      });
      assert.equal(bl.statut, 201);
      const facture = await api(ctx, 'commercial', 'POST', `/api/ventes/${bl.corps.id}/transformer`, { cible: 'FACTURE', valider: true });
      assert.equal(facture.statut, 201);
      return facture.corps;
    };
    const f1 = await creerFacture(50);  // 50 000
    const f2 = await creerFacture(30);  // 30 000

    // Un seul reglement solde la premiere facture et paie partiellement la seconde.
    const encaissement = await api(ctx, 'comptabilite', 'POST', '/api/recouvrement/encaissements', {
      client_id: client, montant_verse: 60000, mode_reglement: 'CHEQUE',
      cheque_numero: '0012345', cheque_banque: 'BNA', cheque_date_emission: '2026-01-05',
      cheque_date_encaissement_prev: '2026-01-20', cheque_statut: 'DEPOSE',
      affectations: [
        { document_id: f1.id, montant_affecte: 50000 },
        { document_id: f2.id, montant_affecte: 10000 },
      ],
    });
    assert.equal(encaissement.statut, 201);

    const apres1 = await api(ctx, 'comptabilite', 'GET', `/api/ventes/${f1.id}`);
    const apres2 = await api(ctx, 'comptabilite', 'GET', `/api/ventes/${f2.id}`);
    assert.equal(apres1.corps.statut_paiement, 'SOLDEE');
    assert.equal(apres2.corps.statut_paiement, 'PARTIELLE');
    assert.equal(apres2.corps.montant_paye, '10000.00');

    // Une affectation superieure au solde restant est refusee.
    const excessif = await api(ctx, 'comptabilite', 'POST', '/api/recouvrement/encaissements', {
      client_id: client, montant_verse: 100000, mode_reglement: 'ESPECES',
      affectations: [{ document_id: f2.id, montant_affecte: 90000 }],
    });
    assert.equal(excessif.statut, 422);
    assert.equal(excessif.corps.erreur, 'AFFECTATION_SUPERIEURE_AU_SOLDE');

    // Cheque impaye : l apurement est annule.
    const impaye = await api(ctx, 'comptabilite', 'POST', `/api/recouvrement/encaissements/${encaissement.corps.id}/cheque`, {
      statut: 'IMPAYE', commentaire: 'Retour bancaire : provision insuffisante',
    });
    assert.equal(impaye.statut, 200);
    const rejouee = await api(ctx, 'comptabilite', 'GET', `/api/ventes/${f1.id}`);
    assert.equal(rejouee.corps.statut_paiement, 'NON_PAYEE');
  });

  test('balance agee : ventilation des creances par tranche de retard', async () => {
    const cycle = await cycleProductionComplet(ctx, { masseKg: 25, unites: 300 });
    const pf = await idArticle(ctx, 'PF-CRH-050');
    const client = await idClient(ctx, 'CLI-PARA');

    const bl = await api(ctx, 'commercial', 'POST', '/api/ventes', {
      type_doc: 'BL', client_id: client, valider: true,
      lignes: [{ article_id: pf, lot_pf_id: cycle.lot_pf_id, quantite: 10, prix_unitaire: 1000, tva_pct: 0 }],
    });
    const facture = await api(ctx, 'commercial', 'POST', `/api/ventes/${bl.corps.id}/transformer`, { cible: 'FACTURE', valider: true });
    // Facture volontairement echue depuis 45 jours.
    await pool.query("UPDATE ventes_documents SET date_echeance = CURRENT_DATE - 45 WHERE id = $1", [facture.corps.id]);

    const balance = await api(ctx, 'comptabilite', 'GET', '/api/recouvrement/balance-agee');
    assert.equal(balance.statut, 200);
    const ligne = balance.corps.lignes.find((l: any) => l.document_id === facture.corps.id);
    assert.equal(ligne.tranche, 'ECHUE_31_60');
    assert.equal(ligne.jours_retard, 45);
    assert.ok(Number(balance.corps.totaux.ECHUE_31_60) >= 10000);
  });

  test('capacite predictive : unites maximales, goulot et generation de la commande d achat', async () => {
    const pf = await idArticle(ctx, 'PF-CRH-050');
    const simulation = await api(ctx, 'qualite', 'POST', '/api/capacite/simulation', {
      produits: [{ article_pf_id: pf, unites_cibles: 100000 }],
    });
    assert.equal(simulation.statut, 200);
    const sim = simulation.corps.simulations[0];
    assert.ok(sim.unites_max_fabricables > 0);
    assert.equal(sim.cible_atteignable, false);
    assert.ok(sim.composant_limitant, 'le composant limitant est identifie');
    assert.ok(sim.composants.some((c: any) => c.limitant === true));
    assert.equal(simulation.corps.approvisionnement_necessaire, true);

    const manquants = simulation.corps.besoins_consolides.filter((b: any) => !b.couvert);
    assert.ok(manquants.length > 0);
    const commande = await api(ctx, 'qualite', 'POST', '/api/capacite/commande-achat', {
      origine: 'Simulateur — objectif 100 000 unites',
      lignes: manquants.slice(0, 3).map((m: any) => ({ article_id: m.article_id, quantite: Number(m.manquant) })),
    });
    assert.equal(commande.statut, 201);
    assert.match(commande.corps.numero, /^CA-\d{4}-\d{5}$/);
  });

  test('cloisonnement RBAC : l operateur atelier n accede ni aux couts ni aux clients', async () => {
    const interdits: [string, string][] = [
      ['GET', '/api/clients'],
      ['GET', '/api/ventes'],
      ['GET', '/api/analyse/rentabilite'],
      ['GET', '/api/depenses'],
      ['GET', '/api/recouvrement/balance-agee'],
    ];
    for (const [methode, url] of interdits) {
      const rep = await api(ctx, 'atelier', methode as 'GET', url);
      assert.equal(rep.statut, 403, `${url} doit etre interdit a l operateur`);
    }
    // Le commercial ne peut pas creer un ordre de fabrication.
    const of = await api(ctx, 'commercial', 'POST', '/api/of', { formule_id: 1, masse_nette_kg: 10 });
    assert.equal(of.statut, 403);
    // Sans jeton, tout acces est refuse.
    const anonyme = await ctx.app.inject({ method: 'GET', url: '/api/articles' });
    assert.equal(anonyme.statusCode, 401);
  });

  test('documents imprimables : dossier de lot, bon de pesee, BL et etiquette code-barres', async () => {
    const cycle = await cycleProductionComplet(ctx, { masseKg: 15, unites: 200 });
    const pf = await idArticle(ctx, 'PF-CRH-050');
    const client = await idClient(ctx, 'CLI-PHARMA');
    const bl = await api(ctx, 'commercial', 'POST', '/api/ventes', {
      type_doc: 'BL', client_id: client, valider: true,
      lignes: [{ article_id: pf, lot_pf_id: cycle.lot_pf_id, quantite: 12, prix_unitaire: 1850 }],
    });

    const html = async (url: string, role: 'qualite' | 'commercial' = 'qualite') => {
      const rep = await ctx.app.inject({
        method: 'GET', url, headers: { authorization: `Bearer ${ctx.jetons[role]}` },
      });
      assert.equal(rep.statusCode, 200, url);
      assert.match(rep.headers['content-type'] as string, /text\/html/);
      return rep.body;
    };

    const dossier = await html(`/api/documents/of/${cycle.of_id}/dossier-de-lot?format=html`);
    assert.match(dossier, /DOSSIER DE LOT/);
    assert.match(dossier, /VRAC-\d{4}-\d{5}/);
    assert.match(dossier, /Cout de revient unitaire/);

    const pesee = await html(`/api/documents/of/${cycle.of_id}/bon-de-pesee?format=html`);
    assert.match(pesee, /BON DE PESEE/);
    assert.match(pesee, /Consigne operatoire/);

    const bon = await html(`/api/documents/ventes/${bl.corps.id}?format=html`, 'commercial');
    assert.match(bon, /BON DE LIVRAISON/);
    assert.match(bon, /LOT-PF-\d{4}-\d{5}/, 'les numeros de lots expedies figurent sur le bon');

    const etiquette = await html(`/api/documents/lots/${cycle.lot_pf_id}/etiquette?format=html`);
    assert.match(etiquette, /<svg /, 'le code-barres Code 128 est genere');

    // Rendu PDF reel lorsque le moteur Chromium est disponible.
    const capacites = await api(ctx, 'qualite', 'GET', '/api/documents/capacites');
    if (capacites.corps.pdf_disponible) {
      const rep = await ctx.app.inject({
        method: 'GET', url: `/api/documents/of/${cycle.of_id}/dossier-de-lot`,
        headers: { authorization: `Bearer ${ctx.jetons.qualite}` },
      });
      assert.equal(rep.statusCode, 200);
      assert.equal(rep.headers['content-type'], 'application/pdf');
      assert.equal(rep.rawPayload.subarray(0, 5).toString(), '%PDF-');
    }
  });

  test('journal d audit : chaque operation sensible est horodatee et nominative', async () => {
    const journal = await api(ctx, 'admin', 'GET', '/api/documents/journal-audit?limite=500');
    assert.equal(journal.statut, 200);
    const actions = new Set(journal.corps.map((l: any) => l.action));
    for (const attendue of ['CREATION_OF', 'PESEE', 'CLOTURE_FABRICATION', 'LIBERATION_VRAC', 'CONDITIONNEMENT', 'CLOTURE_OF']) {
      assert.ok(actions.has(attendue), `action ${attendue} tracee`);
    }
    assert.ok(journal.corps.every((l: any) => l.cree_le && (l.utilisateur_id === null || l.nom_complet)));
  });
});
