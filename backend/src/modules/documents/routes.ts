import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool, query, queryOne } from '../../db/pool.js';
import { ErreurMetier, introuvable } from '../../core/erreurs.js';
import { exige } from '../../core/auth.js';
import { dossierDeLot } from '../production/service.js';
import { htmlVersPdf, pdfDisponible } from './pdf.js';
import {
  modeleBonDePesee, modeleCommandeAchat, modeleDocumentVente, modeleEtiquetteLot, modeleFicheSuiveuse,
} from './modeles.js';

const schemaFormat = z.object({ format: z.enum(['pdf', 'html']).default('pdf') });

/** Sert un document au format PDF (moteur Chromium) ou HTML imprimable. */
async function servir(rep: FastifyReply, html: string, nomFichier: string, format: 'pdf' | 'html') {
  if (format === 'html' || !pdfDisponible()) {
    return rep.type('text/html; charset=utf-8').send(html);
  }
  const pdf = await htmlVersPdf(html);
  return rep
    .type('application/pdf')
    .header('Content-Disposition', `inline; filename="${nomFichier}.pdf"`)
    .send(pdf);
}

export async function routesDocuments(app: FastifyInstance): Promise<void> {
  app.get('/of/:id/bon-de-pesee', { preHandler: exige('production:lire') }, async (req, rep) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { format } = schemaFormat.parse(req.query);
    const dossier = await dossierDeLot(pool, id);
    return servir(rep, modeleBonDePesee(dossier), `bon-de-pesee-${dossier.code_of}`, format);
  });

  app.get('/of/:id/dossier-de-lot', { preHandler: exige('production:lire') }, async (req, rep) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { format } = schemaFormat.parse(req.query);
    const dossier = await dossierDeLot(pool, id);
    return servir(rep, modeleFicheSuiveuse(dossier), `dossier-de-lot-${dossier.code_of}`, format);
  });

  app.get('/ventes/:id', { preHandler: exige('vente:lire') }, async (req, rep) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { format } = schemaFormat.parse(req.query);
    const doc = await queryOne(
      pool,
      `SELECT v.*, c.raison_sociale, c.code AS client_code, c.adresse_facturation, c.adresse_livraison,
              c.nif, c.registre_commerce, c.delai_paiement_jours, p.numero_piece AS document_parent_numero
         FROM ventes_documents v
         JOIN clients c ON c.id = v.client_id
         LEFT JOIN ventes_documents p ON p.id = v.document_parent_id
        WHERE v.id = $1`,
      [id],
    );
    if (!doc) throw introuvable('Document de vente', id);
    const lignes = await query(
      pool,
      `SELECT vl.*, a.code_sku, a.unite, l.code_lot_interne, l.dluo
         FROM ventes_lignes vl
         JOIN articles_catalogue a ON a.id = vl.article_id
         LEFT JOIN lots_stock l ON l.id = vl.lot_pf_id
        WHERE vl.document_id = $1 ORDER BY vl.ordre, vl.id`,
      [id],
    );
    return servir(rep, modeleDocumentVente({ ...doc, lignes }), `${doc.type_doc}-${doc.numero_piece}`, format);
  });

  app.get('/lots/:id/etiquette', { preHandler: exige('stock:lire') }, async (req, rep) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { format } = schemaFormat.parse(req.query);
    const lot = await queryOne(
      pool,
      `SELECT l.*, a.code_sku, a.designation, a.unite FROM lots_stock l
         JOIN articles_catalogue a ON a.id = l.article_id WHERE l.id = $1`,
      [id],
    );
    if (!lot) throw introuvable('Lot', id);
    return servir(rep, modeleEtiquetteLot(lot), `etiquette-${lot.code_lot_interne}`, format);
  });

  app.get('/commandes-achat/:id', { preHandler: exige('achat:lire') }, async (req, rep) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { format } = schemaFormat.parse(req.query);
    const commande = await queryOne(
      pool,
      `SELECT c.*, f.raison_sociale AS fournisseur FROM commandes_achat c
         LEFT JOIN fournisseurs f ON f.id = c.fournisseur_id WHERE c.id = $1`,
      [id],
    );
    if (!commande) throw introuvable("Commande d'achat", id);
    const lignes = await query(
      pool,
      `SELECT cl.*, a.code_sku, a.designation, a.unite FROM commandes_achat_lignes cl
         JOIN articles_catalogue a ON a.id = cl.article_id WHERE cl.commande_id = $1`,
      [id],
    );
    return servir(rep, modeleCommandeAchat({ ...commande, lignes }), `commande-${commande.numero}`, format);
  });

  app.get('/capacites', { preHandler: exige('stock:lire') }, async () => ({
    pdf_disponible: pdfDisponible(),
    moteur: pdfDisponible() ? 'chromium-headless' : 'html-imprimable',
  }));

  app.get('/journal-audit', { preHandler: exige('*') }, async (req) => {
    const f = z
      .object({
        entite: z.string().optional(),
        entite_id: z.string().optional(),
        utilisateur_id: z.coerce.number().int().optional(),
        limite: z.coerce.number().int().min(1).max(1000).default(200),
      })
      .parse(req.query);
    return query(
      pool,
      `SELECT a.*, u.nom_complet, u.role FROM audit_log a
         LEFT JOIN utilisateurs u ON u.id = a.utilisateur_id
        WHERE ($1::text IS NULL OR a.entite = $1)
          AND ($2::text IS NULL OR a.entite_id = $2)
          AND ($3::bigint IS NULL OR a.utilisateur_id = $3)
        ORDER BY a.cree_le DESC, a.id DESC LIMIT $4`,
      [f.entite ?? null, f.entite_id ?? null, f.utilisateur_id ?? null, f.limite],
    );
  });

  app.get('/sante-pdf', async () => {
    if (!pdfDisponible()) throw new ErreurMetier('PDF_INDISPONIBLE', 'Moteur PDF absent : les documents sont servis en HTML imprimable.', 503);
    return { statut: 'ok' };
  });
}
