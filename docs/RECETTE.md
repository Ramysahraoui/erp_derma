# Recette fonctionnelle — criteres d'acceptation

Les six scenarios du cahier des charges sont automatises et rejoues a chaque
execution de la suite de tests.

```bash
npm test          # 37 tests, dont les 6 scenarios de recette
```

La suite recree integralement la base de test, applique les migrations, injecte
le jeu de demonstration, puis deroule des cycles industriels complets
(OF -> pesees -> vrac libere -> conditionnement -> cloture -> vente).

Fichiers : `backend/tests/recette.test.ts` (acceptation),
`backend/tests/metier.test.ts` (regles industrielles et financieres),
`backend/tests/unitaires.test.ts` (calculs purs).

---

## TEST-01 — Formule dont la somme vaut 99,80 %

**Attendu** : rejet immediat par l'IHM et l'API, message bloquant.

**Verifie** :
- `POST /api/formules` renvoie **422 `FORMULE_SOMME_INVALIDE`** avec
  `details = { somme: "99.800", ecart: "-0.200", attendu: "100.000" }` ;
- `PUT /api/formules/:id/lignes` renvoie le meme refus sur une formule existante ;
- aucune formule fantome n'est creee ;
- une insertion SQL directe contournant l'API est refusee au COMMIT par le
  trigger differe `ct_formule_somme_100` ;
- une formule totalisant exactement 100,000 % est acceptee ;
- cote IHM, l'editeur affiche la somme en temps reel et desactive
  l'enregistrement tant qu'elle differe de 100,000 %.

## TEST-02 — Fabrication de 500 unites, stock insuffisant sur un actif

**Attendu** : blocage de la validation de l'OF, affichage de l'ingredient
limitant et du volume maximal possible.

**Verifie** : apres reduction du stock d'acide hyaluronique,
- `POST /api/of/simulation` signale `faisable = false` et designe `MP-ACH-006` ;
- `POST /api/of` refuse la creation avec **422 `STOCK_INSUFFISANT_OF`**, en
  renvoyant l'ingredient limitant (besoin, disponible, manquant), la masse
  maximale fabricable et le nombre d'unites atteignable ;
- le simulateur de capacite `GET /api/capacite/produit/:id?unites_cibles=500`
  designe le meme goulot d'etranglement et marque la cible inatteignable.

## TEST-03 — Lot en quarantaine affecte a une pesee

**Attendu** : lot invisible ou desactive sur l'ecran de pesee, refus du systeme.

**Verifie** :
- la liste des lots proposes pour la ligne exclut le lot en quarantaine tout en
  conservant les lots conformes ;
- le scan du lot en quarantaine renvoie `utilisable: false` avec le motif ;
- l'affectation forcee par appel direct a l'API est refusee
  (**422 `PESEE_LOT_NON_CONFORME`**, trigger `fn_pesee_lot_valide`) ;
- un operateur de production ne peut pas liberer le lot lui-meme (**403**) ;
- la liberation est refusee tant que le certificat d'analyse n'est pas joint
  (**422 `COA_MANQUANT`**) ;
- certificat depose puis liberation par la qualite : le lot redevient disponible
  a la pesee.

## TEST-04 — BL depassant le plafond de credit

**Attendu** : blocage automatique avec demande d'autorisation administrateur.

**Verifie** :
- `POST /api/ventes` (type BL) renvoie **402 `PLAFOND_CREDIT_DEPASSE`** avec
  encours, montant de la piece, total apres operation et depassement ;
- un mot de passe superviseur errone est refuse (**403**) ;
- un utilisateur non administrateur ne peut pas autoriser le depassement (**403**) ;
- avec un deblocage administrateur valide, la piece est creee, validee, et
  l'autorisation est enregistree (`deblocage_par`, `deblocage_motif`) puis
  reportee sur le document imprime et dans le journal d'audit ;
- une vente restant dans les limites du plafond passe sans autorisation.

## TEST-05 — BL sans numero de lot de produit fini

**Attendu** : erreur bloquante, obligation de selectionner le lot expedie.

