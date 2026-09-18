import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { mkdirSync } from 'node:fs';
import { ZodError } from 'zod';
import { env, isProd } from './env.js';
import { ErreurMetier, traduireErreurPg } from './core/erreurs.js';

import { routesAuth } from './modules/auth/routes.js';
import { routesArticles } from './modules/articles/routes.js';
import { routesStock } from './modules/stock/routes.js';
import { routesCapacite } from './modules/capacite/routes.js';
import { routesFormules } from './modules/formules/routes.js';
import { routesProduction } from './modules/production/routes.js';
import { routesVentes } from './modules/ventes/routes.js';
import { routesRecouvrement } from './modules/recouvrement/routes.js';
import { routesFinance } from './modules/finance/routes.js';
import { routesTracabilite } from './modules/tracabilite/routes.js';
import { routesDocuments } from './modules/documents/routes.js';

export async function construireApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: isProd
      ? { level: process.env.LOG_LEVEL ?? 'info' }
      : { level: process.env.LOG_LEVEL ?? 'warn', transport: undefined },
    bodyLimit: 15 * 1024 * 1024,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(jwt, { secret: env.jwtSecret, sign: { expiresIn: env.jwtExpiresIn } });
  await app.register(multipart, { limits: { fileSize: 12 * 1024 * 1024 } });

  mkdirSync(env.uploadDir, { recursive: true });
  await app.register(fastifyStatic, { root: env.uploadDir, prefix: '/fichiers/', decorateReply: false });

  // ------------------------------------------------------------------
  // Gestion centralisee des erreurs : les regles metier portees par la
  // base de donnees (triggers) remontent avec leur code d'origine.
  // ------------------------------------------------------------------
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(422).send({
        erreur: 'VALIDATION',
        message: 'Donnees invalides.',
        details: err.issues.map((i) => ({ champ: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof ErreurMetier) {
      return reply.status(err.statut).send({ erreur: err.code, message: err.message, details: err.details });
    }
    const metier = traduireErreurPg(err);
    if (metier) {
      return reply.status(metier.statut).send({ erreur: metier.code, message: metier.message, details: metier.details });
    }
    if ((err as { statusCode?: number }).statusCode && (err as { statusCode: number }).statusCode < 500) {
      return reply.status((err as { statusCode: number }).statusCode).send({
        erreur: (err as { code?: string }).code ?? 'REQUETE_INVALIDE',
        message: (err as Error).message,
      });
    }
    req.log.error({ err }, 'erreur non geree');
    return reply.status(500).send({ erreur: 'ERREUR_INTERNE', message: 'Erreur interne du serveur.' });
  });

  app.get('/api/sante', async () => ({ statut: 'ok', horodatage: new Date().toISOString() }));

  await app.register(routesAuth, { prefix: '/api/auth' });
  await app.register(routesArticles, { prefix: '/api' });
  await app.register(routesStock, { prefix: '/api' });
  await app.register(routesCapacite, { prefix: '/api/capacite' });
  await app.register(routesFormules, { prefix: '/api/formules' });
  await app.register(routesProduction, { prefix: '/api/of' });
  await app.register(routesVentes, { prefix: '/api' });
  await app.register(routesRecouvrement, { prefix: '/api/recouvrement' });
  await app.register(routesFinance, { prefix: '/api' });
  await app.register(routesTracabilite, { prefix: '/api/tracabilite' });
  await app.register(routesDocuments, { prefix: '/api/documents' });

  return app;
}
