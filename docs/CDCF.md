# Cahier des charges fonctionnel et technique (CDCF)

**Projet** : Systeme integre de gestion de production cosmetique (ERP / MES metier)
**Version** : 1.0 — document contractuel et specifications de developpement
**Destinataires** : chef de projet, developpeur full-stack / architecte logiciel

> Document de reference reproduit tel que transmis. Les formules mathematiques
> presentes sous forme d'images dans la source ont ete restituees en clair dans
> `ARCHITECTURE.md` (section « Calculs metier »), sur la base des definitions
> usuelles du secteur, et sont parametrables dans l'application.

## 1. Presentation generale et enjeux

### 1.1 Contexte et objectifs

Developpement sur mesure d'un progiciel de gestion integre dedie a une unite
industrielle de fabrication dermo-cosmetique, couvrant :

- approvisionnement et tracabilite granulaire des matieres premieres (MP) et
  articles de conditionnement (AC) ;
- moteur de formulation matricielle avec mise a l'echelle dynamique des cuves ;
- execution des ordres de fabrication (OF) avec dossier de lot conforme aux BPF /
  ISO 22716 ;
- gestion des stocks temps reel, valorisation financiere (PAMP) et calcul
  predictif de capacite ;
- administration des ventes (devis -> facturation), tracabilite des expeditions
  par numero de lot ;
- recouvrement, gestion du risque client, balance agee et suivi de tresorerie ;
- comptabilite analytique, charges d'exploitation et cout de revient unitaire (CRU).

### 1.2 Regles metier fondamentales (non negociables)

1. **Integrite de la formule** : expression en pourcentage ponderal strict (w/w) ;
   la somme des pourcentages doit etre rigoureusement egale a 100,000 %.
2. **Immuabilite des donnees de tracabilite** : tout mouvement de stock,
   validation de pesee ou signature de lot est irreversible. Aucun `DELETE` sur
   une ligne liee a la tracabilite ; corrections par ecritures d'ajustement ou
   d'annulation tracees (audit trail).
3. **Conditionnement lie au lot de vrac** : un lot de produit fini ne peut exister
   sans rattachement a un lot de vrac libere par le controle qualite.
4. **Vente conditionnee au lot** : aucune sortie commerciale (bon de livraison) ne
   peut etre validee sans assignation explicite des numeros de lots de PF.

## 2. Specifications fonctionnelles

### Module 1 — Referentiel articles, achats et stocks
- Trois categories obligatoires : MP (g, kg, L), AC (piece / U), PF (U).
- Reception : reference, quantite, date, numero de lot fournisseur, DLUO,
  **upload obligatoire du certificat d'analyse (PDF ou image)**, prix d'achat
  unitaire HT et frais d'approche. Generation d'un numero de lot interne unique
  (`LOT-MP-AAAA-XXXXX`).
- Statuts de lot et regle **FEFO** : seuls les lots conformes sont allouables a la
  production ; priorite au lot dont la peremption est la plus proche.
- **Moteur de capacite predictive** : selection d'un ou plusieurs PF, calcul du
  nombre maximal theorique d'unites fabricables, mise en evidence du composant
  limitant, generation de la commande d'achat des quantites manquantes.

### Module 2 — R&D, formulation et ordres de fabrication
- Formule : code, designation, version, densite theorique, ingredients ventiles
  par phases operatoires A a E, pourcentage a 3 decimales, consigne operatoire.
  Controle d'integrite UI et backend : enregistrement interdit si la somme
  differe de 100 %.
- **Mise a l'echelle dynamique** : saisie d'une masse nette de vrac ou d'un
  nombre d'unites de PF (conversion par la densite), coefficient de surdosage
  technique pour compenser les pertes de fond de cuve.
