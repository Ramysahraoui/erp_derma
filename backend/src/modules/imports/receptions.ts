import type pg from 'pg';
import { query, type Db } from '../../db/pool.js';
import { creerReception, type LigneReception } from '../stock/service.js';
import { tracer } from '../../core/audit.js';
import {
  lireClasseur, versDate, versNombre, genererModele,
  type ColonneImport, type ResultatLigne,
} from './excel.js';

export const COLONNES_RECEPTION: ColonneImport[] = [
  { cle: 'code_sku', libelle: 'Code article (MP ou AC)', obligatoire: true, largeur: 16 },
  { cle: 'quantite_kg', libelle: 'Quantite recue en kilogrammes (matiere premiere)', format: 'nombre', largeur: 16 },
  { cle: 'quantite_unites', libelle: "Nombre d'unites recues (article de conditionnement)", format: 'nombre', largeur: 16 },
  { cle: 'lot_fournisseur', libelle: 'Numero de lot fournisseur', obligatoire: true, largeur: 18 },
  { cle: 'dluo', libelle: 'DLUO ou peremption (JJ/MM/AAAA)', format: 'date', largeur: 16 },
  { cle: 'prix_achat_unitaire', libelle: 'Prix achat HT par kg (MP) ou par unite (AC)', obligatoire: true, format: 'nombre', largeur: 18 },
  { cle: 'frais_approche_unitaire', libelle: "Frais d'approche par kg (MP) ou par unite (AC)", format: 'nombre', largeur: 18 },
  { cle: 'emplacement', libelle: 'Emplacement', largeur: 16 },
  { cle: 'statut', libelle: 'Statut a l entree (quarantaine par defaut)', liste: ['quarantaine', 'conforme'], largeur: 16 },
];

const LIBELLES = Object.fromEntries(COLONNES_RECEPTION.map((c) => [c.cle, c.libelle.split(' (')[0]]));

export const modeleReception = () =>
  genererModele(
    'Reception',
    COLONNES_RECEPTION,
    [
      { code_sku: 'MP-EAU-001', quantite_kg: 500, lot_fournisseur: 'EAU-2026-118', dluo: new Date(Date.UTC(2028, 5, 30)), prix_achat_unitaire: 35, frais_approche_unitaire: 2, emplacement: 'Magasin A', statut: 'quarantaine' },
      { code_sku: 'AC-FLA-050', quantite_unites: 2000, lot_fournisseur: 'FL50-B', prix_achat_unitaire: 62, statut: 'conforme' },
    ],
    [
      "Une ligne par lot recu. Le fournisseur, la date et la reference du bon de livraison se renseignent dans l'ecran d'import.",
      "Le code doit designer une matiere premiere ou un article de conditionnement existant et disponible.",
      "Matiere premiere : quantite en kilogrammes (colonne quantite_kg) et prix par kg. Article de conditionnement : nombre d'unites (colonne quantite_unites) et prix par unite.",
      "Une matiere premiere geree en g, L ou ml est convertie a l'import (les volumes avec la masse volumique de sa fiche article).",
      "Le certificat de conformite est facultatif : il se joint ensuite depuis la fiche de chaque lot.",
      'Les decimales peuvent etre saisies avec une virgule (12,5) et les dates au format JJ/MM/AAAA.',
    ],
  );

const arrondi = (v: number, decimales: number) => Number(v.toFixed(decimales));

/** Quantite dans l'unite de gestion de l'article pour 1 kg recu (null : conversion impossible). */
export function facteurDepuisKg(unite: string, densite: string | number | null): number | null {
  if (unite === 'kg') return 1;
  if (unite === 'g') return 1000;
  const rho = densite === null ? NaN : Number(densite);          // kg par litre
  if (!(rho > 0)) return null;
  if (unite === 'L') return 1 / rho;
  if (unite === 'ml') return 1000 / rho;
  return null;
}

