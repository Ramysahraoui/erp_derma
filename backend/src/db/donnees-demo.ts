import type pg from 'pg';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { queryOne } from './pool.js';
import { env } from '../env.js';
import { hacher } from '../core/auth.js';
import { amorcer } from './amorcage.js';
import { creerReception, type LigneReception } from '../modules/stock/service.js';
import { remplacerLignes } from '../modules/formules/service.js';


/**
 * Genere un certificat d'analyse de demonstration (PDF minimal valide) pour
 * accompagner les lots du jeu de donnees : sans CoA, un lot ne peut pas etre
 * declare conforme.
 */
function ecrireCertificat(codeLotFournisseur: string, designation: string): string {
  const echappe = (t: string) => t.replace(/[\\()]/g, '\\$&');
  const lignes = [
    `Fournisseur : lot ${codeLotFournisseur}`,
    `Produit : ${designation}`,
    'Aspect : conforme a la specification',
    'Identification (IR) : conforme',
    'Teneur en eau : conforme',
    'Controle microbiologique : conforme',
    '',
    'Document de demonstration genere par le systeme.',
  ];
  const contenu = [
    `BT /F1 16 Tf 60 780 Td (${echappe("CERTIFICAT D'ANALYSE")}) Tj ET`,
    ...lignes.map((l, i) => `BT /F1 11 Tf 60 ${740 - i * 18} Td (${echappe(l)}) Tj ET`),
  ].join('\n');
  const objets = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(contenu, 'latin1')} >>\nstream\n${contenu}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const decalages: number[] = [];
  objets.forEach((objet, i) => {
    decalages.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${objet}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n`;
  for (const decalage of decalages) pdf += `${String(decalage).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const nom = `coa-${codeLotFournisseur.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`;
  mkdirSync(env.uploadDir, { recursive: true });
  writeFileSync(path.join(env.uploadDir, nom), Buffer.from(pdf, 'latin1'));
  return nom;
}

/** Complete chaque ligne de reception par son certificat d'analyse. */
function avecCertificats(lignes: LigneReception[], designations: Map<number, string>): LigneReception[] {
  return lignes.map((l) => ({
    ...l,
    coa_fichier: ecrireCertificat(l.code_lot_fournisseur ?? 'lot', designations.get(l.article_id) ?? 'Matiere'),
  }));
}

const dansNJours = (n: number) => {
  const date = new Date();
  date.setDate(date.getDate() + n);
  return date.toISOString().slice(0, 10);
};

/**
 * Jeu de donnees de DEMONSTRATION — a n'utiliser qu'en formation ou en recette.
 *
 * Il injecte des articles, formules, lots, clients et comptes fictifs. Une
 * installation de production s'amorce avec `amorcer()` (parametres, plan
 * analytique, compte administrateur) et reste vierge de toute donnee simulee.
 */
export async function semerDemonstration(client: pg.PoolClient, log: (m: string) => void = console.log): Promise<void> {
  const existant = await queryOne<{ n: number }>(client, 'SELECT COUNT(*)::int AS n FROM utilisateurs');
  if (existant && existant.n > 0) {
    log('[demonstration] base deja peuplee, aucune action.');
    return;
  }

  await amorcer(client, {}, () => {});

  // ------------------------------ Utilisateurs ------------------------
  const utilisateurs = [
    ['direction@derma.dz', 'Direction Generale', 'ADMIN'],
    ['qualite@derma.dz', 'Responsable R&D / Qualite', 'RESPONSABLE_RD_QUALITE'],
    ['atelier@derma.dz', 'Operateur Formulation', 'OPERATEUR_PRODUCTION'],
    ['commercial@derma.dz', 'Service Commercial', 'COMMERCIAL'],
    ['comptabilite@derma.dz', 'Comptabilite / Recouvrement', 'COMPTABILITE'],
  ] as const;
  const motDePasse = await hacher('Derma2026!');
  let adminId = 0;
  await client.query('DELETE FROM utilisateurs');
  for (const [email, nom, role] of utilisateurs) {
    const u = await queryOne(
      client,
      `INSERT INTO utilisateurs (email, mot_de_passe, nom_complet, role, doit_changer_mot_de_passe)
       VALUES ($1,$2,$3,$4,FALSE) RETURNING id`,
      [email, motDePasse, nom, role],
    );
    if (role === 'ADMIN') adminId = u!.id;
  }
  log('[demonstration] 5 utilisateurs crees (mot de passe : Derma2026!)');

  // ------------------------------ Fournisseurs ------------------------
  const fournisseurs: Record<string, number> = {};
  for (const [code, raison] of [
    ['FRN-CHIM', 'Chimie & Actifs Cosmetiques SARL'],
    ['FRN-PACK', 'Packaging Industriel Mediterranee'],
    ['FRN-ACTF', 'Ingredients Naturels Import'],
  ]) {
    const f = await queryOne(
      client, 'INSERT INTO fournisseurs (code, raison_sociale) VALUES ($1,$2) RETURNING id', [code, raison],
    );
    fournisseurs[code] = f!.id;
  }

  // -------------------------------- Articles --------------------------
  const art: Record<string, number> = {};
  const designations = new Map<number, string>();
  const creerArticle = async (
    sku: string, designation: string, type: 'MP' | 'AC' | 'PF', unite: string,
    extra: { inci?: string; seuil?: number; prix?: number; contenance?: number; densite?: number } = {},
  ) => {
    const a = await queryOne(
      client,
      `INSERT INTO articles_catalogue (code_sku, designation, type, unite, nom_inci, seuil_critique, prix_vente_ht, contenance_ml, densite)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [sku, designation, type, unite, extra.inci ?? null, extra.seuil ?? 0, extra.prix ?? 0,
       extra.contenance ?? null, extra.densite ?? null],
    );
    art[sku] = a!.id;
    designations.set(a!.id, designation);
  };

  await creerArticle('MP-EAU-001', 'Eau purifiee osmosee', 'MP', 'kg', { inci: 'Aqua', seuil: 200, densite: 1 });
  await creerArticle('MP-GLY-002', 'Glycerine vegetale', 'MP', 'kg', { inci: 'Glycerin', seuil: 50, densite: 1.26 });
  await creerArticle('MP-HUJ-003', 'Huile de jojoba', 'MP', 'L', { inci: 'Simmondsia Chinensis Seed Oil', seuil: 20, densite: 0.87 });
  await creerArticle('MP-BKA-004', 'Beurre de karite raffine', 'MP', 'kg', { inci: 'Butyrospermum Parkii Butter', seuil: 15 });
  await creerArticle('MP-EMU-005', 'Emulsifiant cire n°3', 'MP', 'kg', { inci: 'Cetearyl Alcohol', seuil: 10 });
  await creerArticle('MP-ACH-006', 'Acide hyaluronique 1%', 'MP', 'kg', { inci: 'Sodium Hyaluronate', seuil: 3 });
  await creerArticle('MP-VTE-007', 'Vitamine E', 'MP', 'kg', { inci: 'Tocopherol', seuil: 2 });
  await creerArticle('MP-CON-008', 'Conservateur cosmetique', 'MP', 'kg', { inci: 'Phenoxyethanol', seuil: 5 });
  await creerArticle('MP-PAR-009', 'Parfum hypoallergenique', 'MP', 'kg', { inci: 'Parfum', seuil: 2 });
  await creerArticle('MP-GOM-010', 'Gomme xanthane', 'MP', 'kg', { inci: 'Xanthan Gum', seuil: 5 });
  await creerArticle('MP-ACL-011', 'Acide lactique (pH)', 'MP', 'kg', { inci: 'Lactic Acid', seuil: 2 });
  await creerArticle('MP-ALO-012', 'Aloe vera concentre', 'MP', 'kg', { inci: 'Aloe Barbadensis Leaf Juice', seuil: 10 });

  await creerArticle('AC-FLA-050', 'Flacon airless 50 ml blanc', 'AC', 'U', { seuil: 500 });
  await creerArticle('AC-POM-050', 'Pompe doseuse 50 ml', 'AC', 'U', { seuil: 500 });
  await creerArticle('AC-ETI-050', 'Etiquette adhesive 50 ml', 'AC', 'U', { seuil: 1000 });
  await creerArticle('AC-ETU-050', 'Etui carton 50 ml', 'AC', 'U', { seuil: 500 });
  await creerArticle('AC-POT-100', 'Pot verre 100 ml', 'AC', 'U', { seuil: 300 });
  await creerArticle('AC-OPE-100', 'Opercule aluminium 100 ml', 'AC', 'U', { seuil: 300 });
  await creerArticle('AC-CAR-EXP', "Carton d'expedition 12 unites", 'AC', 'U', { seuil: 100 });

  await creerArticle('PF-CRH-050', 'Creme hydratante visage 50 ml', 'PF', 'U', { prix: 1850, contenance: 50, seuil: 100 });
  await creerArticle('PF-SER-050', 'Serum acide hyaluronique 50 ml', 'PF', 'U', { prix: 3200, contenance: 50, seuil: 60 });
  await creerArticle('PF-BAU-100', 'Baume reparateur 100 ml', 'PF', 'U', { prix: 2400, contenance: 100, seuil: 50 });
  log('[demonstration] 22 articles crees (12 MP, 7 AC, 3 PF)');

  // --------------------------- Nomenclatures AC -----------------------
  const nomenclature: [string, [string, number][]][] = [
    ['PF-CRH-050', [['AC-FLA-050', 1], ['AC-POM-050', 1], ['AC-ETI-050', 1], ['AC-ETU-050', 1]]],
    ['PF-SER-050', [['AC-FLA-050', 1], ['AC-POM-050', 1], ['AC-ETI-050', 1]]],
    ['PF-BAU-100', [['AC-POT-100', 1], ['AC-OPE-100', 1], ['AC-ETI-050', 1]]],
  ];
  for (const [pf, composants] of nomenclature) {
    for (const [ac, qte] of composants) {
      await client.query(
        'INSERT INTO nomenclature_ac (article_pf_id, article_ac_id, qte_par_unite) VALUES ($1,$2,$3)',
        [art[pf], art[ac], qte],
      );
    }
  }

  // ------------------------------- Formules ---------------------------
  const formules: {
    code: string; nom: string; densite: number; pf: string; ph: [number, number];
    visco: [number, number]; lignes: [string, 'A' | 'B' | 'C' | 'D' | 'E', number, string][];
  }[] = [
    {
      code: 'FOR-CRH-01', nom: 'Creme hydratante visage', densite: 0.98, pf: 'PF-CRH-050',
      ph: [5.2, 5.6], visco: [12000, 22000],
      lignes: [
        ['MP-EAU-001', 'A', 68.5, 'Chauffer a 75 °C sous agitation lente'],
        ['MP-GLY-002', 'A', 5, 'Incorporer a la phase aqueuse'],
        ['MP-GOM-010', 'A', 0.5, 'Disperser lentement pour eviter les grumeaux'],
        ['MP-HUJ-003', 'B', 8, 'Chauffer la phase huileuse a 75 °C'],
        ['MP-BKA-004', 'B', 6, 'Fondre completement avant emulsion'],
        ['MP-EMU-005', 'B', 5, 'Agent emulsifiant'],
        ['MP-ALO-012', 'C', 4, 'Emulsion : defloculeuse 1500 RPM a 75 °C pendant 10 min'],
        ['MP-VTE-007', 'D', 0.5, 'Ajouter sous 40 °C (thermosensible)'],
        ['MP-CON-008', 'D', 1, 'Conservateur, ajout a 35 °C'],
        ['MP-PAR-009', 'D', 1.3, 'Parfum a 30 °C, agitation douce'],
        ['MP-ACL-011', 'E', 0.2, 'Ajustement du pH a 5,40 ± 0,20'],
      ],
    },
    {
      code: 'FOR-SER-01', nom: 'Serum acide hyaluronique', densite: 1.01, pf: 'PF-SER-050',
      ph: [5, 5.5], visco: [2000, 6000],
      lignes: [
        ['MP-EAU-001', 'A', 82.2, 'Eau purifiee, temperature ambiante'],
        ['MP-GLY-002', 'A', 8, 'Humectant'],
        ['MP-GOM-010', 'A', 0.3, 'Epaississant, dispersion lente'],
        ['MP-ACH-006', 'C', 5, "Incorporer l'actif sous agitation 800 RPM"],
        ['MP-ALO-012', 'C', 2, 'Actif apaisant'],
        ['MP-CON-008', 'D', 1, 'Conservateur'],
        ['MP-VTE-007', 'D', 1.3, 'Antioxydant'],
        ['MP-ACL-011', 'E', 0.2, 'Ajustement du pH a 5,20'],
      ],
    },
    {
      code: 'FOR-BAU-01', nom: 'Baume reparateur', densite: 0.94, pf: 'PF-BAU-100',
      ph: [5.5, 6.5], visco: [30000, 60000],
      lignes: [
        ['MP-EAU-001', 'A', 45.5, 'Phase aqueuse chauffee a 78 °C'],
        ['MP-GLY-002', 'A', 6, 'Humectant'],
        ['MP-BKA-004', 'B', 22, 'Corps gras principal, fusion a 78 °C'],
        ['MP-HUJ-003', 'B', 14, 'Huile vegetale'],
        ['MP-EMU-005', 'B', 8, 'Emulsifiant'],
        ['MP-ALO-012', 'C', 2, 'Emulsion a 1200 RPM'],
        ['MP-VTE-007', 'D', 0.8, 'Antioxydant a 40 °C'],
        ['MP-CON-008', 'D', 1, 'Conservateur'],
        ['MP-PAR-009', 'D', 0.7, 'Parfum'],
      ],
    },
  ];

  for (const f of formules) {
    const formule = await queryOne(
      client,
      `INSERT INTO formules (code_formule, nom_produit, densite, article_pf_id, statut, ph_min, ph_max,
                             viscosite_min, viscosite_max, perte_process_pct, cree_par)
       VALUES ($1,$2,$3,$4,'VALIDEE',$5,$6,$7,$8,1.5,$9) RETURNING id`,
      [f.code, f.nom, f.densite, art[f.pf], f.ph[0], f.ph[1], f.visco[0], f.visco[1], adminId],
    );
    await remplacerLignes(
      client,
      formule!.id,
      f.lignes.map(([sku, phase, pct, consigne], i) => ({
        article_id: art[sku], phase, pourcentage_w_w: pct, consigne, ordre: i,
      })),
    );
  }
  log('[demonstration] 3 formules validees (somme ponderale = 100,000 %)');

  // ------------------------- Receptions et stock ----------------------
  await creerReception(
    client, adminId,
    { fournisseur_id: fournisseurs['FRN-CHIM'], reference_bl_fournisseur: 'BL-2026-1187', commentaire: 'Approvisionnement initial matieres premieres' },
    avecCertificats([
      { article_id: art['MP-EAU-001'], quantite: 1500, code_lot_fournisseur: 'EAU-A1', dluo: dansNJours(720), prix_achat_unitaire: 35, frais_approche_unitaire: 2, statut: 'CONFORME' },
      { article_id: art['MP-GLY-002'], quantite: 300, code_lot_fournisseur: 'GLY-7741', dluo: dansNJours(540), prix_achat_unitaire: 420, frais_approche_unitaire: 18, statut: 'CONFORME' },
      { article_id: art['MP-HUJ-003'], quantite: 120, code_lot_fournisseur: 'JOJ-2291', dluo: dansNJours(365), prix_achat_unitaire: 2600, frais_approche_unitaire: 120, statut: 'CONFORME' },
      { article_id: art['MP-BKA-004'], quantite: 90, code_lot_fournisseur: 'KAR-5512', dluo: dansNJours(400), prix_achat_unitaire: 1450, frais_approche_unitaire: 60, statut: 'CONFORME' },
      { article_id: art['MP-EMU-005'], quantite: 60, code_lot_fournisseur: 'EMU-3390', dluo: dansNJours(600), prix_achat_unitaire: 1900, statut: 'CONFORME' },
      { article_id: art['MP-GOM-010'], quantite: 25, code_lot_fournisseur: 'XAN-8820', dluo: dansNJours(500), prix_achat_unitaire: 2100, statut: 'CONFORME' },
      { article_id: art['MP-ACL-011'], quantite: 15, code_lot_fournisseur: 'LAC-1120', dluo: dansNJours(700), prix_achat_unitaire: 980, statut: 'CONFORME' },
      { article_id: art['MP-ALO-012'], quantite: 80, code_lot_fournisseur: 'ALO-4417', dluo: dansNJours(300), prix_achat_unitaire: 1150, statut: 'CONFORME' },
    ], designations),
  );

  await creerReception(
    client, adminId,
    { fournisseur_id: fournisseurs['FRN-ACTF'], reference_bl_fournisseur: 'BL-ACT-0921', commentaire: 'Actifs sensibles — quarantaine jusqu a analyse' },
    avecCertificats([
      { article_id: art['MP-ACH-006'], quantite: 12, code_lot_fournisseur: 'HYA-9031', dluo: dansNJours(240), prix_achat_unitaire: 18500, frais_approche_unitaire: 900, statut: 'CONFORME' },
      { article_id: art['MP-VTE-007'], quantite: 8, code_lot_fournisseur: 'TOC-6612', dluo: dansNJours(330), prix_achat_unitaire: 7400, statut: 'CONFORME' },
      { article_id: art['MP-CON-008'], quantite: 20, code_lot_fournisseur: 'PHE-2203', dluo: dansNJours(450), prix_achat_unitaire: 3100, statut: 'CONFORME' },
      { article_id: art['MP-PAR-009'], quantite: 10, code_lot_fournisseur: 'PAR-7788', dluo: dansNJours(365), prix_achat_unitaire: 9200, statut: 'CONFORME' },
    ], designations),
  );

  // Reception en attente de certificat d'analyse : lots bloques en quarantaine,
  // donc invisibles de l'atelier tant que la qualite ne les a pas liberes.
  await creerReception(
    client, adminId,
    { fournisseur_id: fournisseurs['FRN-CHIM'], reference_bl_fournisseur: 'BL-2026-1204', commentaire: 'En attente du certificat d analyse fournisseur' },
    ([
      { article_id: art['MP-GLY-002'], quantite: 100, code_lot_fournisseur: 'GLY-7802', dluo: dansNJours(560), prix_achat_unitaire: 435, frais_approche_unitaire: 18, statut: 'QUARANTAINE' },
      { article_id: art['MP-ALO-012'], quantite: 40, code_lot_fournisseur: 'ALO-4498', dluo: dansNJours(320), prix_achat_unitaire: 1180, statut: 'QUARANTAINE' },
    ] as LigneReception[]).map((l) => ({ ...l, coa_absent_motif: 'Certificat d analyse annonce par le fournisseur sous 48 h' })),
  );

  await creerReception(
    client, adminId,
    { fournisseur_id: fournisseurs['FRN-PACK'], reference_bl_fournisseur: 'BL-PCK-4471', commentaire: 'Articles de conditionnement' },
    avecCertificats([
      { article_id: art['AC-FLA-050'], quantite: 6000, code_lot_fournisseur: 'FL50-A', prix_achat_unitaire: 62, frais_approche_unitaire: 4, statut: 'CONFORME' },
      { article_id: art['AC-POM-050'], quantite: 6000, code_lot_fournisseur: 'PMP-77', prix_achat_unitaire: 45, statut: 'CONFORME' },
      { article_id: art['AC-ETI-050'], quantite: 12000, code_lot_fournisseur: 'ETQ-2026-1', prix_achat_unitaire: 8, statut: 'CONFORME' },
      { article_id: art['AC-ETU-050'], quantite: 5000, code_lot_fournisseur: 'ETU-115', prix_achat_unitaire: 27, statut: 'CONFORME' },
      { article_id: art['AC-POT-100'], quantite: 2500, code_lot_fournisseur: 'POT-100-B', prix_achat_unitaire: 88, statut: 'CONFORME' },
      { article_id: art['AC-OPE-100'], quantite: 2500, code_lot_fournisseur: 'OPE-441', prix_achat_unitaire: 6, statut: 'CONFORME' },
      { article_id: art['AC-CAR-EXP'], quantite: 800, code_lot_fournisseur: 'CAR-12U', prix_achat_unitaire: 95, statut: 'CONFORME' },
    ], designations),
  );
  log('[demonstration] 4 receptions enregistrees, lots internes generes (dont 2 lots en quarantaine)');

  // --------------------------------- Clients --------------------------
  const clients: [string, string, number, number, string][] = [
    ['CLI-PHARMA', 'Pharmacie Centrale El Djazair', 2_500_000, 30, 'Alger centre'],
    ['CLI-PARA', 'Parapharmacie Les Oliviers', 800_000, 30, 'Oran'],
    ['CLI-DISTRI', 'Distribution Cosmetique Est', 5_000_000, 60, 'Constantine'],
    ['CLI-INSTI', 'Institut de beaute Nour', 150_000, 0, 'Blida'],
  ];
  for (const [code, raison, plafond, delai, adresse] of clients) {
    await client.query(
      `INSERT INTO clients (code, raison_sociale, plafond_credit, delai_paiement_jours, adresse_facturation, adresse_livraison)
       VALUES ($1,$2,$3,$4,$5,$5)`,
      [code, raison, plafond, delai, adresse],
    );
  }

  // --------------------------------- Personnel ------------------------
  const salaries: [string, string, string, string, string, string, number, number][] = [
    ['MAT-001', 'Belkacem', 'Amine', 'Operateur formulation', 'PRODUCTION', 'CDI', 62000, 420],
    ['MAT-002', 'Haddad', 'Sofia', 'Operatrice conditionnement', 'CONDITIONNEMENT', 'CDI', 55000, 380],
    ['MAT-003', 'Zerrouki', 'Karim', 'Technicien qualite', 'QUALITE', 'CDI', 78000, 520],
    ['MAT-004', 'Meziane', 'Lila', 'Commerciale', 'COMMERCIAL', 'CDI', 70000, 470],
  ];
  for (const [matricule, nom, prenom, fonction, departement, contrat, salaire, taux] of salaries) {
    await client.query(
      `INSERT INTO salaries (matricule, nom, prenom, fonction, departement, type_contrat, salaire_base, taux_horaire)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [matricule, nom, prenom, fonction, departement, contrat, salaire, taux],
    );
  }
  log('[demonstration] clients et personnel crees');
  log('[demonstration] Jeu de demonstration pret. Connexion : direction@derma.dz / Derma2026!');
}
