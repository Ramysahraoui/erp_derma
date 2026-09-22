# Guide d'installation — livraison sur site

Ce document s'adresse a la personne qui installe l'application sur le serveur
de l'usine. Aucune connaissance de developpement n'est requise.

---

## 1. Ce qu'il faut prevoir

| Element | Minimum | Confortable |
|---|---|---|
| Machine | 2 coeurs, 4 Go de RAM, 40 Go de disque | 4 coeurs, 8 Go, 100 Go SSD |
| Systeme | Linux (Ubuntu Server 22.04+, Debian 12+) ou Windows avec Docker Desktop | Ubuntu Server LTS |
| Reseau | Adresse IP fixe sur le reseau local | Idem + nom DNS interne (ex. `erp.usine.local`) |
| Logiciel | **Docker Engine 20.10+** avec le plugin `docker compose` | Docker Engine a jour |

Les postes de travail et les tablettes d'atelier n'ont besoin que d'un
navigateur recent (Chrome, Edge, Firefox). Rien n'est a installer sur les postes.

### Installer Docker (Ubuntu / Debian)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"     # puis se deconnecter / reconnecter
```

## 2. Installation

```bash
# 1. Recuperer le livrable sur le serveur
git clone <adresse-du-depot> erp-derma     # ou copier/decompresser l'archive
cd erp-derma

# 2. Lancer l'installation
./installer.sh
```

Le script verifie Docker, genere les secrets (mot de passe de la base, cle de
signature des jetons), construit les images, demarre les trois services et
attend que l'application reponde. Comptez cinq a dix minutes la premiere fois.

A la fin, il affiche :

```
  ✔ Installation terminee

  Acces depuis ce poste       : http://localhost:8080
  Acces depuis le reseau local : http://192.168.1.50:8080

  ================================================================
   COMPTE ADMINISTRATEUR — a noter immediatement
  ================================================================
   Identifiant  : admin@erp-derma.local
   Mot de passe : 9QKBKpKLG6Tt332dsM
   Changement impose a la premiere connexion.
  ================================================================
```

**Notez ce mot de passe** : il n'est affiche qu'une fois (il reste consultable
dans les journaux avec `docker compose logs api`). Le systeme impose son
remplacement des la premiere connexion et refuse tout acces metier avant.

## 3. Personnaliser avant ou apres l'installation

Le fichier `.env`, cree par le script, rassemble toute la configuration :

```bash
PORT_WEB=8080                       # port d'acces depuis le reseau local
ADMIN_EMAIL=admin@erp-derma.local   # identifiant du compte administrateur
                                    # (un domaine avec extension est requis)
