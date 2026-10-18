import ExcelJS from 'exceljs';

/** Description d'une colonne d'un modele d'import. */
export interface ColonneImport {
  cle: string;              // nom technique, ecrit en ligne d'en-tete
  libelle: string;          // explication affichee dans la ligne d'aide
  obligatoire?: boolean;
  liste?: string[];         // valeurs autorisees (liste deroulante dans Excel)
  largeur?: number;
  format?: 'texte' | 'nombre' | 'date';
}

const TEINTE = 'FF0F766E';

/**
 * Genere un modele Excel : ligne 1 = en-tetes techniques (lus a l'import),
 * ligne 2 = aide en clair, lignes suivantes = exemples a remplacer. Les listes
 * de valeurs sont proposees en menu deroulant sur 1000 lignes.
 */
export async function genererModele(
  titreFeuille: string,
  colonnes: ColonneImport[],
  exemples: Record<string, unknown>[],
  notes: string[] = [],
): Promise<Buffer> {
  const classeur = new ExcelJS.Workbook();
  classeur.creator = 'ERP dermo-cosmetique';
  const feuille = classeur.addWorksheet(titreFeuille, { views: [{ state: 'frozen', ySplit: 2 }] });

  feuille.columns = colonnes.map((c) => ({ key: c.cle, width: c.largeur ?? Math.max(14, c.cle.length + 4) }));

  const entete = feuille.getRow(1);
  colonnes.forEach((c, i) => { entete.getCell(i + 1).value = c.cle; });
  entete.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  entete.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEINTE } };

  const aide = feuille.getRow(2);
  colonnes.forEach((c, i) => {
    aide.getCell(i + 1).value = `${c.libelle}${c.obligatoire ? ' (obligatoire)' : ''}${c.liste ? ` — ${c.liste.join(' / ')}` : ''}`;
  });
  aide.font = { italic: true, color: { argb: 'FF475569' }, size: 9 };
  aide.alignment = { wrapText: true, vertical: 'top' };
  aide.height = 42;

  for (const exemple of exemples) {
    feuille.addRow(colonnes.map((c) => exemple[c.cle] ?? null));
  }

  colonnes.forEach((c, i) => {
    const lettre = feuille.getColumn(i + 1).letter;
    if (c.liste) {
      for (let ligne = 3; ligne <= 1000; ligne++) {
        feuille.getCell(`${lettre}${ligne}`).dataValidation = {
          type: 'list', allowBlank: !c.obligatoire, formulae: [`"${c.liste.join(',')}"`],
          showErrorMessage: true, errorTitle: 'Valeur non autorisee', error: `Valeurs possibles : ${c.liste.join(', ')}`,
        };
      }
    }
    if (c.format === 'date') feuille.getColumn(i + 1).numFmt = 'dd/mm/yyyy';
  });

  if (notes.length) {
    const consignes = classeur.addWorksheet('Consignes');
    consignes.getColumn(1).width = 110;
    consignes.addRow(['Consignes de remplissage']).font = { bold: true, size: 13, color: { argb: TEINTE } };
    consignes.addRow([]);
    notes.forEach((n) => consignes.addRow([`• ${n}`]));
  }

  return Buffer.from(await classeur.xlsx.writeBuffer());
}

export interface LigneLue {
  numero: number;                              // numero de ligne dans le classeur
  valeurs: Record<string, string | null>;      // valeurs brutes normalisees en texte
}

const texteCellule = (valeur: ExcelJS.CellValue): string | null => {
  if (valeur === null || valeur === undefined) return null;
  if (valeur instanceof Date) {
    // Les dates Excel sont stockees en UTC minuit : on conserve le jour saisi.
    const a = valeur.getUTCFullYear();
    const m = String(valeur.getUTCMonth() + 1).padStart(2, '0');
    const j = String(valeur.getUTCDate()).padStart(2, '0');
    return `${a}-${m}-${j}`;
  }
  if (typeof valeur === 'object') {
    if ('result' in valeur) return texteCellule(valeur.result as ExcelJS.CellValue);   // formule
    if ('richText' in valeur) return valeur.richText.map((r) => r.text).join('');
    if ('text' in valeur) return String(valeur.text);                                  // lien
    return null;
  }
  const texte = String(valeur).trim();
  return texte === '' ? null : texte;
};

