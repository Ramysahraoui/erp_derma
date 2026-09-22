import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, pool, transaction } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { amorcer, EMAIL_ADMIN_DEFAUT, estEmailValide } from '../src/db/amorcage.js';
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

  test("l'identifiant administrateur par defaut passe la validation de la connexion", async () => {
    // Regression : « admin@local » etait accepte a l'amorcage mais rejete par
    // z.string().email() sur l'ecran de connexion — compte inutilisable.
    assert.equal(estEmailValide(EMAIL_ADMIN_DEFAUT), true, `${EMAIL_ADMIN_DEFAUT} doit etre une adresse valide`);
    assert.equal(estEmailValide('admin@local'), false, 'un domaine sans extension est rejete');

    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool, () => {});
    const sansConfiguration = await transaction((client) => amorcer(client, {}, () => {}));
    assert.equal(sansConfiguration.administrateur?.email, EMAIL_ADMIN_DEFAUT);

    // L'adresse amorcee est acceptee telle quelle par l'API de connexion.
    const connexion = await appel('POST', '/api/auth/connexion', undefined, {
      email: EMAIL_ADMIN_DEFAUT,
      mot_de_passe: sansConfiguration.administrateur!.mot_de_passe_genere,
    });
    assert.equal(connexion.statut, 200, `connexion refusee : ${JSON.stringify(connexion.corps)}`);
  });

  test("un ADMIN_EMAIL invalide ne produit pas un compte inutilisable", async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool, () => {});
    const journal: string[] = [];
    const resultat = await transaction((client) =>
      amorcer(client, { adminEmail: 'admin@local' }, (m) => journal.push(m)),
    );
    assert.equal(resultat.administrateur?.email, EMAIL_ADMIN_DEFAUT, 'repli sur une adresse valide');
    assert.ok(journal.some((l) => /pas une adresse valide/.test(l)), "l'operateur est averti");

    const connexion = await appel('POST', '/api/auth/connexion', undefined, {
      email: EMAIL_ADMIN_DEFAUT, mot_de_passe: resultat.administrateur!.mot_de_passe_genere,
    });
    assert.equal(connexion.statut, 200);
  });

  test("un mot de passe actuel errone n'invalide pas la session et ne change rien", async () => {
    // Regression : le refus etait renvoye en 401, que le client interpretait
    // comme une session expiree — deconnexion silencieuse, changement percu
    // comme reussi alors que rien n'etait enregistre.
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool, () => {});
    await transaction((client) =>
      amorcer(client, { adminEmail: 'admin@usine.test', adminMotDePasse: 'temporaire-installation' }, () => {}),
    );
    const connexion = await appel('POST', '/api/auth/connexion', undefined, {
      email: 'admin@usine.test', mot_de_passe: 'temporaire-installation',
    });
    const jeton = connexion.corps.jeton;

    for (const saisie of ['temporaire-installation   ', 'temporaire-installatiox']) {
      const refus = await appel('POST', '/api/auth/mot-de-passe', jeton, {
        ancien_mot_de_passe: saisie, nouveau_mot_de_passe: 'phrase-de-passe-usine-2026',
      });
      assert.equal(refus.statut, 422, 'un 401 serait pris pour une session expiree');
      assert.equal(refus.corps.erreur, 'MOT_DE_PASSE_ACTUEL_INCORRECT');
    }

    // La session reste valide et l'etat du compte est intact.
    const profil = await appel('GET', '/api/auth/moi', jeton);
    assert.equal(profil.statut, 200);
    assert.equal(profil.corps.utilisateur.doit_changer_mot_de_passe, true);
    const inchange = await appel('POST', '/api/auth/connexion', undefined, {
      email: 'admin@usine.test', mot_de_passe: 'temporaire-installation',
    });
    assert.equal(inchange.statut, 200, 'le mot de passe temporaire est inchange');

    // Le changement correct, lui, est bien persiste.
    const change = await appel('POST', '/api/auth/mot-de-passe', jeton, {
      ancien_mot_de_passe: 'temporaire-installation', nouveau_mot_de_passe: 'phrase-de-passe-usine-2026',
    });
    assert.equal(change.statut, 200);

    const nouveau = await appel('POST', '/api/auth/connexion', undefined, {
      email: 'admin@usine.test', mot_de_passe: 'phrase-de-passe-usine-2026',
    });
    assert.equal(nouveau.statut, 200, 'le nouveau mot de passe fonctionne');
    assert.equal(nouveau.corps.utilisateur.doit_changer_mot_de_passe, false, "l'obligation est levee");

    const ancien = await appel('POST', '/api/auth/connexion', undefined, {
      email: 'admin@usine.test', mot_de_passe: 'temporaire-installation',
    });
    assert.equal(ancien.statut, 401, 'le mot de passe temporaire ne fonctionne plus');

    // Et l'etat persiste bien en base, hors de toute transaction ouverte.
    const { rows } = await pool.query(
      'SELECT doit_changer_mot_de_passe FROM utilisateurs WHERE LOWER(email) = $1', ['admin@usine.test'],
    );
    assert.equal(rows[0].doit_changer_mot_de_passe, false);
  });

  test("un compte cree par l'administrateur herite de la meme obligation", async () => {
    // Le contexte precedent a remis la base a neuf : on repart d'un amorcage connu.
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool, () => {});
    await transaction((client) =>
      amorcer(client, { adminEmail: 'admin@usine.test', adminMotDePasse: 'phrase-de-passe-usine-2026' }, () => {}),
    );
    const premiere = await appel('POST', '/api/auth/connexion', undefined, {
      email: 'admin@usine.test', mot_de_passe: 'phrase-de-passe-usine-2026',
    });
    await appel('POST', '/api/auth/mot-de-passe', premiere.corps.jeton, {
      ancien_mot_de_passe: 'phrase-de-passe-usine-2026', nouveau_mot_de_passe: 'phrase-de-passe-definitive',
    });
    const admin = await appel('POST', '/api/auth/connexion', undefined, {
      email: 'admin@usine.test', mot_de_passe: 'phrase-de-passe-definitive',
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
