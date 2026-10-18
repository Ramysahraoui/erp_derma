import type pg from 'pg';
import { query, type Db } from '../../db/pool.js';
import { schemaArticle } from '../articles/schema.js';
import { creerArticle, type ArticleEntree } from '../articles/service.js';
import { traduireErreurPg } from '../../core/erreurs.js';
import { tracer } from '../../core/audit.js';
import {
  lireClasseur, versNombre, versOuiNon, genererModele,
  type ColonneImport, type ResultatLigne,
} from './excel.js';

export const COLONNES_ARTICLES: ColonneImport[] = [
  { cle: 'code_sku', libelle: 'Code article unique', obligatoire: true, largeur: 16 },
  { cle: 'designation', libelle: 'Designation', obligatoire: true, largeur: 34 },
  { cle: 'type', libelle: 'Categorie', obligatoire: true, liste: ['MP', 'AC', 'PF'], largeur: 11 },
  { cle: 'unite', libelle: 'Unite', obligatoire: true, liste: ['kg', 'g', 'L', 'ml', 'U'], largeur: 9 },
  { cle: 'nom_inci', libelle: 'Nom INCI (MP)', largeur: 28 },
  { cle: 'seuil_critique', libelle: 'Seuil critique', format: 'nombre', largeur: 14 },
  { cle: 'prix_vente_ht', libelle: 'Prix de vente HT (PF)', format: 'nombre', largeur: 16 },
  { cle: 'tva_pct', libelle: 'TVA en % (19 par defaut)', format: 'nombre', largeur: 12 },
  { cle: 'contenance_ml', libelle: 'Contenance en ml (PF)', format: 'nombre', largeur: 15 },
  { cle: 'densite', libelle: 'Masse volumique g/ml (MP au volume)', format: 'nombre', largeur: 16 },
  { cle: 'disponible', libelle: 'Disponible (oui par defaut)', liste: ['oui', 'non'], largeur: 13 },
];

const LIBELLES = Object.fromEntries(COLONNES_ARTICLES.map((c) => [c.cle, c.libelle.split(' (')[0]]));

export const modeleArticles = () =>
  genererModele(
    'Articles',
    COLONNES_ARTICLES,
    [
      { code_sku: 'MP-EXE-001', designation: 'Glycerine vegetale', type: 'MP', unite: 'kg', nom_inci: 'Glycerin', seuil_critique: 50, densite: 1.26, disponible: 'oui' },
      { code_sku: 'AC-EXE-001', designation: 'Flacon airless 50 ml', type: 'AC', unite: 'U', seuil_critique: 500, disponible: 'oui' },
      { code_sku: 'PF-EXE-001', designation: 'Creme hydratante 50 ml', type: 'PF', unite: 'U', prix_vente_ht: 1850, tva_pct: 19, contenance_ml: 50, disponible: 'oui' },
    ],
    [
      "Remplacer les trois lignes d'exemple par vos articles ; la ligne 2 (aide) peut etre conservee.",
      'Ne pas modifier les en-tetes de la ligne 1 : ils servent a reconnaitre les colonnes.',
      'Categories : MP (matiere premiere : g, kg, L, ml), AC (conditionnement : U), PF (produit fini : U).',
      'Un produit fini doit avoir une contenance en ml. La masse volumique ne concerne que les MP achetees au volume.',
      'Un code deja present dans le referentiel, ou en double dans le fichier, est rejete.',
      'Les decimales peuvent etre saisies avec une virgule (12,5).',
    ],
  );

/**
 * Controle de chaque ligne d'un fichier d'articles : formats, champs
 * obligatoires, regles metier (schema de saisie partage avec l'ecran) et
 * doublons, dans le fichier comme dans le referentiel.
 */
