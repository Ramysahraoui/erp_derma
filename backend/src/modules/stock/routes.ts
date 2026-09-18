import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { pool, query, queryOne, transaction } from '../../db/pool.js';
import { tracer } from '../../core/audit.js';
import { ErreurMetier, introuvable } from '../../core/erreurs.js';
import { exige } from '../../core/auth.js';
import { env } from '../../env.js';
import { ajusterStock, allouerFefo, changerStatutLot, creerReception } from './service.js';

const schemaLigneReception = z.object({
  article_id: z.coerce.number().int(),
  quantite: z.coerce.number().positive('La quantite recue doit etre strictement positive.'),
  code_lot_fournisseur: z.string().min(1, 'Le numero de lot fournisseur est obligatoire.'),
  dluo: z.string().date().optional().nullable(),
  prix_achat_unitaire: z.coerce.number().min(0),
  frais_approche_unitaire: z.coerce.number().min(0).default(0),
  coa_fichier: z.string().optional().nullable(),
  coa_absent_motif: z.string().min(5, "Motiver l'absence de certificat d'analyse (5 caracteres minimum).").optional().nullable(),
  emplacement: z.string().optional().nullable(),
  statut: z.enum(['QUARANTAINE', 'CONFORME']).default('QUARANTAINE'),
  commentaire: z.string().optional().nullable(),
});

const schemaReception = z.object({
  fournisseur_id: z.coerce.number().int().optional().nullable(),
  date_reception: z.string().date().optional(),
  reference_bl_fournisseur: z.string().optional().nullable(),
  commentaire: z.string().optional().nullable(),
  lignes: z.array(schemaLigneReception).min(1),
});

