import type { z } from 'zod';
import { queryOne, type Db } from '../../db/pool.js';
import { tracer } from '../../core/audit.js';
import type { schemaArticle } from './schema.js';

export type ArticleEntree = z.infer<typeof schemaArticle>;

/** Creation d'un article (saisie unitaire ou import Excel). */
export async function creerArticle(db: Db, utilisateurId: number, b: ArticleEntree, origine = 'SAISIE') {
  const a = await queryOne(
    db,
    `INSERT INTO articles_catalogue
       (code_sku, designation, type, unite, nom_inci, seuil_critique, prix_vente_ht, tva_pct, contenance_ml, densite, actif)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [b.code_sku.toUpperCase(), b.designation, b.type, b.unite, b.nom_inci ?? null, b.seuil_critique,
     b.prix_vente_ht, b.tva_pct, b.contenance_ml ?? null, b.type === 'MP' ? (b.densite ?? null) : null, b.actif],
  );
  await tracer(db, utilisateurId, 'CREATION_ARTICLE', 'articles_catalogue', a!.id, { code_sku: a!.code_sku, origine });
  return a!;
}
