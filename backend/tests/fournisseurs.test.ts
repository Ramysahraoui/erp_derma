import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, pool } from '../src/db/pool.js';
import { api, demarrer, idArticle, type Contexte } from './aide.js';

let ctx: Contexte;
before(async () => { ctx = await demarrer(); });
after(async () => { await ctx.app.close(); await closePool(); });

describe('Gestion des fournisseurs', () => {
  let id: number;

  test('creation, code normalise et unicite controlee', async () => {
    const cree = await api(ctx, 'qualite', 'POST', '/api/fournisseurs', {
      code: ' frn-test ', raison_sociale: 'Laboratoires Test SARL', contact: 'Mme Benali',
      telephone: '0555 12 34 56', email: '', adresse: 'Zone industrielle, Blida',
    });
    assert.equal(cree.statut, 201, JSON.stringify(cree.corps));
    assert.equal(cree.corps.code, 'FRN-TEST');
    assert.equal(cree.corps.email, null, 'un e-mail vide est enregistre comme absent');
    assert.equal(cree.corps.actif, true);
    id = cree.corps.id;

    const doublon = await api(ctx, 'admin', 'POST', '/api/fournisseurs', { code: 'Frn-Test', raison_sociale: 'Autre' });
    assert.equal(doublon.statut, 409);
    assert.equal(doublon.corps.erreur, 'CODE_DEJA_UTILISE');

    const invalide = await api(ctx, 'admin', 'POST', '/api/fournisseurs', { code: 'FRN-X', raison_sociale: 'X', email: 'pas-un-email' });
    assert.equal(invalide.statut, 422);
  });

  test('modification tracee champ par champ', async () => {
    const maj = await api(ctx, 'qualite', 'PATCH', `/api/fournisseurs/${id}`, {
      code: 'FRN-TEST', raison_sociale: 'Laboratoires Test SPA', telephone: '0555 99 99 99', email: 'achats@test.dz',
    });
    assert.equal(maj.statut, 200, JSON.stringify(maj.corps));
    assert.equal(maj.corps.modifications_enregistrees, 3, 'le code inchange n est pas historise');

    const fiche = await api(ctx, 'qualite', 'GET', `/api/fournisseurs/${id}`);
    const parChamp = Object.fromEntries(fiche.corps.modifications.map((m: any) => [m.champ, m]));
    assert.equal(parChamp.raison_sociale.ancienne_valeur, 'Laboratoires Test SARL');
    assert.equal(parChamp.raison_sociale.nouvelle_valeur, 'Laboratoires Test SPA');
    assert.equal(parChamp.email.ancienne_valeur, null);
    assert.ok(parChamp.telephone.utilisateur, 'utilisateur renseigne');

    const pris = await api(ctx, 'qualite', 'PATCH', `/api/fournisseurs/${id}`, { code: 'FRN-CHIM' });
    assert.equal(pris.statut, 409);
  });

  test('fiche : receptions et lots rattaches', async () => {
    const mp = await idArticle(ctx, 'MP-EAU-001');
    const rec = await api(ctx, 'qualite', 'POST', '/api/receptions', {
      fournisseur_id: id, reference_bl_fournisseur: 'BL-T-1',
      lignes: [{ article_id: mp, quantite: 25, code_lot_fournisseur: 'T-001', prix_achat_unitaire: 10, statut: 'QUARANTAINE' }],
    });
    assert.equal(rec.statut, 201, JSON.stringify(rec.corps));
    const fiche = await api(ctx, 'qualite', 'GET', `/api/fournisseurs/${id}`);
    assert.equal(fiche.corps.receptions.length, 1);
    assert.equal(fiche.corps.receptions[0].nb_lots, 1);
    assert.equal(fiche.corps.lots[0].code_lot_fournisseur, 'T-001');
    const liste = await api(ctx, 'qualite', 'GET', '/api/fournisseurs?recherche=test');
    assert.equal(liste.corps.length, 1);
    assert.equal(liste.corps[0].nb_receptions, 1);
  });

  test('un fournisseur desactive ne recoit plus de reception, son historique reste', async () => {
    const off = await api(ctx, 'qualite', 'PATCH', `/api/fournisseurs/${id}`, { actif: false });
    assert.equal(off.corps.actif, false);
    const actifs = await api(ctx, 'qualite', 'GET', '/api/fournisseurs?actif=true');
    assert.ok(!actifs.corps.some((f: any) => f.id === id));
    const inactifs = await api(ctx, 'qualite', 'GET', '/api/fournisseurs?actif=false');
    assert.ok(inactifs.corps.some((f: any) => f.id === id));

    const mp = await idArticle(ctx, 'MP-EAU-001');
    const refus = await api(ctx, 'qualite', 'POST', '/api/receptions', {
      fournisseur_id: id, lignes: [{ article_id: mp, quantite: 5, code_lot_fournisseur: 'T-002', prix_achat_unitaire: 10 }],
    });
    assert.equal(refus.statut, 422);
    assert.equal(refus.corps.erreur, 'FOURNISSEUR_INACTIF');
    const fiche = await api(ctx, 'qualite', 'GET', `/api/fournisseurs/${id}`);
    assert.equal(fiche.corps.receptions.length, 1);

    await assert.rejects(pool.query('DELETE FROM fournisseurs WHERE id = $1', [id]), /SUPPRESSION_INTERDITE/);
  });

  test('droits : lecture pour la comptabilite (depenses), ecriture refusee a l atelier', async () => {
    const compta = await api(ctx, 'comptabilite', 'GET', '/api/fournisseurs');
    assert.equal(compta.statut, 200, 'la comptabilite choisit un fournisseur sur ses depenses');
    const fiche = await api(ctx, 'comptabilite', 'GET', `/api/fournisseurs/${id}`);
    assert.ok(Array.isArray(fiche.corps.depenses));
    assert.equal(fiche.corps.commandes, null, 'commandes d achat masquees sans privilege achat');
    const creation = await api(ctx, 'comptabilite', 'POST', '/api/fournisseurs', { code: 'FRN-CPT', raison_sociale: 'Cabinet comptable' });
    assert.equal(creation.statut, 201);

    assert.equal((await api(ctx, 'atelier', 'GET', '/api/fournisseurs')).statut, 403);
    assert.equal((await api(ctx, 'atelier', 'POST', '/api/fournisseurs', { code: 'FRN-Z', raison_sociale: 'Z' })).statut, 403);
    assert.equal((await api(ctx, 'commercial', 'PATCH', `/api/fournisseurs/${id}`, { actif: true })).statut, 403);
  });
});
