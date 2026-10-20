// Fixtures du parcours e2e (frontend/e2e/fixtures), construites a partir des modeles
// d'import de l'application.  Regeneration : npx tsx tests/outils/generer-fixtures-e2e.ts
import ExcelJS from 'exceljs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { modeleArticles } from '../../src/modules/imports/articles.js';
import { modeleReception } from '../../src/modules/imports/receptions.js';

async function remplir(modele: Buffer, lignes: unknown[][], sortie: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(modele as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  for (let r = 3; r <= ws.rowCount; r++) ws.getRow(r).eachCell((c) => { c.value = null; });
  lignes.forEach((l, i) => { ws.getRow(3 + i).values = l as ExcelJS.CellValue[]; });
  writeFileSync(sortie, Buffer.from(await wb.xlsx.writeBuffer()));
}

const dossier = fileURLToPath(new URL('../../../frontend/e2e/fixtures', import.meta.url));
await remplir(await modeleArticles(), [
  ['MP-E2E-001', 'Beurre de cacao', 'MP', 'kg', 'Theobroma Cacao Seed Butter', 15, null, null, null, null, 'oui'],
  ['AC-E2E-001', 'Tube aluminium 30 ml', 'AC', 'U', null, 300, null, null, null, null, 'oui'],
  ['PF-E2E-001', 'Baume levres 15 ml', 'PF', 'U', null, 40, '890,00', 19, 15, null, 'oui'],
  ['MP-EAU-001', 'Doublon du referentiel', 'MP', 'kg', null, null, null, null, null, null, null],
  ['MP-E2E-002', null, 'MP', 'kg', null, null, null, null, null, null, null],
], `${dossier}/articles.xlsx`);
await remplir(await modeleReception(), [
  ['MP-EAU-001', 300, null, 'EAU-E2E-01', '30/06/2029', 36, 2, 'Magasin A', 'quarantaine'],
  ['AC-FLA-050', null, 1500, 'FL-E2E-01', null, 62, null, null, 'conforme'],
  ['MP-HUJ-003', 87, null, 'HUJ-E2E-01', null, 870, null, null, null],
  ['MP-INCONNU', 10, null, 'X-1', null, 10, null, null, null],
], `${dossier}/reception.xlsx`);
console.log('fixtures ecrites');
