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
  mot_de_passe: z.string().min(8, 'Le mot de passe doit contenir au moins 8 caracteres.'),
  nom_complet: z.string().min(2),
  role: z.enum(ROLES),
});

export async function routesAuth(app: FastifyInstance): Promise<void> {
  app.post('/connexion', async (req) => {
    const { email, mot_de_passe } = schemaConnexion.parse(req.body);
    const u = await queryOne(
      pool,
      'SELECT id, email, mot_de_passe, nom_complet, role, actif FROM utilisateurs WHERE LOWER(email) = LOWER($1)',
      [email],
    );
    if (!u || !u.actif || !(await verifierMotDePasse(mot_de_passe, u.mot_de_passe))) {
      throw new ErreurMetier('IDENTIFIANTS_INVALIDES', 'Email ou mot de passe incorrect.', 401);
    }
    const profil = { id: u.id, email: u.email, nom_complet: u.nom_complet, role: u.role };
    await tracer(pool, u.id, 'CONNEXION', 'utilisateurs', u.id, {});
    return { jeton: app.jwt.sign(profil), utilisateur: profil };
  });

  app.get('/moi', { preHandler: authentifier }, async (req) => ({ utilisateur: req.utilisateur }));

  app.get('/utilisateurs', { preHandler: exige('*') }, async () =>
    query(pool, 'SELECT id, email, nom_complet, role, actif, cree_le FROM utilisateurs ORDER BY nom_complet'),
  );

  app.post('/utilisateurs', { preHandler: exige('*') }, async (req, rep) => {
    const body = schemaUtilisateur.parse(req.body);
    const u = await queryOne(
      pool,
      `INSERT INTO utilisateurs (email, mot_de_passe, nom_complet, role)
       VALUES ($1, $2, $3, $4) RETURNING id, email, nom_complet, role, actif`,
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
        mot_de_passe: z.string().min(8).optional(),
      })
      .parse(req.body);
    const u = await queryOne(
      pool,
      `UPDATE utilisateurs SET
         nom_complet  = COALESCE($2, nom_complet),
         role         = COALESCE($3, role),
         actif        = COALESCE($4, actif),
         mot_de_passe = COALESCE($5, mot_de_passe)
       WHERE id = $1 RETURNING id, email, nom_complet, role, actif`,
      [id, body.nom_complet ?? null, body.role ?? null, body.actif ?? null,
       body.mot_de_passe ? await hacher(body.mot_de_passe) : null],
    );
    if (!u) throw new ErreurMetier('INTROUVABLE', 'Utilisateur introuvable.', 404);
    await tracer(pool, req.utilisateur.id, 'MAJ_UTILISATEUR', 'utilisateurs', id, body.mot_de_passe ? { ...body, mot_de_passe: '***' } : body);
    return u;
  });
}