export async function analyserReception(db: Db, contenu: Buffer) {
  const lu = await lireClasseur(contenu, COLONNES_RECEPTION);
  const articles = new Map(
    (await query(db, 'SELECT id, UPPER(code_sku) AS code, type, actif, unite, densite, designation FROM articles_catalogue'))
      .map((a) => [a.code as string, a]),
  );
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const vus = new Map<string, number>();
  const lignes: ResultatLigne<LigneReception & { code_sku: string; designation: string; unite: string; quantite_kg: number | null }>[] = [];
  // Fichier rempli sur le premier modele, ou la quantite etait dans l'unite de l'article.
  const ancienModele = lu.colonnes_inconnues.includes('quantite');

  for (const { numero, valeurs } of lu.lignes) {
    const erreurs: string[] = [];
    for (const c of COLONNES_RECEPTION.filter((c) => c.obligatoire)) {
      if (!valeurs[c.cle]) erreurs.push(`${LIBELLES[c.cle]} : champ obligatoire vide.`);
    }
    const code = valeurs.code_sku?.trim().toUpperCase() ?? '';
    const article = code ? articles.get(code) : undefined;
    if (code && !article) erreurs.push(`Article ${code} inconnu du referentiel.`);
    if (article?.type === 'PF') erreurs.push(`${code} est un produit fini : il entre en stock par conditionnement, pas par reception.`);
    if (article && article.actif === false) erreurs.push(`Article ${code} indisponible.`);

    if (ancienModele) {
      erreurs.push("Ancien modele : la colonne « quantite » est remplacee par « quantite_kg » (matieres premieres) et « quantite_unites » (articles de conditionnement). Retelecharger le modele.");
    }
    const kg = versNombre(valeurs.quantite_kg ?? null);
    const unites = versNombre(valeurs.quantite_unites ?? null);
    if (kg === 'invalide') erreurs.push(`Quantite (kg) : « ${valeurs.quantite_kg} » n'est pas un nombre.`);
    if (unites === 'invalide') erreurs.push(`Quantite (unites) : « ${valeurs.quantite_unites} » n'est pas un nombre.`);

    // Quantite saisie (kg ou unites) et facteur vers l'unite de gestion de l'article.
    let saisie: number | null = null;
    let facteur = 1;
    if (article && !ancienModele && kg !== 'invalide' && unites !== 'invalide') {
      if (article.type === 'MP') {
        if (kg === null) {
          erreurs.push(unites !== null
            ? `${code} est une matiere premiere : saisir la quantite en kilogrammes (colonne quantite_kg).`
            : 'Quantite (kg) : champ obligatoire vide.');
        } else if (unites !== null) {
          erreurs.push('Renseigner soit quantite_kg, soit quantite_unites, pas les deux.');
        } else {
          const f = facteurDepuisKg(article.unite, article.densite);
          if (f === null) {
            erreurs.push(`${code} est gere en ${article.unite} sans masse volumique sur sa fiche : la renseigner pour convertir les kilogrammes.`);
          } else { saisie = kg; facteur = f; }
        }
      } else if (article.type === 'AC') {
        if (unites === null) {
          erreurs.push(kg !== null
            ? `${code} est un article de conditionnement : saisir un nombre d'unites (colonne quantite_unites), pas des kilogrammes.`
            : "Quantite (unites) : champ obligatoire vide.");
        } else if (kg !== null) {
          erreurs.push('Renseigner soit quantite_kg, soit quantite_unites, pas les deux.');
        } else if (!Number.isInteger(unites)) {
          erreurs.push(`Quantite (unites) : ${valeurs.quantite_unites} n'est pas un nombre entier.`);
        } else saisie = unites;
      }
    }
    if (saisie !== null && saisie <= 0) { erreurs.push('Quantite : doit etre strictement positive.'); saisie = null; }
    const quantite = saisie === null ? null : arrondi(saisie * facteur, 3);
    if (quantite !== null && quantite <= 0) erreurs.push(`Quantite : trop faible une fois convertie en ${article!.unite}.`);

    const prix = versNombre(valeurs.prix_achat_unitaire ?? null);
    if (prix === 'invalide') erreurs.push(`Prix achat : « ${valeurs.prix_achat_unitaire} » n'est pas un nombre.`);
    else if (prix !== null && prix < 0) erreurs.push('Prix achat : ne peut pas etre negatif.');

    const frais = versNombre(valeurs.frais_approche_unitaire ?? null);
    if (frais === 'invalide') erreurs.push(`Frais d'approche : « ${valeurs.frais_approche_unitaire} » n'est pas un nombre.`);
    else if (frais !== null && frais < 0) erreurs.push("Frais d'approche : ne peuvent pas etre negatifs.");

    const dluo = versDate(valeurs.dluo ?? null);
    if (dluo === 'invalide') erreurs.push(`DLUO : « ${valeurs.dluo} » n'est pas une date (JJ/MM/AAAA attendu).`);
    else if (dluo && dluo < aujourdhui) erreurs.push(`DLUO : le ${dluo.split('-').reverse().join('/')} est deja depassee.`);

    const statutBrut = valeurs.statut?.trim().toLowerCase() ?? 'quarantaine';
    if (!['quarantaine', 'conforme'].includes(statutBrut)) erreurs.push(`Statut : « ${valeurs.statut} » (quarantaine ou conforme attendu).`);

    const lot = valeurs.lot_fournisseur?.trim();
    if (code && lot) {
      const cle = `${code}|${lot.toUpperCase()}`;
      const premiere = vus.get(cle);
      if (premiere !== undefined) erreurs.push(`Lot ${lot} de ${code} en double dans le fichier (deja ligne ${premiere}).`);
      else vus.set(cle, numero);
    }

    lignes.push({
      numero,
      valeurs,
      erreurs,
      donnees: erreurs.length ? null : {
        article_id: article!.id,
        code_sku: code,
        designation: article!.designation,
        unite: article!.unite,
        quantite_kg: article!.type === 'MP' ? (kg as number) : null,
        quantite: quantite as number,
        code_lot_fournisseur: lot!,
        dluo: (dluo as string | null) ?? null,
        // Prix saisis au kg : ramenes a l'unite de gestion de l'article.
        prix_achat_unitaire: arrondi((prix as number) / facteur, 4),
        frais_approche_unitaire: arrondi(((frais as number | null) ?? 0) / facteur, 4),
        emplacement: valeurs.emplacement ?? null,
        statut: statutBrut === 'conforme' ? 'CONFORME' : 'QUARANTAINE',
      },
    });
  }

  return {
    lignes,
    colonnes_inconnues: lu.colonnes_inconnues,
    colonnes_manquantes: lu.colonnes_manquantes,
    resume: {
      total: lignes.length,
      valides: lignes.filter((l) => !l.erreurs.length).length,
      rejetees: lignes.filter((l) => l.erreurs.length).length,
    },
  };
}