/**
 * Lit la premiere feuille d'un classeur. La ligne 1 donne les en-tetes ; la
 * ligne d'aide du modele (ligne 2 reconnue a ses libelles) et les lignes vides
 * sont ignorees.
 */
export async function lireClasseur(contenu: Buffer, colonnes: ColonneImport[]): Promise<{
  lignes: LigneLue[];
  colonnes_inconnues: string[];
  colonnes_manquantes: string[];
}> {
  const classeur = new ExcelJS.Workbook();
  try {
    await classeur.xlsx.load(contenu as unknown as ArrayBuffer);
  } catch {
    throw new Error('Fichier illisible : un classeur Excel (.xlsx) est attendu.');
  }
  const feuille = classeur.worksheets[0];
  if (!feuille) throw new Error('Le classeur ne contient aucune feuille.');

  const entetes: (string | null)[] = [];
  feuille.getRow(1).eachCell({ includeEmpty: true }, (cellule, i) => {
    entetes[i] = texteCellule(cellule.value)?.toLowerCase().trim() ?? null;
  });
  const connues = new Set(colonnes.map((c) => c.cle));
  const presentes = entetes.filter((e): e is string => !!e);
  const colonnes_inconnues = presentes.filter((e) => !connues.has(e));
  const colonnes_manquantes = colonnes.filter((c) => c.obligatoire && !presentes.includes(c.cle)).map((c) => c.cle);

  const lignes: LigneLue[] = [];
  const aide = colonnes.map((c) => c.libelle.toLowerCase());
  feuille.eachRow({ includeEmpty: false }, (ligne, numero) => {
    if (numero === 1) return;
    const valeurs: Record<string, string | null> = {};
    let renseignee = false;
    entetes.forEach((cle, i) => {
      if (!cle || !connues.has(cle)) return;
      const v = texteCellule(ligne.getCell(i).value);
      valeurs[cle] = v;
      if (v !== null) renseignee = true;
    });
    if (!renseignee) return;
    // Ligne d'aide du modele : ses cellules reprennent les libelles des colonnes.
    const premiere = Object.values(valeurs).find((v) => v !== null)?.toLowerCase() ?? '';
    if (numero === 2 && aide.some((a) => premiere.startsWith(a))) return;
    lignes.push({ numero, valeurs });
  });
  return { lignes, colonnes_inconnues, colonnes_manquantes };
}

// ---------------------------------------------------------------------------
// Conversions tolerantes aux habitudes de saisie (virgule decimale, JJ/MM/AAAA)
// ---------------------------------------------------------------------------

export function versNombre(v: string | null): number | null | 'invalide' {
  if (v === null) return null;
  const nettoye = v.replace(/\s/g, '').replace(/ /g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(nettoye)) return 'invalide';
  return Number(nettoye);
}

export function versDate(v: string | null): string | null | 'invalide' {
  if (v === null) return null;
  let a: number, m: number, j: number;
  let r = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (r) { a = +r[1]; m = +r[2]; j = +r[3]; }
  else if ((r = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) { j = +r[1]; m = +r[2]; a = +r[3]; }
  else return 'invalide';
  const date = new Date(Date.UTC(a, m - 1, j));
  if (date.getUTCFullYear() !== a || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== j) return 'invalide';
  return `${a}-${String(m).padStart(2, '0')}-${String(j).padStart(2, '0')}`;
}

export function versOuiNon(v: string | null): boolean | null | 'invalide' {
  if (v === null) return null;
  const t = v.toLowerCase().trim();
  if (['oui', 'o', 'yes', 'y', '1', 'vrai', 'true', 'x'].includes(t)) return true;
  if (['non', 'n', 'no', '0', 'faux', 'false'].includes(t)) return false;
  return 'invalide';
}

export interface ResultatLigne<T> {
  numero: number;
  donnees: T | null;
  valeurs: Record<string, string | null>;
  erreurs: string[];
}
