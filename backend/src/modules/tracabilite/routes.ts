import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, queryOne } from '../../db/pool.js';
import { introuvable } from '../../core/erreurs.js';
import { exige } from '../../core/auth.js';
import { rechercherLot, tracabiliteAscendante, tracabiliteDescendante } from './service.js';

export async function routesTracabilite(app: FastifyInstance): Promise<void> {
  app.get('/recherche', { preHandler: exige('tracabilite:lire') }, async (req) => {
    const q = z.object({ code: z.string().min(1) }).parse(req.query);
    return rechercherLot(pool, q.code);
  });

  app.get('/descendante/:lotId', { preHandler: exige('tracabilite:lire') }, async (req) => {
    const { lotId } = z.object({ lotId: z.coerce.number().int() }).parse(req.params);
    return tracabiliteDescendante(pool, lotId);
  });

  app.get('/ascendante/:lotId', { preHandler: exige('tracabilite:lire') }, async (req) => {
    const { lotId } = z.object({ lotId: z.coerce.number().int() }).parse(req.params);
    return tracabiliteAscendante(pool, lotId);
  });

  /**
   * Point d'entree unique : a partir d'un numero de lot (interne ou
   * fournisseur), le systeme deroule la tracabilite dans le sens pertinent.
   */
  app.get('/lot', { preHandler: exige('tracabilite:lire') }, async (req) => {
    const q = z.object({ code: z.string().min(1) }).parse(req.query);
    const lot = await queryOne(
      pool,
      `SELECT l.id, a.type FROM lots_stock l JOIN articles_catalogue a ON a.id = l.article_id
        WHERE UPPER(l.code_lot_interne) = UPPER($1) OR UPPER(COALESCE(l.code_lot_fournisseur,'')) = UPPER($1)
        ORDER BY l.id DESC LIMIT 1`,
      [q.code],
    );
    if (!lot) throw introuvable('Lot', q.code);
    return lot.type === 'PF'
      ? { ...(await tracabiliteAscendante(pool, lot.id)), descendante: await tracabiliteDescendante(pool, lot.id) }
      : tracabiliteDescendante(pool, lot.id);
  });
}
