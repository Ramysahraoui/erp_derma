import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, query, queryOne } from '../../db/pool.js';
import { ErreurMetier } from '../../core/erreurs.js';
import { authentifier, exige, hacher, verifierMotDePasse } from '../../core/auth.js';
import { ROLES } from '../../core/rbac.js';
import { tracer } from '../../core/audit.js';

const schemaConnexion = z.object({
  email: z.string().email(),
  mot_de_passe: z.string().min(1),
});

const schemaUtilisateur = z.object({
  email: z.string().email(),
  mot_de_passe: z.string().min(10, 'Le mot de passe doit contenir au moins 10 caracteres.'),
  nom_complet: z.string().min(2),
  role: z.enum(ROLES),
});

export async function routesAuth(app: FastifyInstance): Promise<void> {
  app.post('/connexion', async (req) => {
    const { email, mot_de_passe } = schemaConnexion.parse(req.body);
    const u = await queryOne(
      pool,
      `SELECT id, email, mot_de_passe, nom_complet, role, actif, doit_changer_mot_de_passe
         FROM utilisateurs WHERE LOWER(email) = LOWER($1)`,
      [email],
    );
    if (!u || !u.actif || !(await verifierMotDePasse(mot_de_passe, u.mot_de_passe))) {
      throw new ErreurMetier('IDENTIFIANTS_INVALIDES', 'Email ou mot de passe incorrect.', 401);
    }
    await pool.query('UPDATE utilisateurs SET derniere_connexion = NOW() WHERE id = $1', [u.id]);
    const profil = {
      id: u.id, email: u.email, nom_complet: u.nom_complet, role: u.role,
      doit_changer_mot_de_passe: u.doit_changer_mot_de_passe,
    };
    await tracer(pool, u.id, 'CONNEXION', 'utilisateurs', u.id, {});
    return { jeton: app.jwt.sign(profil), utilisateur: profil };
  });

  app.get('/moi', { preHandler: authentifier }, async (req) => {
    const u = await queryOne(
      pool,
      `SELECT id, email, nom_complet, role, doit_changer_mot_de_passe, derniere_connexion
         FROM utilisateurs WHERE id = $1`,
      [req.utilisateur.id],
    );
    return { utilisateur: u ?? req.utilisateur };
  });

  /**
   * Changement de mot de passe par l'utilisateur lui-meme. Leve l'obligation
   * imposee a la premiere connexion (compte d'installation ou compte cree par
   * l'administrateur).
   */
  app.post('/mot-de-passe', { preHandler: authentifier }, async (req) => {
    const b = z
      .object({
        ancien_mot_de_passe: z.string().min(1),
        nouveau_mot_de_passe: z.string().min(10, 'Le nouveau mot de passe doit contenir au moins 10 caracteres.'),
      })
      .parse(req.body);
    const u = await queryOne(pool, 'SELECT id, mot_de_passe FROM utilisateurs WHERE id = $1', [req.utilisateur.id]);
    if (!u || !(await verifierMotDePasse(b.ancien_mot_de_passe, u.mot_de_passe))) {
      throw new ErreurMetier('IDENTIFIANTS_INVALIDES', 'Mot de passe actuel incorrect.', 401);
    }
    if (await verifierMotDePasse(b.nouveau_mot_de_passe, u.mot_de_passe)) {
      throw new ErreurMetier('MOT_DE_PASSE_IDENTIQUE', "Le nouveau mot de passe doit differer de l'ancien.", 422);
    }
    await pool.query(
      'UPDATE utilisateurs SET mot_de_passe = $2, doit_changer_mot_de_passe = FALSE WHERE id = $1',
      [req.utilisateur.id, await hacher(b.nouveau_mot_de_passe)],
    );
    await tracer(pool, req.utilisateur.id, 'CHANGEMENT_MOT_DE_PASSE', 'utilisateurs', req.utilisateur.id, {});

    // Le jeton courant porte encore l'obligation de changement : il est
    // remplace immediatement, sans imposer une nouvelle connexion.
    const profil = {
      id: req.utilisateur.id,
      email: req.utilisateur.email,
      nom_complet: req.utilisateur.nom_complet,
      role: req.utilisateur.role,
      doit_changer_mot_de_passe: false,
    };
    return { statut: 'ok', jeton: app.jwt.sign(profil), utilisateur: profil };
  });

  app.get('/utilisateurs', { preHandler: exige('*') }, async () =>
    query(
      pool,
      `SELECT id, email, nom_complet, role, actif, cree_le, derniere_connexion, doit_changer_mot_de_passe
         FROM utilisateurs ORDER BY nom_complet`,
    ),
  );

  app.post('/utilisateurs', { preHandler: exige('*') }, async (req, rep) => {
    const body = schemaUtilisateur.parse(req.body);
    const u = await queryOne(
      pool,
      `INSERT INTO utilisateurs (email, mot_de_passe, nom_complet, role, doit_changer_mot_de_passe)
       VALUES ($1, $2, $3, $4, TRUE) RETURNING id, email, nom_complet, role, actif`,
      [body.email, await hacher(body.mot_de_passe), body.nom_complet, body.role],
    );
    await tracer(pool, req.utilisateur.id, 'CREATION_UTILISATEUR', 'utilisateurs', u!.id, { role: body.role });
    return rep.status(201).send(u);
  });

  app.patch('/utilisateurs/:id', { preHandler: exige('*') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const body = z
      .object({
        nom_complet: z.string().min(2).optional(),
        role: z.enum(ROLES).optional(),
        actif: z.boolean().optional(),
        mot_de_passe: z.string().min(10).optional(),
      })
      .parse(req.body);
    const u = await queryOne(
      pool,
      `UPDATE utilisateurs SET
         nom_complet  = COALESCE($2, nom_complet),
         role         = COALESCE($3, role),
         actif        = COALESCE($4, actif),
         mot_de_passe = COALESCE($5, mot_de_passe),
         -- Un mot de passe reinitialise par l'administrateur doit etre change
         -- par son titulaire a la connexion suivante.
         doit_changer_mot_de_passe = CASE WHEN $5::text IS NULL THEN doit_changer_mot_de_passe ELSE TRUE END
       WHERE id = $1 RETURNING id, email, nom_complet, role, actif`,
      [id, body.nom_complet ?? null, body.role ?? null, body.actif ?? null,
       body.mot_de_passe ? await hacher(body.mot_de_passe) : null],
    );
    if (!u) throw new ErreurMetier('INTROUVABLE', 'Utilisateur introuvable.', 404);
    await tracer(pool, req.utilisateur.id, 'MAJ_UTILISATEUR', 'utilisateurs', id, body.mot_de_passe ? { ...body, mot_de_passe: '***' } : body);
    return u;
  });
}
