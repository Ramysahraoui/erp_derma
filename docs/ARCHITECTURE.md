# Architecture fonctionnelle et technique

## 1. Principes directeurs

1. **La base de donnees porte les regles non negociables.** Un contournement de
   l'API (script, outil d'administration, connexion directe) se heurte aux memes
   refus que l'interface. Les triggers PL/pgSQL levent des exceptions dont le
   prefixe (`FORMULE_SOMME_INVALIDE:`, `LOT_PF_OBLIGATOIRE:` …) est traduit en
   code d'erreur applicatif par `backend/src/core/erreurs.ts`.
2. **Le stock n'est jamais ecrit directement.** Toute variation passe par une
   ecriture dans `mouvements_stock` ; un trigger repercute la quantite sur le lot
   et refuse tout solde negatif. La quantite d'un lot est donc, par construction,
   le cumul de ses mouvements.
3. **Aucune suppression sur la tracabilite.** Les corrections s'operent par
   ajustement motive ou contre-passation, conformement a l'exigence d'audit trail
   (BPF / ISO 22716).
4. **Le certificat d'analyse conditionne la liberation.** Une reception sans CoA
   exige un motif ecrit et force la quarantaine ; le passage au statut conforme
   d'un lot de MP ou d'AC est refuse tant que le document n'est pas joint
   (trigger `fn_liberation_exige_coa`).
5. **Precision explicite.** Masses et quantites en `NUMERIC(16,3)`, prix unitaires
   en `NUMERIC(16,4)`, montants de documents en `NUMERIC(18,2)`. Cote applicatif,
   `decimal.js` remplace l'arithmetique flottante ; les arrondis sont toujours
   explicites (`q3`, `p4`, `m2`).

## 2. Modele de donnees

### Referentiel et stock
- `articles_catalogue` — MP / AC / PF, unite contrainte par type, seuil critique,
  PAMP, masse volumique (MP achetees au volume), contenance (PF).
- `nomenclature_ac` — quantite d'articles de conditionnement par unite de PF.
- `fournisseurs`, `receptions` — origine des entrees.
- `lots_stock` — lot interne unique (`LOT-MP-AAAA-XXXXX`), lot fournisseur, DLUO,
  statut qualite, cout unitaire genere (`prix_achat + frais_approche`), certificat
  d'analyse (`coa_fichier`, ou `coa_absent_motif` si le document est annonce mais
  non encore fourni : le lot reste alors bloque en quarantaine).
- `mouvements_stock` — journal immuable (entree reception, sortie production,
  entree production, sortie vente, rebut, ajustement, annulation).

### Formulation
- `formules` — code, version, densite, produit fini rattache, intervalles de
  specification (pH, viscosite), perte de process.
- `formule_lignes` — phase A a E, pourcentage `NUMERIC(10,3)` borne a `]0 ; 100]`,
  consigne operatoire. Le trigger differe impose la somme a 100,000 % au COMMIT,
  ce qui autorise le remplacement atomique de tout le tableau d'ingredients.

### Production (MES)
- `ordres_fabrication` — masse nette cible, surdosage, masse brute, tolerance de
  pesee figee a la creation, elements de cout, rendement, CRU.
- `of_lignes_theoriques` — **fiche de fabrication figee** : la formule mise a
  l'echelle est copiee dans l'OF, de sorte qu'une evolution ulterieure de la
  formule ne reecrit jamais un dossier de lot.
- `of_pesees_reelles` — une ou plusieurs pesees par ligne (une consigne peut etre
  servie par plusieurs lots selon la regle FEFO) ; `ligne_terminee` marque le
  solde de la consigne, `conforme` l'ecart dans la tolerance.
- `lots_vrac` — lot de vrac, controles de cuve, decision de liberation.
- `of_conditionnement` — consommation des AC, rebuts de packaging.