- **Dossier de lot electronique** en trois etapes :
  1. *Pesee atelier* — scan ou selection filtree sur les lots conformes (FEFO),
     consigne theorique, saisie de la masse reelle, controle d'ecart tolere
     parametrable, validation bloquante ;
  2. *Fabrication cuve et liberation* — horodatage debut/fin de melange, releve
     du pH, de la viscosite et des controles organoleptiques, generation du lot
     de vrac, destockage definitif des MP pesees ;
  3. *Conditionnement* — association du vrac libere aux lots d'AC, declaration
     des unites conformes et des rebuts, generation du lot de PF, calcul du
     rendement reel, destockage des AC et entree en stock du PF.

### Module 3 — Commercial, facturation et recouvrement
- Chaine documentaire devis -> BC -> BL -> facture -> encaissement.
- Affectation obligatoire des lots de PF sur le BL ; la validation decremente le
  stock et mentionne les numeros de lots livres.
- Fiches clients : plafond d'encours autorise, delai de reglement, verrouillage
  automatique et deblocage par mot de passe superviseur.
- Balance agee (non echues, 1-30, 31-60, > 60 jours), encaissements multi-factures
  et paiements partiels, modes especes / cheque (numero, date d'emission, date
  previsionnelle d'encaissement, statut recu-depose-encaisse-impaye) / virement,
  historique d'apurement.

### Module 4 — Depenses, RH et comptabilite analytique
- Journal des depenses ventilees en charges directes et indirectes, rapprochement
  bancaire simplifie.
- Fiches salaries, suivi des presences et des heures par departement, taux horaire
  moyen affecte au cout de main d'oeuvre.
- Calcul du cout de revient unitaire reel a la cloture de chaque OF et mise a jour
  de la marge brute unitaire lors de l'emission des factures.

## 3. Contraintes d'integrite exigees

- `CHECK (pourcentage_w_w > 0 AND pourcentage_w_w <= 100)` sur les lignes de formule ;
- `UNIQUE (code_lot_interne)` sur les lots de stock ;
- lot de PF obligatoire sur les lignes de documents de type BL ;
- trigger d'invalidation interdisant le passage d'un OF a l'etat cloture si une
  ligne de pesee obligatoire est absente.

## 4. Specifications techniques et securite

- Backend type et robuste, base **PostgreSQL** (ACID, integrite referentielle,
  champs numeriques haute precision), frontend SPA reactive adaptee aux tablettes
  industrielles, generation PDF native cote serveur.
- Ergonomie d'atelier : grands boutons et clavier virtuel utilisables avec des
  gants nitrile, integration code-barres / QR code par douchette USB ou Bluetooth.
- **RBAC** : operateur production (pesees et parametres cuve uniquement, aucun
  acces aux couts, marges ou clients), responsable R&D / qualite (formules,
  liberations), commercial / facturation, comptabilite / recouvrement,
  administrateur / direction.

## 5. Recette fonctionnelle

| ID | Scenario | Resultat attendu |
|---|---|---|
| TEST-01 | Enregistrement d'une formule dont la somme = 99,80 % | Rejet immediat par l'UI et l'API avec message bloquant |
| TEST-02 | Simulation de 500 unites avec stock insuffisant sur un actif | Blocage de la validation de l'OF, ingredient limitant et volume maximal affiches |
| TEST-03 | Affectation d'un lot en quarantaine a une pesee | Lot invisible ou desactive, refus du systeme |
| TEST-04 | BL depassant le plafond de credit non solde | Blocage automatique avec autorisation administrateur |
| TEST-05 | Validation d'un BL sans numero de lot de PF | Erreur bloquante, selection du lot obligatoire |
| TEST-06 | Tracabilite descendante d'un lot d'actif recu 6 mois plus tot | Liste des OF consommateurs, des lots de PF generes et des clients livres |

Resultats d'execution : `RECETTE.md`.

## 6. Jalons de livraison

1. **Jalon 1** — socle de donnees et gestion des stocks ;
2. **Jalon 2** — formules, moteur de cuve et pesees (MES) ;
3. **Jalon 3** — ventes, tracabilite des expeditions et recouvrement ;
4. **Jalon 4** — depenses, couts de revient et recette globale (RBAC, tests de
   bout en bout).
