import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { pool, transaction } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { semerDemonstration } from '../src/db/donnees-demo.js';

export interface Contexte {
  app: FastifyInstance;
  jetons: Record<string, string>;
}

/** Reinitialise integralement la base de test, applique le schema et le jeu de donnees. */
export async function preparerBase(): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool, () => {});
  await transaction((client) => semerDemonstration(client, () => {}));
}

export const COMPTES = {
  admin: 'direction@derma.dz',
  qualite: 'qualite@derma.dz',
  atelier: 'atelier@derma.dz',
  commercial: 'commercial@derma.dz',
  comptabilite: 'comptabilite@derma.dz',
} as const;

export async function demarrer(): Promise<Contexte> {
  await preparerBase();
  const app = await construireApp();
  const jetons: Record<string, string> = {};
  for (const [role, email] of Object.entries(COMPTES)) {
    const rep = await app.inject({
      method: 'POST', url: '/api/auth/connexion',
      payload: { email, mot_de_passe: 'Derma2026!' },
    });
    if (rep.statusCode !== 200) throw new Error(`Connexion ${email} impossible : ${rep.body}`);
    jetons[role] = rep.json().jeton;
  }
  return { app, jetons };
}

export interface Reponse<T = any> { statut: number; corps: T }

export async function api<T = any>(
  ctx: Contexte,
  role: keyof typeof COMPTES,
  methode: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  payload?: unknown,
): Promise<Reponse<T>> {
  const rep = await ctx.app.inject({
    method: methode,
    url,
    headers: { authorization: `Bearer ${ctx.jetons[role]}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  let corps: any;
  try { corps = rep.json(); } catch { corps = rep.body; }
  return { statut: rep.statusCode, corps };
}

export const idArticle = async (ctx: Contexte, sku: string): Promise<number> => {
  const { corps } = await api(ctx, 'admin', 'GET', `/api/articles?recherche=${sku}`);
  const article = corps.find((a: any) => a.code_sku === sku);
  if (!article) throw new Error(`Article ${sku} introuvable`);
  return article.id;
};

export const idFormule = async (ctx: Contexte, code: string): Promise<number> => {
  const { corps } = await api(ctx, 'admin', 'GET', `/api/formules?recherche=${code}`);
  const f = corps.find((x: any) => x.code_formule === code);
  if (!f) throw new Error(`Formule ${code} introuvable`);
  return f.id;
};

export const idClient = async (ctx: Contexte, code: string): Promise<number> => {
  const { corps } = await api(ctx, 'admin', 'GET', `/api/clients?recherche=${code}`);
  const c = corps.find((x: any) => x.code === code);
  if (!c) throw new Error(`Client ${code} introuvable`);
  return c.id;
};

/**
 * Deroule un cycle industriel complet : OF -> pesees -> vrac libere ->
 * conditionnement -> cloture, et renvoie les identifiants produits.
 */
export async function cycleProductionComplet(
  ctx: Contexte,
  options: { codeFormule?: string; masseKg?: number; unites?: number } = {},
) {
  const formuleId = await idFormule(ctx, options.codeFormule ?? 'FOR-CRH-01');
  const creation = await api(ctx, 'qualite', 'POST', '/api/of', {
    formule_id: formuleId,
    masse_nette_kg: options.masseKg ?? 30,
    surdosage_pct: 1.5,
  });
  if (creation.statut !== 201) throw new Error(`Creation OF impossible : ${JSON.stringify(creation.corps)}`);
  const ofId = creation.corps.id;

  // Pesee de chaque ligne en suivant l'allocation FEFO proposee par le systeme
  // (une consigne peut etre servie par plusieurs lots successifs).
  const dossier = await api(ctx, 'atelier', 'GET', `/api/of/${ofId}`);
  for (const ligne of dossier.corps.lignes) {
    const fefo = await api(ctx, 'atelier', 'GET', `/api/of/${ofId}/lignes/${ligne.id}/fefo`);
    if (!fefo.corps.propositions.length) throw new Error(`Aucun lot conforme pour ${ligne.code_sku}`);
    for (const proposition of fefo.corps.propositions) {
      const pesee = await api(ctx, 'atelier', 'POST', `/api/of/${ofId}/pesees`, {
        of_ligne_id: ligne.id,
        lot_stock_id: proposition.lot_stock_id,
        poids_reel_pesee_g: Number(proposition.a_prelever_g),
      });
      if (pesee.statut !== 201) throw new Error(`Pesee refusee (${ligne.code_sku}) : ${JSON.stringify(pesee.corps)}`);
    }
  }

  const fabrication = await api(ctx, 'atelier', 'POST', `/api/of/${ofId}/fabrication`, {});
  if (fabrication.statut !== 201) throw new Error(`Fabrication : ${JSON.stringify(fabrication.corps)}`);

  const controle = await api(ctx, 'qualite', 'POST', `/api/of/${ofId}/vrac/controle`, {
    ph_mesure: 5.4, viscosite_mesuree: 16000, aspect: 'Creme onctueuse homogene',
    couleur: 'Blanc nacre', odeur: 'Caracteristique', conforme_organoleptique: true, decision: 'LIBERE',
  });
  if (controle.statut !== 200) throw new Error(`Liberation vrac : ${JSON.stringify(controle.corps)}`);

  const unites = options.unites ?? 400;
  const acs = await api(ctx, 'atelier', 'GET', '/api/lots?type=AC&statut=CONFORME&disponible=true');
  const lotAc = (sku: string) => {
    const lot = acs.corps.find((l: any) => l.code_sku === sku);
    if (!lot) throw new Error(`Lot AC ${sku} indisponible`);
    return lot;
  };
  const skusAc = (options.codeFormule ?? 'FOR-CRH-01') === 'FOR-BAU-01'
    ? ['AC-POT-100', 'AC-OPE-100', 'AC-ETI-050']
    : ['AC-FLA-050', 'AC-POM-050', 'AC-ETI-050', 'AC-ETU-050'];
  const conditionnement = await api(ctx, 'atelier', 'POST', `/api/of/${ofId}/conditionnement`, {
    unites_produites: unites,
    unites_rebut: 3,
    consommations: skusAc.map((sku) => {
      const lot = lotAc(sku);
      return { article_ac_id: lot.article_id, lot_stock_id: lot.id, qte_consommee: unites, qte_rebut: 2 };
    }),
  });
  if (conditionnement.statut !== 201) throw new Error(`Conditionnement : ${JSON.stringify(conditionnement.corps)}`);

  await api(ctx, 'qualite', 'POST', `/api/of/${ofId}/heures`, { heures_production: 6 });
  const cloture = await api(ctx, 'qualite', 'POST', `/api/of/${ofId}/cloturer`);
  if (cloture.statut !== 200) throw new Error(`Cloture : ${JSON.stringify(cloture.corps)}`);

  return {
    of_id: ofId,
    lot_pf_id: conditionnement.corps.lot_pf.id,
    code_lot_pf: conditionnement.corps.lot_pf.code_lot_interne,
    cru: cloture.corps.cru,
    dossier: dossier.corps,
  };
}