### Commercial et finance
- `clients` (plafond d'encours, delai de reglement), `ventes_documents`
  (DEVIS / BC / BL / FACTURE chaines par `document_parent_id`), `ventes_lignes`
  (lot de PF obligatoire sur BL), `encaissements` et
  `encaissement_affectations` (un reglement, plusieurs factures).
- `depenses` / `depenses_categories` (charges directes et indirectes),
  `salaries` / `pointages` (heures imputables a un OF).
- Vues d'analyse : `v_stock_disponible`, `v_balance_agee`, `v_encours_clients`.

## 3. Flux industriel

```
Reception fournisseur ─> lot interne (quarantaine) ─> liberation qualite (conforme)
                                                          │
                              formule validee ────────────┤
                                                          ▼
                       OF : mise a l'echelle + controle de faisabilite
                                                          │
   Etape 1  Pesee atelier (FEFO, tolerance, double controle)
                                                          │
   Etape 2  Cloture de fabrication : destockage MP + lot de vrac
            Controle de cuve (pH, viscosite, organoleptique) -> liberation
                                                          │
   Etape 3  Conditionnement : consommation AC + lot de PF (adosse au vrac)
                                                          │
            Cloture de l'OF : rendement et cout de revient unitaire
                                                          │
   Vente    Devis -> BC -> BL (lots affectes, destockage) -> Facture -> Encaissement
```

## 4. Calculs metier

**Mise a l'echelle (batch scaling)**
```
masse_brute      = masse_nette x (1 + surdosage/100)
masse_ingredient = masse_brute x 1000 x pourcentage_w_w / 100      [g]
masse_nette(unites) = unites x contenance_ml x densite / 1000      [kg]
```

**Capacite predictive**
```
besoin_unitaire_i   = contenance_ml x densite x (1 + perte_process) x pourcentage_i / 100
unites_fabricables_i = plancher(stock_disponible_i / besoin_unitaire_i)
capacite            = min(unites_fabricables_i)        -> composant limitant = argmin
```

**Allocation FEFO** — lots `CONFORME`, non perimes, quantite > 0, tries par
`dluo` croissante (nulls en dernier) puis date de reception puis identifiant.

**Controle de pesee** — `ecart = (cumul_pese - consigne) / consigne x 100`.
Depassement de la tolerance : refus, sauf acceptation explicite du responsable
qualite (tracee, pesee marquee non conforme).

**Rendement reel**
```
unites_theoriques = masse_nette_vrac / (contenance_ml x densite)
rendement (%)     = unites_conformes_produites / unites_theoriques x 100
```

**Cout de revient unitaire (CRU)**
```
cout_MP         = somme(masse pesee x cout du lot consomme, au gramme)
cout_AC         = somme((consommes + rebuts) x cout du lot)
cout_MO         = somme(heures pointees x taux horaire du salarie)
                  a defaut : heures declarees x taux horaire moyen parametre
charges_indir.  = heures x taux horaire indirect
                  + % de frais generaux sur les couts directs
                  + depenses imputees directement a l'OF
CRU             = (cout_MP + cout_AC + cout_MO + charges_indirectes)
                  / unites de PF conformes produites
```
A la cloture, les lots de PF issus de l'OF sont valorises au CRU et le PAMP du
produit fini est recalcule.

**PAMP (prix d'achat moyen pondere)**
```
PAMP = (PAMP x stock_avant + cout_entree x quantite_entree) / (stock_avant + quantite_entree)
```

## 5. Securite

- Authentification JWT (12 h), mots de passe haches (bcrypt, cout 10).
- Matrice RBAC unique cote serveur (`backend/src/core/rbac.ts`), repliquee cote
  client uniquement pour l'affichage des menus : chaque route verifie la
  permission exacte, un menu masque ne protege rien par lui-meme.
- Deblocage d'encours : reservee aux administrateurs, exige la reauthentification
  du superviseur (e-mail + mot de passe) et laisse une trace nominative sur la
  piece ainsi que dans le journal d'audit.
- Validation des entrees par schema Zod avant tout acces a la base.
- Uploads restreints aux PDF et images, renommes en UUID, servis depuis un
  dossier dedie.
- Journal d'audit horodate et nominatif sur toutes les operations sensibles.

## 6. Ergonomie d'atelier

L'ecran de pesee (`/production/:id/pesee`) occupe toute la tablette : contraste
eleve, cibles tactiles de 62 px minimum (manipulation avec gants nitrile),
clavier numerique integre, consigne affichee en 46 px, verdict de conformite
immediat et champ de scan pour douchette USB / Bluetooth. Les lots non conformes,
perimes ou en quarantaine sont absents de la liste et refuses par le serveur ;
un scan de lot non conforme affiche le motif du refus.
