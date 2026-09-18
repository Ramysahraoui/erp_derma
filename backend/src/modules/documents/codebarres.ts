/**
 * Generation d'un code-barres Code 128 (jeu B) au format SVG, destine aux
 * etiquettes de lots lues par douchette USB / Bluetooth en atelier.
 * Aucune dependance externe : le SVG est integre directement aux documents.
 */
const MOTIFS = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112',
];

const DEBUT_B = 104;
const STOP = 106;

/** Transforme une chaine ASCII imprimable en sequence de modules Code 128 B. */
function encoder(valeur: string): string {
  const donnees = [...valeur].map((c) => {
    const code = c.charCodeAt(0);
    if (code < 32 || code > 126) throw new Error(`Caractere non encodable en Code 128 B : « ${c} »`);
    return code - 32;
  });
  let somme = DEBUT_B;
  donnees.forEach((v, i) => { somme += v * (i + 1); });
  const sequence = [DEBUT_B, ...donnees, somme % 103, STOP];
  return sequence.map((v) => MOTIFS[v]).join('');
}

export interface OptionsCodeBarres {
  hauteur?: number;
  largeurModule?: number;
  afficherTexte?: boolean;
}

export function codeBarresSvg(valeur: string, options: OptionsCodeBarres = {}): string {
  const hauteur = options.largeurModule ? options.hauteur ?? 40 : options.hauteur ?? 40;
  const module = options.largeurModule ?? 1.6;
  const afficherTexte = options.afficherTexte ?? true;
  const motif = encoder(valeur);

  let x = 10;
  let barres = '';
  let estBarre = true;
  for (const largeur of motif) {
    const l = Number(largeur) * module;
    if (estBarre) barres += `<rect x="${x.toFixed(2)}" y="0" width="${l.toFixed(2)}" height="${hauteur}" fill="#000"/>`;
    x += l;
    estBarre = !estBarre;
  }
  const largeurTotale = x + 10;
  const hauteurTotale = hauteur + (afficherTexte ? 16 : 0);
  const texte = afficherTexte
    ? `<text x="${(largeurTotale / 2).toFixed(2)}" y="${hauteur + 13}" text-anchor="middle" font-family="monospace" font-size="11">${valeur}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${largeurTotale.toFixed(0)}" height="${hauteurTotale}" viewBox="0 0 ${largeurTotale.toFixed(0)} ${hauteurTotale}">${barres}${texte}</svg>`;
}

/** Controle d'integrite de la table des motifs (11 modules par symbole). */
export function verifierTableMotifs(): boolean {
  return MOTIFS.every((m, i) => {
    const total = [...m].reduce((a, c) => a + Number(c), 0);
    return i === STOP ? total === 13 : total === 11;
  });
}
