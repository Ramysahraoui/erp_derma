import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { queryOne } from './pool.js';
import { hacher } from '../core/auth.js';
import { PARAMETRES_DEFAUT } from '../core/parametres.js';

/**
 * Categories analytiques de charges livrees en standard (CDCF module 4.1).
 * Elles constituent le plan de ventilation minimal d'une unite de fabrication ;
 * l'administrateur peut en ajouter depuis l'application.
 */
const CATEGORIES_DEPENSES: [string, string, 'DIRECTE' | 'INDIRECTE'][] = [
  ['LABO', 'Fournitures de laboratoire', 'DIRECTE'],
  ['CONSO', 'Consommables de production', 'DIRECTE'],
  ['MAINT', 'Maintenance des machines', 'DIRECTE'],
  ['ANALYSE', 'Analyses microbiologiques externes', 'DIRECTE'],
  ['CONTROLE', 'Controles qualite et metrologie', 'DIRECTE'],
  ['LOYER', 'Loyer usine', 'INDIRECTE'],
  ['ENERGIE', 'Electricite et eau', 'INDIRECTE'],
  ['TELECOM', 'Abonnements telecoms et informatique', 'INDIRECTE'],
  ['CARBU', 'Carburant et deplacements', 'INDIRECTE'],
  ['TRANSPORT', 'Transport et logistique', 'INDIRECTE'],
  ['COMMERCE', 'Frais de commercialisation', 'INDIRECTE'],
  ['ASSUR', 'Assurances', 'INDIRECTE'],
  ['ADMIN', 'Frais administratifs et honoraires', 'INDIRECTE'],
];

export interface ResultatAmorcage {
  parametres_crees: number;
  categories_creees: number;
  administrateur?: { email: string; mot_de_passe_genere?: string };
}

/** Mot de passe initial robuste, lisible et transcriptible sans ambiguite. */
function motDePasseAleatoire(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const octets = randomBytes(18);
  return Array.from(octets, (o) => alphabet[o % alphabet.length]).join('');
}

/**
 * Amorcage d'une installation : parametres d'exploitation, plan de ventilation
 * analytique et compte administrateur initial. Strictement idempotent — il est
 * rejoue a chaque demarrage sans jamais ecraser une donnee existante, et
 * n'injecte aucune donnee fictive (ni article, ni client, ni formule).
 */
export async function amorcer(
  client: pg.PoolClient,
  options: { adminEmail?: string; adminMotDePasse?: string; adminNom?: string } = {},
  log: (message: string) => void = () => {},
): Promise<ResultatAmorcage> {
  const resultat: ResultatAmorcage = { parametres_crees: 0, categories_creees: 0 };

  for (const [cle, def] of Object.entries(PARAMETRES_DEFAUT)) {
    const { rowCount } = await client.query(
      'INSERT INTO parametres (cle, valeur, libelle) VALUES ($1,$2,$3) ON CONFLICT (cle) DO NOTHING',
      [cle, def.valeur, def.libelle],
    );
    resultat.parametres_crees += rowCount ?? 0;
  }

  for (const [code, libelle, type] of CATEGORIES_DEPENSES) {
    const { rowCount } = await client.query(
      'INSERT INTO depenses_categories (code, libelle, type) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING',
      [code, libelle, type],
    );
    resultat.categories_creees += rowCount ?? 0;
  }

  // Compte administrateur : cree uniquement si la base ne contient aucun
  // utilisateur, afin de ne jamais reintroduire un acces a chaque redemarrage.
  const existants = await queryOne<{ n: number }>(client, 'SELECT COUNT(*)::int AS n FROM utilisateurs');
  if ((existants?.n ?? 0) === 0) {
    const email = options.adminEmail?.trim() || 'admin@local';
    const motDePasseFourni = options.adminMotDePasse?.trim();
    const motDePasse = motDePasseFourni || motDePasseAleatoire();
    await client.query(
      `INSERT INTO utilisateurs (email, mot_de_passe, nom_complet, role, doit_changer_mot_de_passe)
       VALUES ($1, $2, $3, 'ADMIN', TRUE)`,
      [email, await hacher(motDePasse), options.adminNom?.trim() || 'Administrateur'],
    );
    resultat.administrateur = { email, ...(motDePasseFourni ? {} : { mot_de_passe_genere: motDePasse }) };
    log(`[amorcage] compte administrateur cree : ${email}`);
    if (!motDePasseFourni) {
      log('');
      log('  ┌───────────────────────────────────────────────────────────────┐');
      log('  │  MOT DE PASSE ADMINISTRATEUR GENERE — a noter immediatement   │');
      log('  ├───────────────────────────────────────────────────────────────┤');
      log(`  │  Identifiant : ${email.padEnd(46)} │`);
      log(`  │  Mot de passe : ${motDePasse.padEnd(45)} │`);
      log('  │  Changement impose a la premiere connexion.                   │');
      log('  └───────────────────────────────────────────────────────────────┘');
      log('');
    }
  }

  if (resultat.parametres_crees || resultat.categories_creees) {
    log(`[amorcage] ${resultat.parametres_crees} parametre(s) et ${resultat.categories_creees} categorie(s) de charges initialises`);
  }
  return resultat;
}