export async function routesStock(app: FastifyInstance): Promise<void> {
  // -------------------- Upload du certificat d'analyse ---------------
  app.post('/fichiers', { preHandler: exige('stock:receptionner') }, async (req, rep) => {
    const fichier = await req.file();
    if (!fichier) throw new ErreurMetier('FICHIER_MANQUANT', 'Aucun fichier recu.', 422);
    const extensions = ['.pdf', '.png', '.jpg', '.jpeg', '.webp'];
    const ext = path.extname(fichier.filename).toLowerCase();
    if (!extensions.includes(ext)) {
      throw new ErreurMetier('FORMAT_REFUSE', `Le certificat d'analyse doit etre un PDF ou une image (${extensions.join(', ')}).`, 422);
    }
    const nom = `${randomUUID()}${ext}`;
    await pipeline(fichier.file, createWriteStream(path.join(env.uploadDir, nom)));
    if (fichier.file.truncated) throw new ErreurMetier('FICHIER_TROP_VOLUMINEUX', 'Fichier trop volumineux (12 Mo maximum).', 413);
    return rep.status(201).send({ fichier: nom, url: `/fichiers/${nom}`, nom_origine: fichier.filename });
  });

  // ---------------------------- Receptions ---------------------------
  app.post('/receptions', { preHandler: exige('stock:receptionner') }, async (req, rep) => {
    const body = schemaReception.parse(req.body);
    const resultat = await transaction((client) =>
      creerReception(client, req.utilisateur.id, body, body.lignes),
    );
    return rep.status(201).send(resultat);
  });

  app.get('/receptions', { preHandler: exige('stock:lire') }, async () =>
    query(
      pool,
      `SELECT r.*, f.raison_sociale AS fournisseur,
              (SELECT COUNT(*) FROM lots_stock l WHERE l.reception_id = r.id) AS nb_lots
         FROM receptions r LEFT JOIN fournisseurs f ON f.id = r.fournisseur_id
        ORDER BY r.date_reception DESC, r.id DESC LIMIT 200`,
    ),
  );

  app.get('/receptions/:id', { preHandler: exige('stock:lire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const reception = await queryOne(
      pool,
      `SELECT r.*, f.raison_sociale AS fournisseur FROM receptions r
         LEFT JOIN fournisseurs f ON f.id = r.fournisseur_id WHERE r.id = $1`,
      [id],
    );
    if (!reception) throw introuvable('Reception', id);
    const lots = await query(
      pool,
      `SELECT l.*, a.code_sku, a.designation, a.unite FROM lots_stock l
         JOIN articles_catalogue a ON a.id = l.article_id WHERE l.reception_id = $1 ORDER BY l.id`,
      [id],
    );
    return { ...reception, lots };
  });

  // ------------------------------- Lots ------------------------------
  app.get('/lots', { preHandler: exige('stock:lire') }, async (req) => {
    const f = z
      .object({
        article_id: z.coerce.number().int().optional(),
        statut: z.enum(['QUARANTAINE', 'CONFORME', 'REJETE', 'BLOQUE']).optional(),
        type: z.enum(['MP', 'AC', 'PF']).optional(),
        recherche: z.string().optional(),
        disponible: z.coerce.boolean().optional(),
        peremption_avant: z.string().date().optional(),
      })
      .parse(req.query);
    return query(
      pool,
      `SELECT l.*, a.code_sku, a.designation, a.type, a.unite,
              v.code_lot_vrac, f.raison_sociale AS fournisseur,
              (l.dluo IS NOT NULL AND l.dluo < CURRENT_DATE) AS perime
         FROM lots_stock l
         JOIN articles_catalogue a ON a.id = l.article_id
         LEFT JOIN lots_vrac v ON v.id = l.lot_vrac_id
         LEFT JOIN fournisseurs f ON f.id = l.fournisseur_id
        WHERE ($1::bigint IS NULL OR l.article_id = $1)
          AND ($2::text IS NULL OR l.statut = $2::statut_lot)
          AND ($3::text IS NULL OR a.type = $3::type_article)
          AND ($4::text IS NULL OR l.code_lot_interne ILIKE '%'||$4||'%' OR l.code_lot_fournisseur ILIKE '%'||$4||'%'
               OR a.code_sku ILIKE '%'||$4||'%' OR a.designation ILIKE '%'||$4||'%')
          AND ($5::boolean IS NOT TRUE OR l.qte_actuelle > 0)
          AND ($6::date IS NULL OR (l.dluo IS NOT NULL AND l.dluo <= $6::date))
        ORDER BY l.dluo NULLS LAST, l.id DESC
        LIMIT 500`,
      [f.article_id ?? null, f.statut ?? null, f.type ?? null, f.recherche ?? null,
       f.disponible ?? null, f.peremption_avant ?? null],
    );
  });

  app.get('/lots/:id', { preHandler: exige('stock:lire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const lot = await queryOne(
      pool,
      `SELECT l.*, a.code_sku, a.designation, a.type, a.unite, f.raison_sociale AS fournisseur,
              v.code_lot_vrac, r.numero AS numero_reception
         FROM lots_stock l
         JOIN articles_catalogue a ON a.id = l.article_id
         LEFT JOIN fournisseurs f ON f.id = l.fournisseur_id
         LEFT JOIN lots_vrac v ON v.id = l.lot_vrac_id
         LEFT JOIN receptions r ON r.id = l.reception_id
        WHERE l.id = $1`,
      [id],
    );
    if (!lot) throw introuvable('Lot', id);
    const mouvements = await query(
      pool,
      `SELECT m.*, u.nom_complet AS utilisateur
         FROM mouvements_stock m LEFT JOIN utilisateurs u ON u.id = m.utilisateur_id
        WHERE m.lot_stock_id = $1 ORDER BY m.date_mouvement, m.id`,
      [id],
    );
    return { ...lot, mouvements };
  });

  // Statut qualite : liberation / rejet / blocage (R&D-Qualite uniquement).
  app.post('/lots/:id/statut', { preHandler: exige('stock:liberer') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z
      .object({
        statut: z.enum(['QUARANTAINE', 'CONFORME', 'REJETE', 'BLOQUE']),
        motif: z.string().optional().nullable(),
      })
      .parse(req.body);
    return changerStatutLot(pool, req.utilisateur.id, id, b.statut, b.motif);
  });

  // Ajout ou remplacement du certificat d'analyse d'un lot deja receptionne.
  app.post('/lots/:id/coa', { preHandler: exige('stock:receptionner') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z.object({ coa_fichier: z.string().min(1) }).parse(req.body);
    const lot = await queryOne(
      pool,
      `UPDATE lots_stock SET coa_fichier = $2, coa_absent_motif = NULL WHERE id = $1 RETURNING *`,
      [id, b.coa_fichier],
    );
    if (!lot) throw introuvable('Lot', id);
    await tracer(pool, req.utilisateur.id, 'AJOUT_COA', 'lots_stock', id, { coa_fichier: b.coa_fichier });
    return lot;
  });

  app.post('/lots/:id/ajustement', { preHandler: exige('stock:ajuster') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z.object({ quantite: z.coerce.number().refine((v) => v !== 0, 'Quantite non nulle attendue.'), motif: z.string().min(5) }).parse(req.body);
    return transaction((client) => ajusterStock(client, req.utilisateur.id, id, b.quantite, b.motif));
  });

  // ------------------------------ FEFO -------------------------------
  app.get('/stock/fefo', { preHandler: exige('stock:lire') }, async (req) => {
    const f = z.object({ article_id: z.coerce.number().int(), quantite: z.coerce.number().positive() }).parse(req.query);
    return allouerFefo(pool, f.article_id, f.quantite);
  });

  // --------------------- Etat des stocks / alertes -------------------
  app.get('/stock/etat', { preHandler: exige('stock:lire') }, async (req) => {
    const f = z.object({ type: z.enum(['MP', 'AC', 'PF']).optional() }).parse(req.query);
    return query(
      pool,
      `SELECT * FROM v_stock_disponible
        WHERE ($1::text IS NULL OR type = $1::type_article)
        ORDER BY (qte_disponible < seuil_critique) DESC, type, code_sku`,
      [f.type ?? null],
    );
  });

  app.get('/stock/alertes', { preHandler: exige('stock:lire') }, async () => {
    const sousSeuil = await query(
      pool,
      `SELECT * FROM v_stock_disponible WHERE qte_disponible < seuil_critique AND seuil_critique > 0 ORDER BY type, code_sku`,
    );
    const peremptions = await query(
      pool,
      `SELECT l.id, l.code_lot_interne, l.dluo, l.qte_actuelle, a.code_sku, a.designation, a.type, a.unite,
              (l.dluo - CURRENT_DATE) AS jours_restants
         FROM lots_stock l JOIN articles_catalogue a ON a.id = l.article_id
        WHERE l.qte_actuelle > 0 AND l.statut IN ('CONFORME','QUARANTAINE')
          AND l.dluo IS NOT NULL AND l.dluo <= CURRENT_DATE + INTERVAL '90 days'
        ORDER BY l.dluo`,
    );
    const quarantaine = await query(
      pool,
      `SELECT l.id, l.code_lot_interne, l.qte_actuelle, l.date_reception, a.code_sku, a.designation, a.unite
         FROM lots_stock l JOIN articles_catalogue a ON a.id = l.article_id
        WHERE l.statut = 'QUARANTAINE' AND l.qte_actuelle > 0 ORDER BY l.date_reception`,
    );
    return { sous_seuil: sousSeuil, peremptions_proches: peremptions, en_quarantaine: quarantaine };
  });

  app.get('/stock/mouvements', { preHandler: exige('stock:lire') }, async (req) => {
    const f = z
      .object({
        article_id: z.coerce.number().int().optional(),
        type_mouvement: z.string().optional(),
        depuis: z.string().date().optional(),
        limite: z.coerce.number().int().min(1).max(1000).default(200),
      })
      .parse(req.query);
    return query(
      pool,
      `SELECT m.*, l.code_lot_interne, a.code_sku, a.designation, a.unite, u.nom_complet AS utilisateur
         FROM mouvements_stock m
         JOIN lots_stock l ON l.id = m.lot_stock_id
         JOIN articles_catalogue a ON a.id = l.article_id
         LEFT JOIN utilisateurs u ON u.id = m.utilisateur_id
        WHERE ($1::bigint IS NULL OR l.article_id = $1)
          AND ($2::text IS NULL OR m.type_mouvement = $2::type_mouvement)
          AND ($3::date IS NULL OR m.date_mouvement >= $3::date)
        ORDER BY m.date_mouvement DESC, m.id DESC
        LIMIT $4`,
      [f.article_id ?? null, f.type_mouvement ?? null, f.depuis ?? null, f.limite],
    );
  });
}