export async function analyserArticles(db: Db, contenu: Buffer) {
  const lu = await lireClasseur(contenu, COLONNES_ARTICLES);
  const existants = new Set(
    (await query<{ code: string }>(db, 'SELECT UPPER(code_sku) AS code FROM articles_catalogue')).map((r) => r.code),
  );
  const vus = new Map<string, number>();
  const lignes: ResultatLigne<ArticleEntree>[] = [];

  for (const { numero, valeurs } of lu.lignes) {
    const erreurs: string[] = [];
    const nombre = (cle: string) => {
      const n = versNombre(valeurs[cle] ?? null);
      if (n === 'invalide') { erreurs.push(`${LIBELLES[cle]} : « ${valeurs[cle]} » n'est pas un nombre.`); return undefined; }
      return n ?? undefined;
    };
    const disponible = versOuiNon(valeurs.disponible ?? null);
    if (disponible === 'invalide') erreurs.push(`Disponible : « ${valeurs.disponible} » (oui ou non attendu).`);

    const unite = valeurs.unite?.trim();
    const brut = {
      code_sku: valeurs.code_sku?.trim().toUpperCase(),
      designation: valeurs.designation?.trim(),
      type: valeurs.type?.trim().toUpperCase(),
      unite: unite && ['u', 'unite', 'unites', 'piece', 'pieces'].includes(unite.toLowerCase()) ? 'U'
        : unite?.toLowerCase() === 'l' ? 'L' : unite?.toLowerCase(),
      nom_inci: valeurs.nom_inci ?? null,
      seuil_critique: nombre('seuil_critique') ?? 0,
      prix_vente_ht: nombre('prix_vente_ht') ?? 0,
      tva_pct: nombre('tva_pct') ?? 19,
      contenance_ml: nombre('contenance_ml') ?? null,
      densite: nombre('densite') ?? null,
      actif: disponible === 'invalide' || disponible === null ? true : disponible,
    };

    for (const c of COLONNES_ARTICLES.filter((c) => c.obligatoire)) {
      if (!valeurs[c.cle]) erreurs.push(`${LIBELLES[c.cle]} : champ obligatoire vide.`);
    }

    let donnees: ArticleEntree | null = null;
    if (erreurs.length === 0) {
      const verif = schemaArticle.safeParse(brut);
      if (verif.success) donnees = verif.data;
      else {
        for (const i of verif.error.issues) {
          const champ = String(i.path[0] ?? '');
          erreurs.push(`${LIBELLES[champ] ?? champ} : ${i.code === 'invalid_enum_value' ? 'valeur non autorisee' : i.message}`);
        }
      }
    }

    const code = brut.code_sku;
    if (code) {
      if (existants.has(code)) erreurs.push(`Code ${code} deja present dans le referentiel.`);
      const premiere = vus.get(code);
      if (premiere !== undefined) erreurs.push(`Code ${code} en double dans le fichier (deja ligne ${premiere}).`);
      else vus.set(code, numero);
    }

    lignes.push({ numero, valeurs, donnees: erreurs.length ? null : donnees, erreurs });
  }

  return {
    lignes,
    colonnes_inconnues: lu.colonnes_inconnues,
    colonnes_manquantes: lu.colonnes_manquantes,
    resume: {
      total: lignes.length,
      valides: lignes.filter((l) => l.erreurs.length === 0).length,
      rejetees: lignes.filter((l) => l.erreurs.length > 0).length,
    },
  };
}

/**
 * Import effectif : le fichier est re-analyse cote serveur (aucune confiance
 * dans l'apercu transmis au navigateur), puis chaque ligne valide est creee
 * sous son propre point de sauvegarde — un incident sur une ligne la rejette
 * sans annuler les autres.
 */
export async function importerArticles(client: pg.PoolClient, utilisateurId: number, contenu: Buffer, nomFichier: string) {
  const analyse = await analyserArticles(client, contenu);
  if (analyse.colonnes_manquantes.length) {
    return { importees: 0, rejetees: analyse.lignes.length, colonnes_manquantes: analyse.colonnes_manquantes, lignes: [], articles: [] };
  }
  const rejets = analyse.lignes.filter((l) => l.erreurs.length).map((l) => ({
    ligne: l.numero, code: l.valeurs.code_sku ?? null, motifs: l.erreurs,
  }));
  const crees: { ligne: number; id: number; code_sku: string }[] = [];

  for (const l of analyse.lignes.filter((x) => x.donnees)) {
    await client.query('SAVEPOINT ligne_import');
    try {
      const a = await creerArticle(client, utilisateurId, l.donnees!, 'IMPORT_EXCEL');
      await client.query('RELEASE SAVEPOINT ligne_import');
      crees.push({ ligne: l.numero, id: a.id, code_sku: a.code_sku });
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT ligne_import');
      const metier = traduireErreurPg(err);
      rejets.push({ ligne: l.numero, code: l.valeurs.code_sku ?? null, motifs: [metier?.message ?? (err as Error).message] });
    }
  }
  rejets.sort((a, b) => a.ligne - b.ligne);

  const compteRendu = { fichier: nomFichier, total: analyse.lignes.length, importees: crees.length, rejetees: rejets.length };
  await tracer(client, utilisateurId, 'IMPORT_ARTICLES', 'articles_catalogue', null, { ...compteRendu, rejets });
  return { ...compteRendu, articles: crees, rejets, colonnes_inconnues: analyse.colonnes_inconnues };
}