**Verifie** :
- `POST /api/ventes` (type BL) sans `lot_pf_id` renvoie
  **422 `LOT_PF_OBLIGATOIRE`** ;
- un devis, lui, peut etre etabli sans lot physique ;
- l'insertion SQL directe d'une ligne de BL sans lot est refusee par le trigger
  `fn_ligne_bl_exige_lot` ;
- la validation d'un BL dont une ligne perdrait son lot est refusee par
  `fn_controle_validation_bl` ;
- cote IHM, le selecteur de lot est obligatoire des que le document est un BL.

## TEST-06 — Tracabilite descendante d'un lot d'actif

**Attendu** : a partir d'un numero de lot recu, obtenir les OF consommateurs,
les lots de PF generes et la liste nominative des clients livres.

**Verifie** : apres un cycle complet et une livraison client,
- `GET /api/tracabilite/descendante/:lotId` renvoie les ordres de fabrication
  ayant consomme le lot (avec la quantite consommee et l'origine pesee ou
  conditionnement), les lots de PF generes, les expeditions et les clients
  livres nommement ;
- la recherche par numero (`/api/tracabilite/lot?code=`) deroule le meme
  resultat, y compris pour un numero de lot fournisseur ;
- la tracabilite ascendante depuis le lot de PF restitue le lot de vrac, les
  pesees, les lots de matieres premieres, leurs fournisseurs et leurs CoA.

---

## Couverture complementaire (`metier.test.ts`)

| Sujet | Verification |
|---|---|
| Mise a l'echelle | 150 kg + 1,5 % de surdosage = 152,250 kg ; repartition ponderale exacte au milligramme |
| Conversion unites | 3 000 flacons de 50 ml a 0,98 = 147,000 kg de vrac |
| FEFO | Service des lots par peremption croissante, couverture complete |
| Tolerance de pesee | Refus a +5 %, forcage interdit a l'operateur, acceptation qualite tracee et marquee non conforme |
| Cloture d'OF | Fabrication bloquee tant qu'une pesee manque ; `UPDATE` SQL direct refuse par le trigger |
| Certificat d'analyse | Reception sans CoA ni motif refusee ; reception motivee forcee en quarantaine ; liberation refusee (API et SQL direct) ; possible apres depot du document |
| Audit trail | `DELETE` refuse sur mouvements, pesees, lots, OF, vracs ; `UPDATE` d'un mouvement refuse |
| Lot de PF | Creation impossible sans lot de vrac libere |
| CRU | Coherence somme des composantes / unites produites ; main d'oeuvre au taux parametre ; lot de PF valorise au cout reel |
| Rendement | Calcul reel et decrementation du vrac au conditionnement |
| Liberation de cuve | Refus si pH hors specification |
| Chaine documentaire | Devis -> BC -> BL -> Facture, decrementation de stock a la validation du BL, echeance et marge |
| Encaissements | Multi-factures, paiement partiel, refus d'affectation superieure au solde, cheque impaye annulant l'apurement |
| Balance agee | Ventilation correcte en tranche 31-60 jours |
| Capacite | Goulot identifie et commande d'achat generee |
| RBAC | Cloisonnement de l'operateur atelier, refus d'acces anonyme |
| Documents | Dossier de lot, bon de pesee, BL avec numeros de lots, etiquette code-barres, rendu PDF reel |
| Journal d'audit | Presence des actions sensibles, horodatage et utilisateur nominatif |

## Validation complementaire de l'interface

Un parcours navigateur (Chromium) a ete execute sur l'ensemble des ecrans :
connexion, quinze pages fonctionnelles, editeur de formule (indicateur de somme
ponderale), simulateur de capacite, creation d'un OF avec simulation de
faisabilite, ecran de pesee tactile (selection FEFO, clavier numerique,
validation d'une pesee). Aucune erreur console n'est remontee.

Les code-barres Code 128 produits pour les etiquettes de lots ont ete relus avec
succes par un decodeur tiers (ZXing) sur les formats `LOT-MP-…`, `VRAC-…`,
`LOT-PF-…` et `BL-…`.
