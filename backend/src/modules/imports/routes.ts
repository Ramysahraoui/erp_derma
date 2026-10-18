import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, transaction } from '../../db/pool.js';
import { ErreurMetier } from '../../core/erreurs.js';
import { exige } from '../../core/auth.js';
import { analyserArticles, importerArticles, modeleArticles } from './articles.js';
import { analyserReception, importerReception, modeleReception } from './receptions.js';

const TYPE_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Lit le classeur televerse et les champs de formulaire qui le precedent. */
async function lireEnvoi(req: FastifyRequest) {
  const fichier = await req.file();
  if (!fichier) throw new ErreurMetier('FICHIER_MANQUANT', 'Aucun fichier recu.', 422);
  if (!/\.xlsx$/i.test(fichier.filename)) {
    throw new ErreurMetier('FORMAT_REFUSE', 'Un classeur Excel au format .xlsx est attendu (enregistrer le fichier sous ce format).', 422);
  }
  const contenu = await fichier.toBuffer();
  const champs: Record<string, string> = {};
  for (const [cle, valeur] of Object.entries(fichier.fields)) {
    const v = valeur as { type?: string; value?: unknown };
    if (v && v.type === 'field' && typeof v.value === 'string') champs[cle] = v.value;
  }
  return { contenu, nom: fichier.filename, champs };
}

async function analyser<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ErreurMetier) throw err;
    throw new ErreurMetier('FICHIER_ILLISIBLE', (err as Error).message, 422);
  }
}

const envoyerModele = (rep: FastifyReply, contenu: Buffer, nom: string) =>
  rep.type(TYPE_XLSX).header('Content-Disposition', `attachment; filename="${nom}"`).send(contenu);

const schemaEntete = z.object({
  fournisseur_id: z.coerce.number().int().positive().optional(),
  date_reception: z.string().date().optional(),
  reference_bl_fournisseur: z.string().trim().optional(),
  commentaire: z.string().trim().optional(),
});

export async function routesImports(app: FastifyInstance): Promise<void> {
  // ------------------------------ Articles ---------------------------
  app.get('/articles/modele', { preHandler: exige('article:ecrire') }, async (_req, rep) =>
    envoyerModele(rep, await modeleArticles(), 'modele-import-articles.xlsx'),
  );

  app.post('/articles/apercu', { preHandler: exige('article:ecrire') }, async (req) => {
    const { contenu } = await lireEnvoi(req);
    return analyser(() => analyserArticles(pool, contenu));
  });

  app.post('/articles', { preHandler: exige('article:ecrire') }, async (req) => {
    const { contenu, nom } = await lireEnvoi(req);
    return analyser(() => transaction((client) => importerArticles(client, req.utilisateur.id, contenu, nom)));
  });

  // ----------------------------- Receptions --------------------------
  app.get('/receptions/modele', { preHandler: exige('stock:receptionner') }, async (_req, rep) =>
    envoyerModele(rep, await modeleReception(), 'modele-import-reception.xlsx'),
  );

  app.post('/receptions/apercu', { preHandler: exige('stock:receptionner') }, async (req) => {
    const { contenu } = await lireEnvoi(req);
    return analyser(() => analyserReception(pool, contenu));
  });

  app.post('/receptions', { preHandler: exige('stock:receptionner') }, async (req) => {
    const { contenu, nom, champs } = await lireEnvoi(req);
    const entete = schemaEntete.parse(Object.fromEntries(Object.entries(champs).filter(([, v]) => v !== '')));
    return analyser(() => transaction((client) => importerReception(client, req.utilisateur.id, contenu, nom, entete)));
  });
}
