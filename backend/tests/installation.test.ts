import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, pool, transaction } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { amorcer } from '../src/db/amorcage.js';
import { construireApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

/** Installation neuve : schema applique sur une base vide, sans amorcage. */
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool, () => {});
  app = await construireApp();
});
after(async () => { await app.close(); await closePool(); });

const appel = async (methode: 'GET' | 'POST', url: string, jeton?: string, payload?: unknown) => {
  const rep = await app.inject({
    method: methode, url,
    ...(jeton ? { headers: { authorization: `Bearer ${jeton}` } } : {}),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { statut: rep.statusCode, corps: rep.json() as any };
};

describe("Installation d'un site neuf", () => {
  test('amorcage : parametrage livre, aucune donnee fictive', async () => {
    const resultat = await transaction((client) => amorcer(client, { adminEmail: 'admin@usine.test' }, () => {}));

    assert.ok(resultat.parametres_crees >= 7, 'les parametres d exploitation sont initialises');
    assert.ok(resultat.categories_creees >= 13, 'le plan de ventilation analytique est livre');
    assert.equal(resultat.administrateur?.email, 'admin@usine.test');
    assert.ok(resultat.administrateur?.mot_de_passe_genere, 'un mot de passe initial est genere');
    assert.ok(
      (resultat.administrateur!.mot_de_passe_genere as string).length >= 18,
      'le mot de passe genere est suffisamment long',
    );

    // La base ne contient aucune donnee metier simulee.
    for (const table of ['articles_catalogue', 'clients', 'formules', 'lots_stock',
      'ordres_fabrication', 'ventes_documents', 'fournisseurs', 'salaries']) {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
      assert.equal(rows[0].n, 0, `la table ${table} doit etre vide sur une installation neuve`);
    }
    const { rows: utilisateurs } = await pool.query('SELECT COUNT(*)::int AS n FROM utilisateurs');
    assert.equal(utilisateurs[0].n, 1, 'un seul compte : l administrateur');
  });

  test('amorcage idempotent : rejoue a chaque demarrage sans effet de bord', async () => {
    const deuxieme = await transaction((client) => amorcer(client, { adminEmail: 'autre@usine.test' }, () => {}));
    assert.equal(deuxieme.parametres_crees, 0);
    assert.equal(deuxieme.categories_creees, 0);
    assert.equal(deuxieme.administrateur, undefined, 'aucun second compte administrateur n est cree');
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM utilisateurs');
    assert.equal(rows[0].n, 1);
  });

  test("le mot de passe initial doit etre change avant tout acces metier", async () => {
    // Mot de passe connu : on rejoue l'amorcage sur une base remise a neuf.
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool, () => {});
    await transaction((client) =>
      amorcer(client, { adminEmail: 'admin@usine.test', adminMotDePasse: 'installation-initiale-2026' }, () => {}),
    );

    const connexion = await appel('POST', '/api/auth/connexion', undefined, {
      email: 'admin@usine.test', mot_de_passe: 'installation-initiale-2026',
    });
    assert.equal(connexion.statut, 200);
    assert.equal(connexion.corps.utilisateur.doit_changer_mot_de_passe, true);
    const jeton = connexion.corps.jeton;

    // Aucun ecran metier n'est accessible, y compris par appel direct a l'API.
    const refus = await appel('GET', '/api/articles', jeton);
    assert.equal(refus.statut, 403);
    assert.equal(refus.corps.erreur, 'MOT_DE_PASSE_A_CHANGER');

    // Un mot de passe trop court est refuse.
    const tropCourt = await appel('POST', '/api/auth/mot-de-passe', jeton, {
      ancien_mot_de_passe: 'installation-initiale-2026', nouveau_mot_de_passe: 'court',
    });
    assert.equal(tropCourt.statut, 422);

    // Reprendre le meme mot de passe est refuse.
    const identique = await appel('POST', '/api/auth/mot-de-passe', jeton, {
      ancien_mot_de_passe: 'installation-initiale-2026', nouveau_mot_de_passe: 'installation-initiale-2026',
    });
    assert.equal(identique.statut, 422);
    assert.equal(identique.corps.erreur, 'MOT_DE_PASSE_IDENTIQUE');

    // Changement valide : un jeton libere est renvoye immediatement.
    const change = await appel('POST', '/api/auth/mot-de-passe', jeton, {
      ancien_mot_de_passe: 'installation-initiale-2026', nouveau_mot_de_passe: 'phrase-de-passe-usine-2026',
    });
    assert.equal(change.statut, 200);
    assert.equal(change.corps.utilisateur.doit_changer_mot_de_passe, false);
    const acces = await appel('GET', '/api/articles', change.corps.jeton);
    assert.equal(acces.statut, 200, 'acces metier ouvert sans nouvelle connexion');

    // L'ancien mot de passe ne fonctionne plus.
    const ancien = await appel('POST', '/api/auth/connexion', undefined, {
      email: 'admin@usine.test', mot_de_passe: 'installation-initiale-2026',
    });
    assert.equal(ancien.statut, 401);
  });

  test("un compte cree par l'administrateur herite de la meme obligation", async () => {
    const admin = await appel('POST', '/api/auth/connexion', undefined, {
      email: 'admin@usine.test', mot_de_passe: 'phrase-de-passe-usine-2026',
    });
    const creation = await appel('POST', '/api/auth/utilisateurs', admin.corps.jeton, {
      email: 'operateur@usine.test', mot_de_passe: 'provisoire-2026', nom_complet: 'Operateur Atelier',
      role: 'OPERATEUR_PRODUCTION',
    });
    assert.equal(creation.statut, 201);

    const connexion = await appel('POST', '/api/auth/connexion', undefined, {
      email: 'operateur@usine.test', mot_de_passe: 'provisoire-2026',
    });
    assert.equal(connexion.corps.utilisateur.doit_changer_mot_de_passe, true);
    const refus = await appel('GET', '/api/of', connexion.corps.jeton);
    assert.equal(refus.statut, 403);
  });
});
