# Reference de l'API REST

Base : `/api` — authentification par jeton JWT (`Authorization: Bearer <jeton>`).
Les erreurs metier renvoient `{ "erreur": "CODE", "message": "…", "details": … }`
avec un statut HTTP explicite (401 non authentifie, 403 privilege insuffisant,
402 deblocage superviseur requis, 404 introuvable, 409 conflit, 422 regle metier).

## Authentification et utilisateurs
| Methode | Route | Permission | Objet |
|---|---|---|---|
| POST | `/auth/connexion` | — | Retourne `{ jeton, utilisateur }` |
| GET | `/auth/moi` | authentifie | Profil courant |
| GET / POST | `/auth/utilisateurs` | `*` | Liste / creation |
| PATCH | `/auth/utilisateurs/:id` | `*` | Role, activation, mot de passe |

## Referentiel
| Methode | Route | Permission | Objet |
|---|---|---|---|
| GET | `/articles` | `article:lire` | Filtres `type`, `recherche`, `actif`, `avec_stock` |
| GET | `/articles/:id` | `article:lire` | Article, lots en stock, nomenclature |
| POST / PATCH | `/articles` `/articles/:id` | `article:ecrire` | Creation / mise a jour |
| PUT | `/articles/:id/nomenclature` | `article:ecrire` | Nomenclature de conditionnement d'un PF |
| GET / POST | `/fournisseurs` | `article:lire` / `achat:ecrire` | Fournisseurs |

## Stock et receptions
| Methode | Route | Permission | Objet |
|---|---|---|---|
| POST | `/fichiers` | `stock:receptionner` | Televersement d'un CoA (PDF/image, 12 Mo) |
| POST | `/receptions` | `stock:receptionner` | Reception multi-lignes, genere les lots internes. `coa_fichier` **obligatoire**, sinon `coa_absent_motif` (le lot est force en quarantaine) |
| GET | `/receptions` `/receptions/:id` | `stock:lire` | Historique et detail |
| GET | `/lots` | `stock:lire` | Filtres `article_id`, `statut`, `type`, `recherche`, `disponible`, `peremption_avant` |
| GET | `/lots/:id` | `stock:lire` | Lot et historique complet des mouvements |
| POST | `/lots/:id/statut` | `stock:liberer` | Liberation, blocage, rejet (motif trace). Refus **422 `COA_MANQUANT`** sans certificat |
| POST | `/lots/:id/coa` | `stock:receptionner` | Depot differe du certificat d'analyse |
| POST | `/lots/:id/ajustement` | `stock:ajuster` | Correction signee, motif obligatoire |
| GET | `/stock/fefo` | `stock:lire` | Proposition d'allocation FEFO (`article_id`, `quantite`) |
| GET | `/stock/etat` | `stock:lire` | Etat des stocks par article |
| GET | `/stock/alertes` | `stock:lire` | Sous-seuil, peremptions a 90 jours, quarantaine |
| GET | `/stock/mouvements` | `stock:lire` | Journal des mouvements |

## Capacite predictive et achats
| Methode | Route | Permission | Objet |
|---|---|---|---|
| POST | `/capacite/simulation` | `stock:lire` | Liste de PF, objectifs ; renvoie capacite, composant limitant, besoins consolides |
| GET | `/capacite/produit/:id` | `stock:lire` | Simulation d'un seul produit fini |
| POST | `/capacite/commande-achat` | `achat:ecrire` | Genere la commande des quantites manquantes |
| GET | `/capacite/commandes-achat` | `achat:lire` | Commandes generees |

## Formulation
| Methode | Route | Permission | Objet |
|---|---|---|---|
| GET | `/formules` `/formules/:id` | `formule:lire` | Liste, detail, versions, somme ponderale |
| POST | `/formules` | `formule:ecrire` | Creation (entete + lignes optionnelles) |
| PATCH | `/formules/:id` | `formule:ecrire` | Entete (brouillon uniquement) |
| PUT | `/formules/:id/lignes` | `formule:ecrire` | Remplacement atomique du tableau d'ingredients (100,000 % exiges) |
| POST | `/formules/:id/valider` | `formule:ecrire` | Rend la formule utilisable en production |
| POST | `/formules/:id/nouvelle-version` | `formule:ecrire` | Duplication et archivage de la version precedente |
| POST | `/formules/:id/mise-a-echelle` | `formule:lire` | Batch scaling (`masse_nette_kg` ou `unites_pf`, `surdosage_pct`) |