ADMIN_MOT_DE_PASSE=                 # laisser vide = mot de passe genere
SOCIETE_NOM=Laboratoire Dermo-Cosmetique
SOCIETE_ADRESSE=Zone industrielle, Rouiba
SOCIETE_TEL=+213 ...
SOCIETE_RC=...                      # registre de commerce
SOCIETE_NIF=...                     # numero d'identification fiscale
DEVISE=DZD
TZ=Africa/Algiers
```

Les informations de societe figurent sur les bons de livraison, factures, bons
de pesee et dossiers de lot. Apres modification :

```bash
docker compose up -d
```

## 4. Etat de l'application apres installation

La base ne contient **aucune donnee fictive**. Elle est livree avec le
parametrage d'exploitation necessaire au demarrage :

| Element | Contenu |
|---|---|
| Compte administrateur | Un seul, celui du `.env` |
| Parametres d'exploitation | Tolerance de pesee 0,500 %, taux horaire main d'oeuvre, taux de charges indirectes, TVA, devise, duree de quarantaine |
| Plan de ventilation analytique | 13 categories de charges (5 directes, 8 indirectes) conformes au module 4 du cahier des charges |
| Articles, formules, lots, clients | Vides — a saisir par vos equipes |

### Ordre de mise en route conseille

1. **Administration → Utilisateurs** : creer les comptes (operateur production,
   responsable R&D/qualite, commercial, comptabilite). Chacun recoit un mot de
   passe provisoire qu'il devra changer a sa premiere connexion.
2. **Administration → Parametres** : ajuster tolerance de pesee, taux horaires,
   TVA et devise.
3. **Articles** : creer les matieres premieres, les articles de conditionnement
   puis les produits finis (contenance en ml pour ces derniers), et la
   nomenclature de conditionnement de chaque produit fini.
4. **Fournisseurs**, puis **Receptions** : saisir le stock existant avec les
   numeros de lots fournisseurs, DLUO et certificats d'analyse.
5. **Formules** : saisir les formules (somme ponderale exactement 100,000 %)
   et les valider.
6. **Clients** : fiches, plafonds d'encours et delais de reglement.
7. La production peut alors demarrer.

> Pour une seance de formation, un jeu de donnees fictif complet peut etre
> injecte dans une installation **de test** :
> `docker compose exec api node dist/db/cli-demo.js`.
> Ne jamais l'executer sur l'installation de production.

## 5. Exploitation courante

| Operation | Commande |
|---|---|
| Voir l'etat des services | `docker compose ps` |
| Consulter les journaux | `docker compose logs -f` |
| Arreter | `docker compose stop` |
| Redemarrer | `docker compose start` |
| Redemarrer apres modification du `.env` | `docker compose up -d` |
| Sauvegarder | `./sauvegarde.sh` |
| Restaurer | `./sauvegarde.sh --restaurer sauvegardes/erp-AAAAMMJJ-HHMMSS.dump` |
| Mettre a jour | `git pull && ./installer.sh` |

Les trois services redemarrent automatiquement avec le serveur
(`restart: unless-stopped`) : apres une coupure de courant, l'application
repart seule.

### Sauvegardes

`./sauvegarde.sh` produit deux fichiers dans `sauvegardes/` : la base de donnees
et les certificats d'analyse. Les trente dernieres sauvegardes sont conservees.
Automatisation quotidienne a 22 h :

```bash
crontab -e
0 22 * * * cd /chemin/vers/erp-derma && ./sauvegarde.sh >> sauvegardes/journal.log 2>&1
```

Copiez regulierement le dossier `sauvegardes/` sur un support externe : une
sauvegarde qui reste sur le serveur ne protege pas d'une panne de celui-ci.

## 6. Acces depuis le reseau local

L'application ecoute sur le port `8080` de la machine hote. Les postes y
accedent par `http://<ip-du-serveur>:8080`.

- **Adresse IP fixe** : indispensable, sinon l'adresse change au redemarrage.
- **Pare-feu** : autoriser le port 8080 en entree
  (`sudo ufw allow 8080/tcp` sur Ubuntu).
- **Nom interne** : ajoutez `192.168.1.50  erp.usine.local` au DNS local ou aux
  fichiers `hosts` des postes pour une adresse plus lisible.
- **Tablettes d'atelier** : ouvrir `http://<ip>:8080`, se connecter, puis
  « Ajouter a l'ecran d'accueil » pour un acces en un geste.

### Mettre l'application en HTTPS (optionnel)

En reseau local ferme, HTTP suffit generalement. Si la politique interne exige
HTTPS, placez un reverse proxy (nginx, Caddy, Traefik) devant le port 8080 avec
un certificat interne. Aucune modification de l'application n'est necessaire :
l'interface appelle l'API par des chemins relatifs.

## 7. En cas de probleme

| Symptome | Verification |
|---|---|
| `./installer.sh` : « Le service Docker n'est pas demarre » | `sudo systemctl start docker`, puis verifier que l'utilisateur est dans le groupe `docker` |
| La page ne s'affiche pas depuis un poste | Pare-feu du serveur, adresse IP, `docker compose ps` (les trois services doivent etre « running ») |
| « Identifiants invalides » a la premiere connexion | Recuperer les identifiants : `docker compose logs api \| grep -A4 "COMPTE ADMINISTRATEUR"` |
| « Donnees invalides » sur l'adresse a la connexion | `ADMIN_EMAIL` doit comporter un domaine avec extension (`admin@usine.local`, pas `admin@usine`) ; l'amorcage signale et corrige ce cas dans les journaux |
| Le changement de mot de passe initial est refuse | Le message precise la cause ; verifier notamment l'absence d'espaces en debut ou fin de la valeur copiee depuis le terminal |
| Les documents PDF ne s'ouvrent pas | `docker compose logs api` ; en l'absence du moteur de rendu, les documents restent imprimables en HTML |
| Lenteur generale | `docker stats` ; la base de donnees est le premier poste a surveiller |
| Repartir de zero (installation de test) | `docker compose down -v` **efface toutes les donnees**, puis `./installer.sh` |

Pour un diagnostic complet a transmettre au support :

```bash
docker compose ps > diagnostic.txt
docker compose logs --tail=200 >> diagnostic.txt
```
