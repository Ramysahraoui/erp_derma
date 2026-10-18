/**
 * Parcours de validation de l'interface (Chromium pilote par Playwright).
 *
 * Verifie la connexion, l'ensemble des ecrans fonctionnels, l'editeur de formule
 * (indicateur de somme ponderale), le simulateur de capacite, la creation d'un
 * ordre de fabrication avec controle de faisabilite, l'ecran de pesee tactile et
 * le certificat de conformite facultatif et les parcours V2 (imports Excel,
 * modification tracee, ajustements, reintroduction, releve client). Toute erreur console fait echouer
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
  catch (e) {
    console.log(`FAIL ${nom} :: ${e.message.split('\n')[0]}`);
    erreurs.push(`${nom}: ${e.message.split('\n')[0]}`);
    // Capture d'ecran de l'echec si un dossier est fourni.
    if (process.env.CAPTURES) await page.screenshot({ path: `${process.env.CAPTURES}/${nom.replace(/[^a-z0-9]+/gi, '-')}.png` }).catch(() => {});
  }
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
  ['fournisseurs', '/fournisseurs', 'Raison sociale'],
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

await etape("reception : certificat de conformite facultatif", async () => {
  await page.goto(base + '/receptions', { waitUntil: 'networkidle' });
  await page.click('button:has-text("Saisir une reception")');
  await page.waitForSelector('.modale');
  const texte = await page.innerText('.modale');
  if (!/certificat de conformite est facultatif/i.test(texte)) throw new Error('consigne V2 absente du formulaire');
  if (/Motif d'absence du certificat/i.test(texte)) throw new Error('le motif d absence ne doit plus etre demande');
  await page.click('.modale button[aria-label="Fermer"]');
});

await etape('fiche lot : certificat non joint signale a titre informatif', async () => {
  await page.goto(base + '/lots?statut=QUARANTAINE', { waitUntil: 'networkidle' });
  await page.click('table.tableau tbody tr button:has-text("Detail")');
  await page.waitForSelector('.modale');
  const texte = await page.innerText('.modale');
  if (!/certificat de conformite non joint/i.test(texte)) throw new Error('indication de certificat absente');
  if (!/liberer \(conforme\)/i.test(texte)) throw new Error('la liberation doit rester possible sans certificat');
  await page.click('.modale button[aria-label="Fermer"]');
});

// ----------------------------------------------------------------- V2
const fixture = (nom) => new URL(`./fixtures/${nom}`, import.meta.url).pathname;
const texte = async () => (await page.innerText('body')).toLowerCase();

await etape('V2 import Excel d articles : apercu controle puis compte rendu', async () => {
  await page.goto(base + '/articles', { waitUntil: 'networkidle' });
  await page.click('button:has-text("Importer depuis Excel")');
  await page.waitForSelector('.modale');
  const telechargement = page.waitForEvent('download');
  await page.click('.modale button:has-text("Telecharger le modele")');
  const modele = await telechargement;
  if (!/modele-import-articles\.xlsx$/.test(modele.suggestedFilename())) throw new Error('nom du modele inattendu');
  await page.setInputFiles('.modale input[type=file]', fixture('articles.xlsx'));
  await page.waitForFunction(() => /lignes lues/i.test(document.body.innerText), null, { timeout: 10000 });
  const apercu = await page.innerText('.modale');
  if (!/deja present dans le referentiel/i.test(apercu)) throw new Error('doublon non signale a l apercu');
  if (!/champ obligatoire vide/i.test(apercu)) throw new Error('champ obligatoire non signale');
  await page.click('.modale button:has-text("Importer 3 ligne")');
  await page.waitForFunction(() => /compte rendu d.import/i.test(document.body.innerText), null, { timeout: 10000 });
  if (!/3 ligne\(s\) importee\(s\), 2 rejetee\(s\)/i.test(await page.innerText('.modale'))) throw new Error('compte rendu inattendu');
  await page.click('.modale footer button:has-text("Fermer")');
});

await etape('V2 modification tracee du code, de la disponibilite et du prix', async () => {
  await page.goto(base + '/articles', { waitUntil: 'networkidle' });
  await page.fill('input[placeholder="Code SKU ou designation"]', 'PF-E2E-001');
  await page.waitForTimeout(600);
  await page.click('table.tableau tbody tr');
  await page.waitForSelector('.modale');
  await page.click('.modale button:has-text("Modifier le code")');
  const champs = await page.$$('.modale .ligne-champs input');
  await champs[0].fill('PF-E2E-BAU');
  await champs[1].fill('925');
  await page.selectOption('.modale .ligne-champs select', 'false');
  await page.click('.modale button:has-text("Enregistrer la modification")');
  await page.waitForFunction(() => /3 modification\(s\) enregistree\(s\)/i.test(document.body.innerText), null, { timeout: 8000 });
  await page.click('.modale button:has-text("Historique des modifications")');
  const historique = await page.innerText('.modale');
  for (const attendu of ['PF-E2E-001', 'PF-E2E-BAU', 'Indisponible', '925']) {
    if (!historique.includes(attendu)) throw new Error(`historique : « ${attendu} » absent`);
  }
  await page.click('.modale button[aria-label="Fermer"]');
});

await etape('V2 reception par Excel sans certificat de conformite', async () => {
  await page.goto(base + '/receptions', { waitUntil: 'networkidle' });
  await page.click('button:has-text("Importer depuis Excel")');
  await page.waitForSelector('.modale');
  await page.setInputFiles('.modale input[type=file]', fixture('reception.xlsx'));
  await page.waitForFunction(() => /lignes lues/i.test(document.body.innerText), null, { timeout: 10000 });
  await page.click('.modale button:has-text("Importer 2 ligne")');
  await page.waitForFunction(() => /compte rendu d.import/i.test(document.body.innerText), null, { timeout: 10000 });
  if (!/inconnu/i.test(await page.innerText('.modale'))) throw new Error('motif de rejet absent');
  await page.click('.modale footer button:has-text("Fermer")');
});

await etape('V2 ajustement du stock et reintroduction d un lot rejete', async () => {
  await page.goto(base + '/lots?type=AC', { waitUntil: 'networkidle' });
  await page.fill('input[placeholder^="N° de lot interne"]', 'CAR-12U');
  await page.waitForTimeout(700);
  await page.click('table.tableau tbody tr button:has-text("Detail")');
  await page.waitForSelector('.modale');
  const ajust = page.locator('.modale .carte', { hasText: 'Ajustement de la quantite' });
  await ajust.locator('select').selectOption('REDUIRE');
  await ajust.locator('input[type=number]').fill('12');
  await ajust.locator('input:not([type])').fill('Cartons abimes a la reception');
  await ajust.locator('button:has-text("Enregistrer l\'ajustement")').click();
  await page.waitForFunction(() => /stock reduit de 12/i.test(document.body.innerText), null, { timeout: 8000 });

  await page.click('.modale button:has-text("Rejeter")');
  await page.waitForFunction(() => /reintroduction du lot rejete/i.test(document.body.innerText), null, { timeout: 8000 });
  const reintro = page.locator('.modale .carte', { hasText: 'Reintroduction du lot rejete' });
  await reintro.locator('input').fill('Tri effectue, cartons sains conserves');
  await reintro.locator('button:has-text("Reintroduire en stock")').click();
  await page.waitForFunction(() => /le rejet reste dans l.historique/i.test(document.body.innerText), null, { timeout: 8000 });
  if (!/reintroduction/i.test(await page.innerText('.modale'))) throw new Error('reintroduction absente de l historique');
  await page.click('.modale button[aria-label="Fermer"]');
});

await etape('V2 encaissement visible dans l etat du client', async () => {
  await page.goto(base + '/recouvrement', { waitUntil: 'networkidle' });
  await page.click('button:has-text("Saisir un encaissement")');
  await page.waitForSelector('.modale');
  const selects = page.locator('.modale select');
  await selects.nth(0).selectOption({ label: 'CLI-PARA — Parapharmacie Les Oliviers' });
  await page.fill('.modale input[type=number] >> nth=0', '12500');
  if (!/imputee\s+automatiquement/i.test(await page.innerText('.modale'))) throw new Error('imputation automatique non annoncee');
  await page.click('.modale button:has-text("Enregistrer")');
  await page.waitForSelector('.modale', { state: 'detached', timeout: 8000 });

  await page.goto(base + '/clients', { waitUntil: 'networkidle' });
  await page.click('table.tableau tbody tr:has-text("CLI-PARA")');
  await page.waitForFunction(() => /releve de compte/i.test(document.body.innerText), null, { timeout: 8000 });
  await page.waitForTimeout(600);
  // Les montants formates en francais utilisent des espaces insecables.
  const fiche = (await page.innerText('.modale')).replace(/[\u00a0\u202f]/g, ' ');
  await page.screenshot({ path: process.env.CAPTURE_RELEVE ?? '/dev/null' }).catch(() => {});
  if (!/encaissement enc-/i.test(fiche) || !fiche.includes('12 500,00')) throw new Error('encaissement absent du releve');
  if (!/-12 500,00/.test(fiche)) throw new Error('solde du releve inattendu');
  await page.click('.modale button[aria-label="Fermer"]');
});

await etape('fournisseurs : creation, modification tracee, desactivation', async () => {
  await page.goto(base + '/fournisseurs', { waitUntil: 'networkidle' });
  await page.click('button:has-text("Nouveau fournisseur")');
  await page.waitForSelector('.modale');
  const champs = await page.$$('.modale .ligne-champs input');
  await champs[0].fill('frn-e2e');
  await champs[1].fill('Emballages du Sahel');
  await champs[2].fill('M. Haddad');
  await page.click('.modale button:has-text("Creer le fournisseur")');
  await page.waitForFunction(() => /FRN-E2E — Emballages du Sahel/.test(document.body.innerText), null, { timeout: 8000 });
  await page.click('.modale button:has-text("Modifier la fiche")');
  await page.waitForFunction(() => document.querySelectorAll('.modale').length === 2);
  await page.fill('.modale >> nth=1 >> input[type=email]', 'achats@sahel.dz');
  await page.click('.modale >> nth=1 >> button:has-text("Enregistrer les modifications")');
  await page.waitForFunction(() => /1 modification\(s\) enregistree\(s\)/.test(document.body.innerText), null, { timeout: 8000 });
  await page.click('.modale button[role=tab]:has-text("Historique")');
  if (!(await page.innerText('.modale')).includes('achats@sahel.dz')) throw new Error('modification absente de l historique');
  await page.click('.modale button:has-text("Desactiver le fournisseur")');
  await page.waitForFunction(() => /Fournisseur desactive/.test(document.body.innerText), null, { timeout: 8000 });
  await page.click('.modale button:has-text("Reactiver le fournisseur")');
  await page.waitForFunction(() => !/Fournisseur desactive/.test(document.body.innerText), null, { timeout: 8000 });
  await page.click('.modale button[aria-label="Fermer"]');
  if (!(await page.innerText('table.tableau')).includes('FRN-E2E')) throw new Error('fournisseur absent de la liste');
});

await etape('fournisseurs : creation depuis le formulaire de reception', async () => {
  await page.goto(base + '/receptions', { waitUntil: 'networkidle' });
  await page.click('button:has-text("Saisir une reception")');
  await page.waitForSelector('.modale');
  await page.click('.modale button:has-text("+ Nouveau")');
  await page.waitForFunction(() => document.querySelectorAll('.modale').length === 2);
  const champs = await page.$$('.modale >> nth=1 >> input');
  await champs[0].fill('FRN-VOLEE');
  await champs[1].fill('Chimie du Littoral');
  await page.click('.modale >> nth=1 >> button:has-text("Creer le fournisseur")');
  await page.waitForFunction(() => document.querySelectorAll('.modale').length === 1);
  await page.waitForFunction(() => {
    const s = document.querySelector('.modale select');
    return s && s.selectedOptions[0]?.textContent?.includes('Chimie du Littoral');
  }, null, { timeout: 8000 });
  await page.click('.modale button[aria-label="Fermer"]');
});

console.log(erreurs.length ? `\n${erreurs.length} probleme(s) :\n- ` + erreurs.join('\n- ') : '\nAucune erreur console ni assertion en echec.');
await navigateur.close();
process.exit(erreurs.length ? 1 : 0);
