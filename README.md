# ERP / MES dermo-cosmetique

Progiciel de gestion integre sur mesure pour une unite industrielle de fabrication
dermo-cosmetique : approvisionnement et tracabilite granulaire des lots, moteur de
formulation matricielle, execution des ordres de fabrication avec dossier de lot
electronique (BPF / ISO 22716), administration des ventes tracee par lot,
recouvrement et comptabilite analytique jusqu'au cout de revient unitaire reel.

Le perimetre fonctionnel couvre les quatre jalons du cahier des charges
(`docs/CDCF.md`) et les six scenarios de recette sont automatises
(`backend/tests/recette.test.ts`).

---

## 1. Installation sur le serveur de l'usine

Un seul prerequis : **Docker**. Tout le reste est automatique.

```bash
git clone <adresse-du-depot> erp-derma
cd erp-derma
./installer.sh
```

Le script genere les secrets, construit les images, demarre la base de donnees,
l'API et le serveur web, applique le schema, amorce le parametrage et cree le
compte administrateur — dont il affiche le mot de passe initial a noter.
L'application est alors accessible depuis tout le reseau local :
`http://<ip-du-serveur>:8080`.

La base est livree **sans aucune donnee fictive** : un compte administrateur,
les parametres d'exploitation et le plan de ventilation analytique. Articles,
formules, lots et clients sont saisis par vos equipes.

Guide detaille (prerequis materiels, reseau, sauvegardes, depannage) :
**`docs/INSTALLATION.md`**.

| Operation courante | Commande |
|---|---|
| Etat des services | `docker compose ps` |
| Journaux | `docker compose logs -f` |
| Arret / redemarrage | `docker compose stop` / `docker compose start` |
| Sauvegarde | `./sauvegarde.sh` |
| Mise a jour | `git pull && ./installer.sh` |

---

## 2. Stack technique

| Couche | Choix | Justification |
|---|---|---|
| Base de donnees | **PostgreSQL 14+** | Transactions ACID, integrite referentielle stricte, `NUMERIC` haute precision, triggers portant les regles non negociables |
| Backend | **Node.js 20+ / TypeScript** (Fastify, Zod, `pg`, decimal.js) | Langage type, validation de schema a l'entree, SQL maitrise (aucune magie ORM sur les regles metier) |
| Frontend | **React 18 + TypeScript + Vite** (SPA) | Interface reactive, responsive, ecrans tactiles d'atelier |
| Documents | **Chromium headless** (PDF) + Code 128 SVG natif | Bons de pesee, dossiers de lot, BL, factures, etiquettes scannables |

Aucun ORM n'intervient sur les regles de tracabilite : le schema SQL
(`backend/src/db/migrations/001_socle.sql`) est la source de verite.

## 3. Environnement de developpement

### Prerequis
- Node.js >= 20, npm >= 10
- PostgreSQL >= 14 accessible
- (optionnel) Chromium pour le rendu PDF ; a defaut, les documents sont servis
  en HTML imprimable

### Installation

```bash
npm run installer                       # dependances backend + frontend
cp backend/.env.example backend/.env    # puis ajuster DATABASE_URL et JWT_SECRET
createdb erp_derma                      # base applicative
npm run migrer                          # creation du schema
npm run amorcer                         # parametrage + compte administrateur
```

### Execution

```bash
npm run dev:api     # API sur http://localhost:3000
npm run dev:web     # interface sur http://localhost:5173 (proxy /api -> 3000)
```

En production : `npm run build` puis `node backend/dist/server.js`, le dossier
`frontend/dist` etant servi par un serveur statique ou un reverse proxy.

### Jeu de demonstration (formation et recette uniquement)

```bash
npm run demonstration          # en developpement
# ou, sur une installation conteneurisee de TEST :
docker compose exec api node dist/db/cli-demo.js
```

Il injecte un referentiel fictif complet (22 articles, 3 formules, lots, clients)
et cinq comptes — `direction@`, `qualite@`, `atelier@`, `commercial@`,
`comptabilite@derma.dz`, mot de passe `Derma2026!`. **A ne jamais executer sur
une installation de production.**

## 4. Tests

```bash
npm test            # 41 tests : installation, recette fonctionnelle, regles metier, unitaires
```

Un parcours de validation de l'interface (Chromium) est egalement fourni :

```bash
npm i -D playwright            # une fois
npm run dev:api & npm run dev:web &
npm run test:ui                # frontend/e2e/parcours.mjs
```

La suite de tests backend reinitialise integralement une base dediee
(`DATABASE_URL=…/erp_derma_test`), rejoue les migrations, injecte le jeu de
demonstration puis deroule des cycles industriels complets.
Detail des scenarios de recette : `docs/RECETTE.md`.

## 5. Regles metier non negociables et leur application

| Regle | Ou elle est appliquee |
|---|---|
| Somme ponderale d'une formule = **100,000 %** | Contrainte `CHECK` par ligne + trigger differe `ct_formule_somme_100` + controle API `controlerSommePonderale` + indicateur temps reel dans l'IHM |
| Aucun `DELETE` sur une donnee de tracabilite | Triggers `fn_interdire_suppression` sur mouvements, pesees, lots, OF, vracs, documents de vente, encaissements, journal d'audit |
| Un mouvement de stock est immuable | Trigger `fn_mouvement_immuable` (seule l'annulation par contre-passation est possible) |
| Un lot de PF exige un lot de vrac **libere** | Trigger `fn_lot_pf_exige_vrac` |
| Aucune sortie commerciale sans numero de lot de PF | Triggers `fn_ligne_bl_exige_lot` et `fn_controle_validation_bl` + refus API |
| Cloture d'OF impossible sans pesees completes | Trigger `fn_controle_cloture_of` + verification applicative |
| Consommation reservee aux lots conformes | Triggers `fn_mouvement_lot_conforme`, `fn_pesee_lot_valide` + filtrage FEFO de l'ecran de pesee |
| Mot de passe initial a usage unique | Changement impose a la premiere connexion, refus serveur de tout acces metier avant (`MOT_DE_PASSE_A_CHANGER`) |
| Certificat d'analyse obligatoire a la reception | Refus API sans CoA ni motif ; trigger `fn_liberation_exige_coa` interdisant de declarer conforme un lot MP/AC sans document joint |

## 6. Organisation du depot

```
installer.sh                 installation sur site (Docker)
sauvegarde.sh                sauvegarde et restauration
docker-compose.yml           base de donnees + API + serveur web
.env.exemple                 configuration (port, societe, compte admin)
backend/                     API metier (Fastify + PostgreSQL)
  src/db/migrations/         schema SQL, triggers et vues
  src/core/                  RBAC, audit trail, numerotation, precision decimale
  src/modules/               articles, stock, capacite, formules, production,
                             ventes, recouvrement, finance, tracabilite, documents
  tests/                     recette fonctionnelle, regles metier, unitaires
frontend/                    SPA React (dont ecran de pesee tactile)
docs/                        CDCF, architecture, API, recette, exploitation
```

## 7. Documentation

- `docs/INSTALLATION.md` — **guide d'installation sur site** (prerequis, reseau, sauvegardes, depannage)
- `docs/CDCF.md` — cahier des charges fonctionnel et technique de reference
- `docs/ARCHITECTURE.md` — modele de donnees, flux industriels, calculs (CRU, rendement, PAMP, FEFO)
- `docs/API.md` — reference des points d'entree REST
- `docs/RECETTE.md` — scenarios d'acceptation TEST-01 a TEST-06 et resultats
- `docs/EXPLOITATION.md` — parametrage, securite, migrations, supervision
