import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, query, queryOne, transaction } from '../../db/pool.js';
import { introuvable } from '../../core/erreurs.js';
import { exige } from '../../core/auth.js';
import { tracer } from '../../core/audit.js';
import {
  annulerDocument, creerDocument, etatEncours, lotsPfDisponibles,
  transformerDocument, validerDocument,
} from './service.js';

const schemaDeblocage = z
  .object({ email: z.string().email(), mot_de_passe: z.string().min(1), motif: z.string().optional().nullable() })
  .optional()
  .nullable();

const schemaLigne = z.object({
  article_id: z.coerce.number().int(),
  lot_pf_id: z.coerce.number().int().optional().nullable(),
  quantite: z.coerce.number().positive(),
  prix_unitaire: z.coerce.number().min(0).optional().nullable(),
  remise_pct: z.coerce.number().min(0).max(100).optional(),
  tva_pct: z.coerce.number().min(0).max(100).optional().nullable(),
  designation: z.string().optional().nullable(),
});

export async function routesVentes(app: FastifyInstance): Promise<void> {
  // ------------------------------ Clients ----------------------------
  app.get('/clients', { preHandler: exige('client:lire') }, async (req) => {
    const f = z.object({ recherche: z.string().optional(), actif: z.coerce.boolean().optional() }).parse(req.query);
    return query(
      pool,
      `SELECT c.*, e.encours_facture, e.encours_echu, e.encours_livre_non_facture,
              (e.encours_facture + e.encours_livre_non_facture) AS encours_total,
              (c.plafond_credit - e.encours_facture - e.encours_livre_non_facture) AS credit_disponible
         FROM clients c JOIN v_encours_clients e ON e.client_id = c.id
        WHERE ($1::text IS NULL OR c.raison_sociale ILIKE '%'||$1||'%' OR c.code ILIKE '%'||$1||'%')
          AND ($2::boolean IS NULL OR c.actif = $2)
        ORDER BY c.raison_sociale`,
      [f.recherche ?? null, f.actif ?? null],
    );
  });

  app.get('/clients/:id', { preHandler: exige('client:lire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const client = await queryOne(pool, 'SELECT * FROM clients WHERE id = $1', [id]);
    if (!client) throw introuvable('Client', id);
    const documents = await query(
      pool,
      `SELECT id, type_doc, numero_piece, date_doc, date_echeance, statut, statut_paiement, total_ttc, montant_paye
         FROM ventes_documents WHERE client_id = $1 ORDER BY date_doc DESC, id DESC LIMIT 100`,
      [id],
    );
    return { ...client, encours: await etatEncours(pool, id), documents };
  });

  app.post('/clients', { preHandler: exige('client:ecrire') }, async (req, rep) => {
    const b = z
      .object({
        code: z.string().min(2),
        raison_sociale: z.string().min(2),
        categorie_tarif: z.string().default('STANDARD'),
        registre_commerce: z.string().optional().nullable(),
        nif: z.string().optional().nullable(),
        contact: z.string().optional().nullable(),
        telephone: z.string().optional().nullable(),
        email: z.string().email().optional().nullable(),
        adresse_facturation: z.string().optional().nullable(),
        adresse_livraison: z.string().optional().nullable(),
        plafond_credit: z.coerce.number().min(0).default(0),
        delai_paiement_jours: z.coerce.number().int().min(0).default(0),
        remise_pct: z.coerce.number().min(0).max(100).default(0),
      })
      .parse(req.body);
    const c = await queryOne(
      pool,
      `INSERT INTO clients (code, raison_sociale, categorie_tarif, registre_commerce, nif, contact, telephone,
                            email, adresse_facturation, adresse_livraison, plafond_credit, delai_paiement_jours, remise_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [b.code.toUpperCase(), b.raison_sociale, b.categorie_tarif, b.registre_commerce ?? null, b.nif ?? null,
       b.contact ?? null, b.telephone ?? null, b.email ?? null, b.adresse_facturation ?? null,
       b.adresse_livraison ?? null, b.plafond_credit, b.delai_paiement_jours, b.remise_pct],
    );
    await tracer(pool, req.utilisateur.id, 'CREATION_CLIENT', 'clients', c!.id, { code: c!.code });
    return rep.status(201).send(c);
  });

  app.patch('/clients/:id', { preHandler: exige('client:ecrire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z
      .object({
        raison_sociale: z.string().min(2).optional(),
        categorie_tarif: z.string().optional(),
        contact: z.string().nullable().optional(),
        telephone: z.string().nullable().optional(),
        email: z.string().email().nullable().optional(),
        adresse_facturation: z.string().nullable().optional(),
        adresse_livraison: z.string().nullable().optional(),
        plafond_credit: z.coerce.number().min(0).optional(),
        delai_paiement_jours: z.coerce.number().int().min(0).optional(),
        remise_pct: z.coerce.number().min(0).max(100).optional(),
        bloque: z.boolean().optional(),
        actif: z.boolean().optional(),
      })
      .parse(req.body);
    const c = await queryOne(
      pool,
      `UPDATE clients SET
         raison_sociale       = COALESCE($2, raison_sociale),
         categorie_tarif      = COALESCE($3, categorie_tarif),
         contact              = COALESCE($4, contact),
         telephone            = COALESCE($5, telephone),
         email                = COALESCE($6, email),
         adresse_facturation  = COALESCE($7, adresse_facturation),
         adresse_livraison    = COALESCE($8, adresse_livraison),
         plafond_credit       = COALESCE($9, plafond_credit),
         delai_paiement_jours = COALESCE($10, delai_paiement_jours),
         remise_pct           = COALESCE($11, remise_pct),
         bloque               = COALESCE($12, bloque),
         actif                = COALESCE($13, actif)
       WHERE id = $1 RETURNING *`,
      [id, b.raison_sociale ?? null, b.categorie_tarif ?? null, b.contact ?? null, b.telephone ?? null,
       b.email ?? null, b.adresse_facturation ?? null, b.adresse_livraison ?? null, b.plafond_credit ?? null,
       b.delai_paiement_jours ?? null, b.remise_pct ?? null, b.bloque ?? null, b.actif ?? null],
    );
    if (!c) throw introuvable('Client', id);
    await tracer(pool, req.utilisateur.id, 'MAJ_CLIENT', 'clients', id, b);
    return c;
  });

  app.get('/clients/:id/encours', { preHandler: exige('client:lire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    return etatEncours(pool, id);
  });

  // ------------------------ Documents de vente -----------------------
  app.get('/ventes', { preHandler: exige('vente:lire') }, async (req) => {
    const f = z
      .object({
        type_doc: z.enum(['DEVIS', 'BC', 'BL', 'FACTURE']).optional(),
        client_id: z.coerce.number().int().optional(),
        statut: z.enum(['BROUILLON', 'VALIDE', 'ANNULE']).optional(),
        statut_paiement: z.enum(['NON_PAYEE', 'PARTIELLE', 'SOLDEE']).optional(),
        recherche: z.string().optional(),
        limite: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    return query(
      pool,
      `SELECT v.*, c.raison_sociale, c.code AS client_code
         FROM ventes_documents v JOIN clients c ON c.id = v.client_id
        WHERE ($1::text IS NULL OR v.type_doc = $1::type_doc_vente)
          AND ($2::bigint IS NULL OR v.client_id = $2)
          AND ($3::text IS NULL OR v.statut = $3::statut_doc)
          AND ($4::text IS NULL OR v.statut_paiement = $4::statut_paiement)
          AND ($5::text IS NULL OR v.numero_piece ILIKE '%'||$5||'%' OR c.raison_sociale ILIKE '%'||$5||'%')
        ORDER BY v.date_doc DESC, v.id DESC LIMIT $6`,
      [f.type_doc ?? null, f.client_id ?? null, f.statut ?? null, f.statut_paiement ?? null, f.recherche ?? null, f.limite],
    );
  });

  app.get('/ventes/:id', { preHandler: exige('vente:lire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const doc = await queryOne(
      pool,
      `SELECT v.*, c.raison_sociale, c.code AS client_code, c.adresse_facturation, c.adresse_livraison,
              c.nif, c.registre_commerce, c.delai_paiement_jours, u.nom_complet AS cree_par_nom,
              p.numero_piece AS document_parent_numero
         FROM ventes_documents v
         JOIN clients c ON c.id = v.client_id
         LEFT JOIN utilisateurs u ON u.id = v.cree_par
         LEFT JOIN ventes_documents p ON p.id = v.document_parent_id
        WHERE v.id = $1`,
      [id],
    );
    if (!doc) throw introuvable('Document de vente', id);
    const lignes = await query(
      pool,
      `SELECT vl.*, a.code_sku, a.unite, l.code_lot_interne, l.dluo, o.code_of, vr.code_lot_vrac
         FROM ventes_lignes vl
         JOIN articles_catalogue a ON a.id = vl.article_id
         LEFT JOIN lots_stock l ON l.id = vl.lot_pf_id
         LEFT JOIN ordres_fabrication o ON o.id = l.of_id
         LEFT JOIN lots_vrac vr ON vr.id = l.lot_vrac_id
        WHERE vl.document_id = $1 ORDER BY vl.ordre, vl.id`,
      [id],
    );
    const enfants = await query(
      pool,
      'SELECT id, type_doc, numero_piece, statut, total_ttc FROM ventes_documents WHERE document_parent_id = $1',
      [id],
    );
    const reglements = await query(
      pool,
      `SELECT ea.*, e.numero, e.mode_reglement, e.date_reglement, e.cheque_numero, e.cheque_statut
         FROM encaissement_affectations ea JOIN encaissements e ON e.id = ea.encaissement_id
        WHERE ea.document_id = $1 ORDER BY e.date_reglement`,
      [id],
    );
    return { ...doc, lignes, documents_lies: enfants, reglements };
  });

  // Lots de PF disponibles pour l'affectation sur un bon de livraison.
  app.get('/ventes/lots-disponibles/:articleId', { preHandler: exige('vente:lire') }, async (req) => {
    const { articleId } = z.object({ articleId: z.coerce.number().int() }).parse(req.params);
    return lotsPfDisponibles(pool, articleId);
  });

  app.post('/ventes', { preHandler: exige('vente:ecrire') }, async (req, rep) => {
    const b = z
      .object({
        type_doc: z.enum(['DEVIS', 'BC', 'BL', 'FACTURE']),
        client_id: z.coerce.number().int(),
        date_doc: z.string().date().optional().nullable(),
        document_parent_id: z.coerce.number().int().optional().nullable(),
        reference_externe: z.string().optional().nullable(),
        commentaire: z.string().optional().nullable(),
        lignes: z.array(schemaLigne).min(1),
        deblocage: schemaDeblocage,
        valider: z.boolean().default(false),
      })
      .parse(req.body);
    const doc = await transaction(async (client) => {
      const cree = await creerDocument(client, req.utilisateur.id, b);
      return b.valider ? validerDocument(client, req.utilisateur.id, cree!.id) : cree;
    });
    return rep.status(201).send(doc);
  });

  app.post('/ventes/:id/valider', { preHandler: exige('vente:ecrire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    return transaction((client) => validerDocument(client, req.utilisateur.id, id));
  });

  app.post('/ventes/:id/transformer', { preHandler: exige('vente:ecrire') }, async (req, rep) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z
      .object({
        cible: z.enum(['BC', 'BL', 'FACTURE']),
        affectations: z
          .array(z.object({ ligne_id: z.coerce.number().int(), lot_pf_id: z.coerce.number().int() }))
          .optional()
          .nullable(),
        deblocage: schemaDeblocage,
        valider: z.boolean().default(false),
      })
      .parse(req.body);
    const doc = await transaction(async (client) => {
      const cree = await transformerDocument(client, req.utilisateur.id, id, b.cible, b.affectations, b.deblocage);
      return b.valider ? validerDocument(client, req.utilisateur.id, cree!.id) : cree;
    });
    return rep.status(201).send(doc);
  });

  app.post('/ventes/:id/annuler', { preHandler: exige('vente:ecrire') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z.object({ motif: z.string().min(5) }).parse(req.body);
    return transaction((client) => annulerDocument(client, req.utilisateur.id, id, b.motif));
  });
}
