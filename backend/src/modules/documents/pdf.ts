import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env } from '../../env.js';

/**
 * Emplacements usuels d'un navigateur Chromium utilise comme moteur de rendu
 * PDF cote serveur (aucun binaire n'est telecharge par l'application).
 */
const CANDIDATS = [
  env.chromiumPath,
  process.env.PUPPETEER_EXECUTABLE_PATH ?? '',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
].filter(Boolean);

let cheminCache: string | null | undefined;

export function cheminChromium(): string | null {
  if (cheminCache !== undefined) return cheminCache;
  cheminCache = CANDIDATS.find((c) => existsSync(c)) ?? null;
  if (!cheminCache) {
    // Recherche dans l'arborescence Playwright (versions variables).
    const racine = '/opt/pw-browsers';
    if (existsSync(racine)) {
      for (const dossier of readdirSync(racine)) {
        const candidat = path.join(racine, dossier, 'chrome-linux', 'chrome');
        if (existsSync(candidat)) { cheminCache = candidat; break; }
      }
    }
  }
  return cheminCache ?? null;
}

export const pdfDisponible = (): boolean => cheminChromium() !== null;

/** Convertit un document HTML en PDF A4 via Chromium en mode headless. */
export async function htmlVersPdf(html: string): Promise<Buffer> {
  const chemin = cheminChromium();
  if (!chemin) throw new Error('Aucun moteur de rendu PDF (Chromium) disponible sur ce serveur.');
  const dossier = await mkdtemp(path.join(tmpdir(), 'erp-pdf-'));
  const fichierHtml = path.join(dossier, 'document.html');
  const fichierPdf = path.join(dossier, 'document.pdf');
  try {
    await writeFile(fichierHtml, html, 'utf8');
    await new Promise<void>((resolve, reject) => {
      const processus = spawn(
        chemin,
        [
          '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
          '--no-pdf-header-footer', '--run-all-compositor-stages-before-draw',
          '--virtual-time-budget=4000',
          `--print-to-pdf=${fichierPdf}`,
          `file://${fichierHtml}`,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let err = '';
      processus.stderr?.on('data', (c) => { err += String(c); });
      processus.on('error', reject);
      processus.on('close', (code) => {
        if (code === 0 || existsSync(fichierPdf)) resolve();
        else reject(new Error(`Chromium a echoue (code ${code}) : ${err.slice(-500)}`));
      });
    });
    return await readFile(fichierPdf);
  } finally {
    await rm(dossier, { recursive: true, force: true });
  }
}