## Production (MES)
| Methode | Route | Permission | Objet |
|---|---|---|---|
| GET | `/of` `/of/:id` | `production:lire` | Liste, dossier de lot electronique |
| POST | `/of/simulation` | `production:lire` | Fiche mise a l'echelle + faisabilite |
| POST | `/of` | `production:creer` | Creation ; **refus 422 `STOCK_INSUFFISANT_OF`** avec ingredient limitant et volume maximal |
| GET | `/of/:id/lignes/:ligneId/lots` | `production:peser` | Lots conformes proposes (FEFO) |
| GET | `/of/:id/lignes/:ligneId/fefo` | `production:peser` | Allocation detaillee et reste a peser |
| GET | `/of/:id/scan?code=` | `production:peser` | Resolution d'un lot scanne et motif de refus eventuel |
| POST | `/of/:id/pesees` | `production:peser` | Pesee ; `forcer` reserve a la qualite |
| POST | `/of/:id/pesees/:peseeId/annuler` | `production:peser` | Annulation tracee (jamais de suppression) |
| POST | `/of/:id/fabrication` | `production:cuve` | Cloture de fabrication : destockage MP, lot de vrac |
| POST | `/of/:id/vrac/controle` | `stock:liberer` | Controles de cuve, liberation ou rejet |
| POST | `/of/:id/conditionnement` | `production:conditionner` | Consommation AC, lot de PF, rendement |
| POST | `/of/:id/heures` | `production:lire` | Heures de production declarees |
| POST | `/of/:id/cloturer` | `production:cloturer` | Cloture et calcul du CRU |

## Commercial
| Methode | Route | Permission | Objet |
|---|---|---|---|
| GET / POST / PATCH | `/clients` … | `client:lire` / `client:ecrire` | Fiches clients, plafond, blocage |
| GET | `/clients/:id/encours` | `client:lire` | Encours facture, livre non facture, echu |
| GET | `/ventes` `/ventes/:id` | `vente:lire` | Documents, lignes, reglements, pieces liees |
| GET | `/ventes/lots-disponibles/:articleId` | `vente:lire` | Lots de PF expediables (FEFO) |
| POST | `/ventes` | `vente:ecrire` | Creation (`valider: true` pour valider dans la foulee) |
| POST | `/ventes/:id/valider` | `vente:ecrire` | Validation ; un BL decremente le stock |
| POST | `/ventes/:id/transformer` | `vente:ecrire` | Devis -> BC -> BL -> Facture, avec affectation des lots |
| POST | `/ventes/:id/annuler` | `vente:ecrire` | Annulation avec contre-passation des mouvements |

Depassement de plafond : reponse **402 `PLAFOND_CREDIT_DEPASSE`**. Rejouer la
requete avec `deblocage: { email, mot_de_passe, motif }` d'un administrateur.

## Recouvrement
| Methode | Route | Permission | Objet |
|---|---|---|---|
| GET | `/recouvrement/balance-agee` | `recouvrement:lire` | Creances par tranche de retard |
| GET | `/recouvrement/tableau-de-bord` | `recouvrement:lire` | Balance, cheques, encaissements du mois, clients a risque |
| GET / POST | `/recouvrement/encaissements` | `encaissement:lire` / `ecrire` | Multi-affectation, paiements partiels |
| POST | `/recouvrement/encaissements/:id/cheque` | `encaissement:ecrire` | Cycle de vie du cheque (un impaye annule l'apurement) |
| GET | `/recouvrement/factures-ouvertes/:clientId` | `encaissement:lire` | Factures a apurer |

## Depenses, personnel, analytique
| Methode | Route | Permission | Objet |
|---|---|---|---|
| GET / POST | `/depenses` `/depenses/categories` | `depense:lire` / `ecrire` | Journal des charges ventilees |
| POST | `/depenses/:id/rapprochement` | `depense:ecrire` | Rapprochement bancaire |
| GET | `/tresorerie` | `finance:lire` | Recettes encaissees vs depenses |
| GET / POST / PATCH | `/salaries` `/pointages` | `rh:lire` | Fiches et heures imputables aux OF |
| GET | `/rh/synthese` | `rh:lire` | Heures et cout de main d'oeuvre par departement |
| GET / PUT | `/parametres` `/parametres/:cle` | `finance:lire` / `*` | Tolerance de pesee, taux horaires, TVA, devise |
| GET | `/analyse/rentabilite` | `finance:lire` | Marge par produit, CRU par OF |
| GET | `/tableau-de-bord` | `stock:lire` | Indicateurs de pilotage |

## Tracabilite et documents
| Methode | Route | Permission | Objet |
|---|---|---|---|
| GET | `/tracabilite/lot?code=` | `tracabilite:lire` | Point d'entree unique (sens deduit du type de lot) |
| GET | `/tracabilite/descendante/:lotId` | `tracabilite:lire` | OF, lots de PF, expeditions, **clients livres** |
| GET | `/tracabilite/ascendante/:lotId` | `tracabilite:lire` | Vrac, pesees, matieres, fournisseurs, CoA |
| GET | `/tracabilite/recherche?code=` | `tracabilite:lire` | Recherche partielle (douchette ou saisie) |
| GET | `/documents/of/:id/bon-de-pesee` | `production:lire` | PDF (ou `?format=html`) |
| GET | `/documents/of/:id/dossier-de-lot` | `production:lire` | Fiche suiveuse complete |
| GET | `/documents/ventes/:id` | `vente:lire` | Devis, BC, BL (lots mentionnes), facture |
| GET | `/documents/lots/:id/etiquette` | `stock:lire` | Etiquette avec code-barres Code 128 |
| GET | `/documents/commandes-achat/:id` | `achat:lire` | Bon de commande fournisseur |
| GET | `/documents/journal-audit` | `*` | Journal d'audit filtrable |
| GET | `/sante` | — | Sonde de disponibilite |
