import bcrypt from 'bcryptjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErreurMetier } from './erreurs.js';
import { exigerPermission, type Role } from './rbac.js';

export interface UtilisateurConnecte {
  id: number;
  email: string;
  nom_complet: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    utilisateur: UtilisateurConnecte;
  }
}

export const hacher = (motDePasse: string) => bcrypt.hash(motDePasse, 10);
export const verifierMotDePasse = (clair: string, hache: string) => bcrypt.compare(clair, hache);

/** Prehandler : exige un jeton valide et injecte l'utilisateur dans la requete. */
export async function authentifier(req: FastifyRequest): Promise<void> {
  try {
    const payload = await req.jwtVerify<UtilisateurConnecte & { iat: number; exp: number }>();
    req.utilisateur = {
      id: payload.id,
      email: payload.email,
      nom_complet: payload.nom_complet,
      role: payload.role,
    };
  } catch {
    throw new ErreurMetier('NON_AUTHENTIFIE', 'Jeton absent, invalide ou expire.', 401);
  }
}

/** Prehandler : exige une permission precise de la matrice RBAC. */
export const exige = (permission: string) => async (req: FastifyRequest, _rep: FastifyReply) => {
  await authentifier(req);
  exigerPermission(req.utilisateur.role, permission);
};
