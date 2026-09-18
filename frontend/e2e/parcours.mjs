/**
 * Parcours de validation de l'interface (Chromium pilote par Playwright).
 *
 * Verifie la connexion, l'ensemble des ecrans fonctionnels, l'editeur de formule
 * (indicateur de somme ponderale), le simulateur de capacite, la creation d'un
 * ordre de fabrication avec controle de faisabilite, l'ecran de pesee tactile et
 * les regles liees au certificat d'analyse. Toute erreur console fait echouer
 * l'execution.
 *
 * Prerequis : API sur http://127.0.0.1:3000 et interface sur http://127.0.0.1:5173.
 *
 *   npm i -D playwright                     # une fois
 *   node frontend/e2e/parcours.mjs          # depuis la racine du depot
 *
 * La variable CHROMIUM_PATH permet de pointer un navigateur deja installe.
 */
import { chromium } from 'playwright';

const base = process.env.URL_WEB ?? 'http://127.0.0.1:5173';
const erreurs = [];
const chemin = process.env.CHROMIUM_PATH;
const navigateur = await chromium.launch({ ...(chemin ? { executablePath: chemin } : {}), args: ['--no-sandbox'] });
const page = await navigateur.newPage({ viewport: { width: 1440, height: 950 } });
page.on('console', (m) => { if (m.type() === 'error') erreurs.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => erreurs.push(`pageerror: ${e.message}`));

const etape = async (nom, fn) => {
  try { await fn(); console.log(`OK   ${nom}`); }
  catch (e) { console.log(`FAIL ${nom} :: ${e.message.split('\n')[0]}`); erreurs.push(`${nom}: ${e.message.split('\n')[0]}`); }
};

await etape('connexion', async () => {
  await page.goto(base + '/connexion', { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', 'direction@derma.dz');
  await page.fill('input[type=password]', 'Derma2026!');
  await page.click('button[type=submit]');
  await page.waitForSelector('.barre-haute', { timeout: 10000 });
});

const pages = [
  ['tableau de bord', '/', 'Alertes de reapprovisionnement'],
  ['articles', '/articles', 'Code SKU'],
  ['receptions', '/receptions', 'Numero'],
  ['lots', '/lots', 'Lot interne'],
  ['capacite', '/capacite', 'Selection des produits finis'],
  ['formules', '/formules', 'Somme w/w'],
  ['production', '/production', "Nouvel ordre de fabrication"],
  ['clients', '/clients', 'Plafond de credit'],
  ['ventes', '/ventes', 'Type de document'],
  ['recouvrement', '/recouvrement', 'Balance agee'],
  ['depenses', '/depenses', 'Journal des depenses'],
  ['personnel', '/personnel', 'Fiches salaries'],
  ['rentabilite', '/rentabilite', 'Rentabilite par produit'],
  ['tracabilite', '/tracabilite', 'Recherche par numero de lot'],
  ['administration', '/administration', 'Utilisateurs'],
];
for (const [nom, chemin, texte] of pages) {
  await etape(`page ${nom}`, async () => {
    await page.goto(base + chemin, { waitUntil: 'networkidle' });
    await page.waitForFunction((t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()), texte, { timeout: 8000 });
  });
}

await etape('editeur de formule (somme ponderale)', async () => {
  await page.goto(base + '/formules', { waitUntil: 'networkidle' });
  await page.click('table.tableau tbody tr');
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('somme ponderale'), null, { timeout: 8000 });
  const texte = await page.innerText('.grille.quatre');
  if (!texte.includes('100,000')) throw new Error('somme ponderale attendue a 100,000 % : ' + texte.slice(0, 120));
});

await etape("simulateur de capacite", async () => {
  await page.goto(base + '/capacite', { waitUntil: 'networkidle' });
  await page.click('table.tableau tbody tr input[type=checkbox]');
  await page.click('button:has-text("Lancer la simulation")');
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('composant limitant'), null, { timeout: 10000 });
});

await etape("creation d'un OF et ecran de pesee", async () => {
  await page.goto(base + '/production', { waitUntil: 'networkidle' });
  await page.click('button:has-text("Nouvel ordre de fabrication")');
  await page.waitForSelector('.modale');
  await page.selectOption('.modale select', { index: 1 });
  await page.click('.modale button:has-text("Simuler")');
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('masse maximale fabricable'), null, { timeout: 8000 });
  await page.click('.modale button:has-text("Lancer l\'ordre de fabrication")');
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('etape 1'), null, { timeout: 10000 });
  await page.click('a:has-text("Ouvrir l\'ecran de pesee")');
  await page.waitForSelector('.atelier', { timeout: 8000 });
  await page.click('.atelier table.tableau tbody tr');
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('consigne a peser'), null, { timeout: 8000 });
});

await etape("pesee tactile : saisie et validation", async () => {
  await page.click('button:has-text("Consigne")');
  await page.click('button:has-text("Valider la pesee")');
  await page.waitForFunction(() => /pesee validee|prelevement enregistre/i.test(document.body.innerText), null, { timeout: 8000 });
});

await etape("reception : certificat d'analyse obligatoire", async () => {
  await page.goto(base + '/receptions', { waitUntil: 'networkidle' });
  await page.click('button:has-text("Saisir une reception")');
  await page.waitForSelector('.modale');
  const texte = await page.innerText('.modale');
  if (!/certificat d'analyse est obligatoire/i.test(texte)) throw new Error("consigne CoA absente du formulaire");
  if (!/Motif d'absence du certificat/i.test(texte)) throw new Error("champ motif absent");
  await page.click('.modale button[aria-label="Fermer"]');
});

await etape('fiche lot : certificat manquant signale', async () => {
  await page.goto(base + '/lots?statut=QUARANTAINE', { waitUntil: 'networkidle' });
  await page.click('table.tableau tbody tr button:has-text("Detail")');
  await page.waitForSelector('.modale');
  const texte = await page.innerText('.modale');
  if (!/certificat d'analyse manquant/i.test(texte)) throw new Error('alerte CoA absente de la fiche lot');
  await page.click('.modale button[aria-label="Fermer"]');
});

console.log(erreurs.length ? `\n${erreurs.length} probleme(s) :\n- ` + erreurs.join('\n- ') : '\nAucune erreur console ni assertion en echec.');
await navigateur.close();
process.exit(erreurs.length ? 1 : 0);
