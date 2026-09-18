import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, pool } from '../src/db/pool.js';
import { api, cycleProductionComplet, demarrer, idArticle, idClient, idFormule, type Contexte } from './aide.js';

let ctx: Contexte;

before(async () => { ctx = await demarrer(); });
after(async () => { await ctx.app.close(); await closePool(); });

describe('Recette fonctionnelle — criteres d acceptation du CDCF', () => {
  // -----------------------------------------------------------------
  test("TEST-01 : une formule dont la somme des composants vaut 99,80 % est rejetee", async () => {
    const eau = await idArticle(ctx, 'MP-EAU-001');
    const glycerine = await idArticle(ctx, 'MP-GLY-002');

    const creation = await api(ctx, 'qualite', 'POST', '/api/formules', {
      code_formule: 'FOR-TEST-01',
      nom_produit: 'Formule non conforme',
      densite: 1.02,
      lignes: [
        { article_id: eau, phase: 'A', pourcentage_w_w: 60 },
        { article_id: glycerine, phase: 'B', pourcentage_w_w: 39.8 },
      ],
    });
    assert.equal(creation.statut, 422, 'l API doit rejeter la formule');
    assert.equal(creation.corps.erreur, 'FORMULE_SOMME_INVALIDE');
    assert.match(creation.corps.message, /99\.800 %/);
    assert.equal(creation.corps.details.ecart, '-0.200');

    // Aucune formule fantome ne doit subsister.
    const liste = await api(ctx, 'qualite', 'GET', '/api/formules?recherche=FOR-TEST-01');
    assert.equal(liste.corps.length, 0);

    // Le meme refus s applique au remplacement des lignes d une formule existante.
    const brouillon = await api(ctx, 'qualite', 'POST', '/api/formules', {
      code_formule: 'FOR-TEST-01B', nom_produit: 'Brouillon', densite: 1,
    });
    assert.equal(brouillon.statut, 201);
    const lignes = await api(ctx, 'qualite', 'PUT', `/api/formules/${brouillon.corps.id}/lignes`, [
      { article_id: eau, phase: 'A', pourcentage_w_w: 60 },
      { article_id: glycerine, phase: 'B', pourcentage_w_w: 39.8 },
    ]);
    assert.equal(lignes.statut, 422);
    assert.equal(lignes.corps.erreur, 'FORMULE_SOMME_INVALIDE');

    // Et la base de donnees refuse l ecriture meme en contournant l API (trigger differe).
    await assert.rejects(
      async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO formule_lignes (formule_id, article_id, phase, pourcentage_w_w) VALUES ($1,$2,'A',99.800)`,
            [brouillon.corps.id, eau],
          );
          await client.query('COMMIT');
        } finally {
          await client.query('ROLLBACK').catch(() => {});
          client.release();
        }
      },
      /FORMULE_SOMME_INVALIDE/,
    );

    // Une formule totalisant exactement 100,000 % est acceptee.
    const valide = await api(ctx, 'qualite', 'POST', '/api/formules', {
      code_formule: 'FOR-TEST-01C', nom_produit: 'Formule conforme', densite: 1.02,
      lignes: [
        { article_id: eau, phase: 'A', pourcentage_w_w: 60.2 },
        { article_id: glycerine, phase: 'B', pourcentage_w_w: 39.8 },
      ],
    });
    assert.equal(valide.statut, 201);
  });

  // -----------------------------------------------------------------
  test("TEST-02 : fabrication de 500 unites avec stock insuffisant sur un actif — blocage et ingredient limitant", async () => {
    const serum = await idFormule(ctx, 'FOR-SER-01');
    const actif = await idArticle(ctx, 'MP-ACH-006');

    // L acide hyaluronique est ramene a une quantite insuffisante.
    const lots = await api(ctx, 'qualite', 'GET', `/api/lots?article_id=${actif}&disponible=true`);
    const lot = lots.corps[0];
    const ajustement = await api(ctx, 'qualite', 'POST', `/api/lots/${lot.id}/ajustement`, {
      quantite: -(Number(lot.qte_actuelle) - 0.4),
      motif: 'Mise en condition du scenario de recette TEST-02',
    });
    assert.equal(ajustement.statut, 200);

    const simulation = await api(ctx, 'qualite', 'POST', '/api/of/simulation', {
      formule_id: serum, unites_pf_cibles: 500, surdosage_pct: 0,
    });
    assert.equal(simulation.statut, 200);
    assert.equal(simulation.corps.faisabilite.faisable, false);
    assert.equal(simulation.corps.faisabilite.ingredient_limitant.code_sku, 'MP-ACH-006');

    const creation = await api(ctx, 'qualite', 'POST', '/api/of', {
      formule_id: serum, unites_pf_cibles: 500, surdosage_pct: 0,
    });
    assert.equal(creation.statut, 422, 'la validation de l OF doit etre bloquee');
    assert.equal(creation.corps.erreur, 'STOCK_INSUFFISANT_OF');
    assert.equal(creation.corps.details.ingredient_limitant.code_sku, 'MP-ACH-006');
    assert.ok(Number(creation.corps.details.masse_max_kg) > 0, 'le volume maximal possible est affiche');
    assert.ok(creation.corps.details.unites_max < 500);
    assert.match(creation.corps.message, /MP-ACH-006/);

    // Le simulateur de capacite designe le meme goulot d etranglement.
    const pf = await idArticle(ctx, 'PF-SER-050');
    const capacite = await api(ctx, 'qualite', 'GET', `/api/capacite/produit/${pf}?unites_cibles=500`);
    assert.equal(capacite.corps.composant_limitant.code_sku, 'MP-ACH-006');
    assert.equal(capacite.corps.cible_atteignable, false);

    // Le stock est retabli pour la suite de la recette.
    await api(ctx, 'qualite', 'POST', `/api/lots/${lot.id}/ajustement`, {
      quantite: Number(lot.qte_actuelle) - 0.4,
      motif: 'Retablissement du stock apres scenario TEST-02',
    });
  });

  // -----------------------------------------------------------------
  test("TEST-03 : un lot en quarantaine ne peut pas etre affecte a une pesee", async () => {
    const formule = await idFormule(ctx, 'FOR-CRH-01');
    const creation = await api(ctx, 'qualite', 'POST', '/api/of', {
      formule_id: formule, masse_nette_kg: 10, surdosage_pct: 0,
    });
    assert.equal(creation.statut, 201);
    const ofId = creation.corps.id;

    // La glycerine dispose d un lot conforme et d un lot en quarantaine.
    const glycerine = await idArticle(ctx, 'MP-GLY-002');
    const tousLots = await api(ctx, 'qualite', 'GET', `/api/lots?article_id=${glycerine}`);
    const lotQuarantaine = tousLots.corps.find((l: any) => l.statut === 'QUARANTAINE');
    assert.ok(lotQuarantaine, 'le jeu de donnees contient un lot en quarantaine');

    const dossier = await api(ctx, 'atelier', 'GET', `/api/of/${ofId}`);
    const ligne = dossier.corps.lignes.find((l: any) => l.article_id === glycerine);
    assert.ok(ligne, 'la formule contient bien la glycerine');

    // 1. Le lot en quarantaine est absent de la liste proposee a l ecran de pesee.
    const proposes = await api(ctx, 'atelier', 'GET', `/api/of/${ofId}/lignes/${ligne.id}/lots`);
    assert.equal(proposes.statut, 200);
    assert.ok(proposes.corps.length >= 1, 'les lots conformes restent proposes');
    assert.ok(
      !proposes.corps.some((l: any) => l.id === lotQuarantaine.id),
      'le lot en quarantaine est invisible sur l ecran de pesee',
    );

    // 2. Le scan du lot en quarantaine par douchette signale un refus explicite.
    const scan = await api(ctx, 'atelier', 'GET', `/api/of/${ofId}/scan?code=${lotQuarantaine.code_lot_interne}`);
    assert.equal(scan.statut, 200);
    assert.equal(scan.corps.utilisable, false);
    assert.match(scan.corps.message, /QUARANTAINE/);

    // 3. L affectation forcee par appel direct a l API est refusee.
    const pesee = await api(ctx, 'atelier', 'POST', `/api/of/${ofId}/pesees`, {
      of_ligne_id: ligne.id,
      lot_stock_id: lotQuarantaine.id,
      poids_reel_pesee_g: Number(ligne.masse_theorique_g),
    });
    assert.equal(pesee.statut, 422);
    assert.equal(pesee.corps.erreur, 'PESEE_LOT_NON_CONFORME');

    // 4. Un operateur de production ne peut pas liberer un lot lui-meme (RBAC).
    const tentative = await api(ctx, 'atelier', 'POST', `/api/lots/${lotQuarantaine.id}/statut`, {
      statut: 'CONFORME', motif: 'Tentative non autorisee',
    });
    assert.equal(tentative.statut, 403);

    // 5. Apres liberation par la qualite, le meme lot devient utilisable.
    const liberation = await api(ctx, 'qualite', 'POST', `/api/lots/${lotQuarantaine.id}/statut`, {
      statut: 'CONFORME', motif: 'Certificat d analyse conforme recu',
    });
    assert.equal(liberation.statut, 200);
    const apres = await api(ctx, 'atelier', 'GET', `/api/of/${ofId}/lignes/${ligne.id}/lots`);
    assert.ok(apres.corps.some((l: any) => l.id === lotQuarantaine.id));
  });

  // -----------------------------------------------------------------
  test("TEST-04 : un BL depassant le plafond de credit est bloque et exige une autorisation administrateur", async () => {
    const cycle = await cycleProductionComplet(ctx, { masseKg: 30, unites: 400 });
    const clientId = await idClient(ctx, 'CLI-INSTI'); // plafond 150 000
    const pf = await idArticle(ctx, 'PF-CRH-050');

    // 200 unites a 1 850 = 370 000 HT : tres au-dela du plafond.
    const ligne = { article_id: pf, lot_pf_id: cycle.lot_pf_id, quantite: 200, prix_unitaire: 1850 };
    const refuse = await api(ctx, 'commercial', 'POST', '/api/ventes', {
      type_doc: 'BL', client_id: clientId, lignes: [ligne],
    });
    assert.equal(refuse.statut, 402, 'la generation du BL doit etre bloquee');
    assert.equal(refuse.corps.erreur, 'PLAFOND_CREDIT_DEPASSE');
    assert.equal(refuse.corps.details.autorisation_requise, true);
    assert.ok(Number(refuse.corps.details.depassement) > 0);

    // Un mot de passe superviseur errone ne debloque pas.
    const mauvaisMotDePasse = await api(ctx, 'commercial', 'POST', '/api/ventes', {
      type_doc: 'BL', client_id: clientId, lignes: [ligne],
      deblocage: { email: 'direction@derma.dz', mot_de_passe: 'mauvais', motif: 'Tentative' },
    });
    assert.equal(mauvaisMotDePasse.statut, 403);

    // Un non-administrateur ne peut pas autoriser le depassement.
    const nonSuperviseur = await api(ctx, 'commercial', 'POST', '/api/ventes', {
      type_doc: 'BL', client_id: clientId, lignes: [ligne],
      deblocage: { email: 'commercial@derma.dz', mot_de_passe: 'Derma2026!', motif: 'Auto-deblocage' },
    });
    assert.equal(nonSuperviseur.statut, 403);

    // Deblocage administrateur : la piece est creee et l autorisation tracee.
    const autorise = await api(ctx, 'commercial', 'POST', '/api/ventes', {
      type_doc: 'BL', client_id: clientId, lignes: [ligne], valider: true,
      deblocage: { email: 'direction@derma.dz', mot_de_passe: 'Derma2026!', motif: 'Accord direction, garantie bancaire recue' },
    });
    assert.equal(autorise.statut, 201);
    assert.equal(autorise.corps.statut, 'VALIDE');
    assert.ok(autorise.corps.deblocage_par, "l autorisation superviseur est enregistree");
    assert.match(autorise.corps.deblocage_motif, /garantie bancaire/);

    // Une vente dans les limites du plafond passe sans autorisation.
    const pharmacie = await idClient(ctx, 'CLI-PHARMA');
    const normal = await api(ctx, 'commercial', 'POST', '/api/ventes', {
      type_doc: 'BL', client_id: pharmacie, valider: true,
      lignes: [{ article_id: pf, lot_pf_id: cycle.lot_pf_id, quantite: 20, prix_unitaire: 1850 }],
    });
    assert.equal(normal.statut, 201);
  });

  // -----------------------------------------------------------------
  test("TEST-05 : un BL sans numero de lot de produit fini est refuse", async () => {
    const clientId = await idClient(ctx, 'CLI-PHARMA');
    const pf = await idArticle(ctx, 'PF-CRH-050');

    const sansLot = await api(ctx, 'commercial', 'POST', '/api/ventes', {
      type_doc: 'BL', client_id: clientId,
      lignes: [{ article_id: pf, quantite: 5, prix_unitaire: 1850 }],
    });
    assert.equal(sansLot.statut, 422);
    assert.equal(sansLot.corps.erreur, 'LOT_PF_OBLIGATOIRE');
    assert.match(sansLot.corps.message, /lot de produit fini/i);

    // Un devis, lui, peut etre etabli sans lot physique.
    const devis = await api(ctx, 'commercial', 'POST', '/api/ventes', {
      type_doc: 'DEVIS', client_id: clientId,
      lignes: [{ article_id: pf, quantite: 5, prix_unitaire: 1850 }],
    });
    assert.equal(devis.statut, 201);

    // La base refuse egalement une ligne de BL sans lot, hors API.
    const bl = await api(ctx, 'commercial', 'POST', '/api/ventes', {
      type_doc: 'BL', client_id: clientId,
      lignes: [{
        article_id: pf, quantite: 1, prix_unitaire: 1850,
        lot_pf_id: (await api(ctx, 'commercial', 'GET', `/api/ventes/lots-disponibles/${pf}`)).corps[0].id,
      }],
    });
    assert.equal(bl.statut, 201);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO ventes_lignes (document_id, article_id, designation, quantite, prix_unitaire)
         VALUES ($1,$2,'Sans lot',1,1850)`,
        [bl.corps.id, pf],
      ),
      /LOT_PF_OBLIGATOIRE/,
    );
  });

  // -----------------------------------------------------------------
  test("TEST-06 : tracabilite descendante d un lot de matiere premiere jusqu aux clients livres", async () => {
    const cycle = await cycleProductionComplet(ctx, { masseKg: 25, unites: 300 });
    const pf = await idArticle(ctx, 'PF-CRH-050');
    const clientId = await idClient(ctx, 'CLI-DISTRI');

    const bl = await api(ctx, 'commercial', 'POST', '/api/ventes', {
      type_doc: 'BL', client_id: clientId, valider: true,
      lignes: [{ article_id: pf, lot_pf_id: cycle.lot_pf_id, quantite: 60, prix_unitaire: 1850 }],
    });
    assert.equal(bl.statut, 201);

    // On repart du lot d actif recu en amont (acide hyaluronique ou glycerine).
    const glycerine = await idArticle(ctx, 'MP-GLY-002');
    const lots = await api(ctx, 'qualite', 'GET', `/api/lots?article_id=${glycerine}`);
    const lotMp = lots.corps[0];

    const trace = await api(ctx, 'qualite', 'GET', `/api/tracabilite/descendante/${lotMp.id}`);
    assert.equal(trace.statut, 200);
    assert.ok(trace.corps.ordres_fabrication.length >= 1, 'les OF consommateurs sont listes');
    assert.ok(trace.corps.lots_pf.length >= 1, 'les lots de PF generes sont listes');
    assert.ok(trace.corps.clients_livres.length >= 1, 'les clients livres sont nommes');
    const noms = trace.corps.clients_livres.map((c: any) => c.raison_sociale);
    assert.ok(noms.some((n: string) => n.includes('Distribution Cosmetique Est')), `clients trouves : ${noms.join(', ')}`);
    assert.ok(trace.corps.lots_pf.some((l: any) => l.id === cycle.lot_pf_id));

    // Recherche par numero de lot (scenario douchette / saisie manuelle).
    const parCode = await api(ctx, 'qualite', 'GET', `/api/tracabilite/lot?code=${lotMp.code_lot_interne}`);
    assert.equal(parCode.statut, 200);
    assert.equal(parCode.corps.sens, 'DESCENDANTE');

    // Tracabilite ascendante : du lot de PF vers les matieres et fournisseurs.
    const remontee = await api(ctx, 'qualite', 'GET', `/api/tracabilite/ascendante/${cycle.lot_pf_id}`);
    assert.equal(remontee.statut, 200);
    assert.ok(remontee.corps.matieres_premieres.length >= 5);
    assert.ok(remontee.corps.lot_pf.code_lot_vrac.startsWith('VRAC-'));
    assert.ok(remontee.corps.destinations.length >= 1);
  });
});