/**
 * Reception par import : les lignes valides forment un seul document de
 * reception (lots internes, mouvements d'entree, PAMP) ; les autres sont
 * rejetees avec leur motif.
 */
export async function importerReception(
  client: pg.PoolClient,
  utilisateurId: number,
  contenu: Buffer,
  nomFichier: string,
  entete: { fournisseur_id?: number | null; date_reception?: string; reference_bl_fournisseur?: string | null; commentaire?: string | null },
) {
  const analyse = await analyserReception(client, contenu);
  const valides = analyse.lignes.filter((l) => l.donnees);
  const rejets = analyse.lignes.filter((l) => l.erreurs.length).map((l) => ({
    ligne: l.numero, code: l.valeurs.code_sku ?? null, motifs: l.erreurs,
  }));

  let reception = null;
  let lots: unknown[] = [];
  if (valides.length) {
    const resultat = await creerReception(
      client, utilisateurId,
      { ...entete, commentaire: entete.commentaire ?? `Import Excel : ${nomFichier}` },
      valides.map((l) => {
        const { code_sku: _c, designation: _d, unite: _u, quantite_kg: _k, ...ligne } = l.donnees!;
        return ligne;
      }),
    );
    reception = resultat.reception;
    lots = resultat.lots;
  }
  const compteRendu = { fichier: nomFichier, total: analyse.lignes.length, importees: valides.length, rejetees: rejets.length };
  await tracer(client, utilisateurId, 'IMPORT_RECEPTION', 'receptions', reception?.id ?? null, { ...compteRendu, rejets });
  return { ...compteRendu, reception, lots, rejets };
}
