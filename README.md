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

## 1. Stack technique

| Couche | Choix | Justification |
|---|---|---|
| Base de donnees | **PostgreSQL 14+** | Transactions ACID, integrite referentielle stricte, `NUMERIC` haute precision, triggers portant les regles non negociables |
| Backend | **Node.js 20+ / TypeScript** (Fastify, Zod, `pg`, decimal.js) | Langage type, validation de schema a l'entree, SQL maitrise (aucune magie ORM sur les regles metier) |
| Frontend | **React 18 + TypeScript + Vite** (SPA) | Interface reactive, responsive, ecrans tactiles d'atelier |
| Documents | **Chromium headless** (PDF) + Code 128 SVG natif | Bons de pesee, dossiers de lot, BL, factures, etiquettes scannables |

Aucun ORM n'intervient sur les regles de tracabilite : le schema SQL
(`backend/src/db/migrations/001_socle.sql`) est la source de verite.

## 2. Demarrage

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
npm run semer                           # jeu de demonstration (optionnel)
```

### Execution

```bash
npm run dev:api     # API sur http://localhost:3000
npm run dev:web     # interface sur http://localhost:5173 (proxy /api -> 3000)
```

En production : `npm run build` puis `node backend/dist/server.js`, le dossier
`frontend/dist` etant servi par un serveur statique ou un reverse proxy.

### Comptes de demonstration (mot de passe `Derma2026!`)

| Compte | Role | Perimetre |
|---|---|---|
| `direction@derma.dz` | Administrateur / Direction | Acces complet, parametrage, rentabilite |
| `qualite@derma.dz` | Responsable R&D / Qualite | Formules, liberation des lots, ordres de fabrication |
| `atelier@derma.dz` | Operateur production | Pesees, cuve, conditionnement — aucun acces aux couts ni aux clients |
| `commercial@derma.dz` | Commercial / Facturation | Clients, devis, BL, factures |
| `comptabilite@derma.dz` | Comptabilite / Recouvrement | Encaissements, balance agee, depenses |

## 3. Tests

```bash
npm test            # 36 tests : recette fonctionnelle, regles metier, unitaires
```

La suite reinitialise integralement une base dediee
(`DATABASE_URL=…/erp_derma_test`), rejoue les migrations, injecte le jeu de
demonstration puis deroule des cycles industriels complets.
Detail des scenarios de recette : `docs/RECETTE.md`.

## 4. Regles metier non negociables et leur application

| Regle | Ou elle est appliquee |
|---|---|
| Somme ponderale d'une formule = **100,000 %** | Contrainte `CHECK` par ligne + trigger differe `ct_formule_somme_100` + controle API `controlerSommePonderale` + indicateur temps reel dans l'IHM |
| Aucun `DELETE` sur une donnee de tracabilite | Triggers `fn_interdire_suppression` sur mouvements, pesees, lots, OF, vracs, documents de vente, encaissements, journal d'audit |
| Un mouvement de stock est immuable | Trigger `fn_mouvement_immuable` (seule l'annulation par contre-passation est possible) |
| Un lot de PF exige un lot de vrac **libere** | Trigger `fn_lot_pf_exige_vrac` |
| Aucune sortie commerciale sans numero de lot de PF | Triggers `fn_ligne_bl_exige_lot` et `fn_controle_validation_bl` + refus API |
| Cloture d'OF impossible sans pesees completes | Trigger `fn_controle_cloture_of` + verification applicative |
| Consommation reservee aux lots conformes | Triggers `fn_mouvement_lot_conforme`, `fn_pesee_lot_valide` + filtrage FEFO de l'ecran de pesee |

## 5. Organisation du depot

```
backend/                     API metier (Fastify + PostgreSQL)
  src/db/migrations/         schema SQL, triggers et vues
  src/core/                  RBAC, audit trail, numerotation, precision decimale
  src/modules/               articles, stock, capacite, formules, production,
                             ventes, recouvrement, finance, tracabilite, documents
  tests/                     recette fonctionnelle, regles metier, unitaires
frontend/                    SPA React (dont ecran de pesee tactile)
docs/                        CDCF, architecture, API, recette, exploitation
```

## 6. Documentation

- `docs/CDCF.md` — cahier des charges fonctionnel et technique de reference
- `docs/ARCHITECTURE.md` — modele de donnees, flux industriels, calculs (CRU, rendement, PAMP, FEFO)
- `docs/API.md` — reference des points d'entree REST
- `docs/RECETTE.md` — scenarios d'acceptation TEST-01 a TEST-06 et resultats
- `docs/EXPLOITATION.md` — deploiement, sauvegarde, securite, parametrage
