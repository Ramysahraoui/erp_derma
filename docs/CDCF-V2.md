# Cahier des charges — evolutions V2

Ce document complete `docs/CDCF.md`. Il reprend les exigences de la V2 et les
decisions prises lors de leur mise en oeuvre.

## 1. Exigences

### 1.1 Articles : import Excel et modification tracee

- Import de plusieurs articles a partir d'un modele Excel telechargeable depuis
  l'application.
- Apercu controle avant import : codes en double (dans le fichier ou deja
  presents dans le referentiel), champs obligatoires vides, formats invalides,
  regles propres a la categorie (contenance d'un produit fini, unite d'une
  matiere premiere...).
- Compte rendu apres import : lignes importees, lignes rejetees avec leurs motifs.
- Modification du code, de la disponibilite et du prix de vente d'un article
  existant, avec controle d'unicite du code. L'historique de l'article (lots,
  mouvements, documents de vente, formules) reste rattache apres changement de
  code. Chaque modification est tracee : utilisateur, date, ancienne et nouvelle
  valeur.

### 1.2 Reception par Excel, certificat facultatif

- Import d'une reception (plusieurs lignes) a partir d'un modele Excel, avec le
  meme cycle modele / apercu / controle / compte rendu. L'entete (fournisseur,
  date, bon de livraison) est saisi dans le formulaire.
- Quantites du fichier : en **kilogrammes** pour les matieres premieres
  (colonne `quantite_kg`, prix et frais d'approche au kg), en **nombre
  d'unites** pour les articles de conditionnement (colonne `quantite_unites`).
- Le certificat de conformite (CoA) devient **facultatif** : il peut etre joint
  a la reception ou plus tard, sur la fiche du lot.

### 1.3 Stock : ajustements et lots rejetes

- Augmentation ou reduction de la quantite d'un lot par un mouvement trace
  (date, utilisateur, quantite, motif obligatoire). Une reduction au-dela du
  stock est refusee.
- Un lot rejete peut etre reintroduit (en quarantaine ou directement conforme)
  sur decision motivee. Le rejet et la reintroduction restent visibles dans
  l'historique des statuts du lot.

### 1.4 Encaissements et etat client (anomalie critique)

- Constat : un encaissement saisi sans ventilation explicite sur une facture
  n'apparaissait pas dans l'etat du client et ne reduisait pas son solde.
- Exigence : tout encaissement est impute automatiquement sur le compte du
  client ; l'etat client presente les factures, les encaissements et le solde
  restant du.

## 2. Decisions

| Sujet | Decision |
|---|---|
| Disponibilite d'un article | Indicateur actif / inactif. Un article inactif n'est plus propose a la saisie (receptions, formules, ventes) et ne peut plus etre receptionne ni vendu ; son historique reste consultable. |
| Certificat de conformite | Entierement facultatif : la liberation d'un lot est possible sans certificat. La fiche lot signale a titre informatif un certificat non joint. |
| Unite des quantites a l'import de reception | Kilogrammes pour les matieres premieres, unites pour les articles de conditionnement. Une matiere geree en g est convertie (x 1000), une matiere geree en L ou ml est convertie avec la masse volumique de sa fiche (ligne rejetee si elle n'est pas renseignee) ; le prix au kg est ramene a l'unite de stock. |
| Code deja existant a l'import | La ligne est rejetee (pas de mise a jour implicite d'un article existant). |
| Encaissement non ventile | Imputation automatique sur les factures les plus anciennes (echeance puis date). L'excedent reste en avoir, impute automatiquement sur les factures validees ensuite. |
| Cheque impaye | Les imputations du cheque sont annulees (jamais supprimees), les factures sont rouvertes. Un cheque represente redevient un avoir, re-impute selon la meme regle. |
| Solde client | Solde restant du = factures dues - avoir disponible. Un solde negatif est un credit du client ; un paiement avant facturation augmente d'autant le credit disponible au regard du plafond. |

## 3. Criteres de validation

| Critere | Verification |
|---|---|
| Import de plusieurs articles avec compte rendu des rejets | `backend/tests/v2.test.ts` (critere 1) et parcours navigateur |
| Modification tracee du code, de la disponibilite et du prix | `v2.test.ts` (critere 2) et parcours navigateur |
| Reception par Excel sans certificat | `v2.test.ts` (critere 3) et parcours navigateur |
| Ajustement des quantites, reintroduction d'un lot rejete | `v2.test.ts` (critere 4) et parcours navigateur |
| Encaissement visible dans l'etat client, solde correct | `v2.test.ts` (critere 5) et parcours navigateur |

## 4. Mise a jour d'une installation V1

La migration `003_v2.sql` s'applique seule au demarrage de l'API. Elle :

- supprime l'obligation de certificat a la liberation ;
- cree l'historique des statuts de lots (repris du journal d'audit existant) et
  l'historique des modifications d'articles, tous deux non supprimables ;
- marque comme annulees les imputations des cheques deja impayes et recalcule
  les montants payes des factures.

Au demarrage suivant, les encaissements deja saisis sans ventilation sont
imputes automatiquement sur les factures ouvertes des clients concernes.
