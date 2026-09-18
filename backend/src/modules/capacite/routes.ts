import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, queryOne, transaction } from '../../db/pool.js';
import { exige } from '../../core/auth.js';
import { genererNumero } from '../../core/numerotation.js';
import { tracer } from '../../core/audit.js';
import { d, m2, p4, q3 } from '../../core/nombres.js';
import { simulerPf, simulerPortefeuille } from './service.js';

export async function routesCapacite(app: FastifyInstance): Promise<void> {
  // Simulateur d'usine : capacite theorique et composant limitant.
  app.post('/simulation', { preHandler: exige('stock:lire') }, async (req) => {
    const b = z
      .object({
        produits: z
          .array(
            z.object({
              article_pf_id: z.coerce.number().int(),
              unites_cibles: z.coerce.number().int().positive().optional().nullable(),
              formule_id: z.coerce.number().int().optional(),
            }),
          )
          .min(1),
      })
      .parse(req.body);
    return simulerPortefeuille(pool, b.produits);
  });

  app.get('/produit/:id', { preHandler: exige('stock:lire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const q = z.object({ unites_cibles: z.coerce.number().int().positive().optional() }).parse(req.query);
    return simulerPf(pool, id, q.unites_cibles ?? null);
  });

  // Generation de la commande d'achat couvrant les quantites manquantes.
  app.post('/commande-achat', { preHandler: exige('achat:ecrire') }, async (req, rep) => {
    const b = z
      .object({
        fournisseur_id: z.coerce.number().int().optional().nullable(),
        origine: z.string().optional(),
        lignes: z
          .array(z.object({ article_id: z.coerce.number().int(), quantite: z.coerce.number().positive() }))
          .min(1),
      })
      .parse(req.body);
    const commande = await transaction(async (client) => {
      const numero = await genererNumero(client, 'CA');
      const entete = await queryOne(
        client,
        `INSERT INTO commandes_achat (numero, fournisseur_id, origine, cree_par)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [numero, b.fournisseur_id ?? null, b.origine ?? 'Simulateur de capacite', req.utilisateur.id],
      );
      let total = d(0);
      for (const l of b.lignes) {
        const article = await queryOne(client, 'SELECT pamp FROM articles_catalogue WHERE id = $1', [l.article_id]);
        const prix = d(article?.pamp ?? 0);
        total = total.plus(prix.times(l.quantite));
        await client.query(
          `INSERT INTO commandes_achat_lignes (commande_id, article_id, quantite, prix_unitaire)
           VALUES ($1,$2,$3,$4)`,
          [entete!.id, l.article_id, q3(l.quantite), p4(prix)],
        );
      }
      await client.query('UPDATE commandes_achat SET total_ht = $2 WHERE id = $1', [entete!.id, m2(total)]);
      await tracer(client, req.utilisateur.id, 'CREATION_COMMANDE_ACHAT', 'commandes_achat', entete!.id, {
        numero, nb_lignes: b.lignes.length,
      });
      return { ...entete, total_ht: m2(total) };
    });
    return rep.status(201).send(commande);
  });

  app.get('/commandes-achat', { preHandler: exige('achat:lire') }, async () => {
    const { rows } = await pool.query(
      `SELECT c.*, f.raison_sociale AS fournisseur,
              (SELECT json_agg(json_build_object('article_id', cl.article_id, 'code_sku', a.code_sku,
                       'designation', a.designation, 'unite', a.unite,
                       'quantite', cl.quantite, 'prix_unitaire', cl.prix_unitaire))
                 FROM commandes_achat_lignes cl JOIN articles_catalogue a ON a.id = cl.article_id
                WHERE cl.commande_id = c.id) AS lignes
         FROM commandes_achat c LEFT JOIN fournisseurs f ON f.id = c.fournisseur_id
        ORDER BY c.id DESC LIMIT 100`,
    );
    return rows;
  });
}
