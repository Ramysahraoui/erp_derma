#!/usr/bin/env bash
# =====================================================================
# Verifie que le jeu de fichiers copie par backend/Dockerfile suffit a
# compiler l'API, sans construire d'image (utile en environnement sans
# acces au registre, et comme garde-fou en integration continue).
#
#   ./outils/verifier-image-backend.sh
#
# Reproduit l'etage « build » du Dockerfile backend : on ne copie QUE les
# fichiers listes par les instructions COPY, puis on lance « npm run build ».
# Un fichier oublie (cas du bug 1) fait echouer ce script comme il faisait
# echouer « docker compose build ».
set -uo pipefail
racine="$(cd "$(dirname "${BASH_SOURCE[0]}")/../backend" && pwd)"
atelier=$(mktemp -d)
trap 'rm -rf "$atelier"' EXIT

# Extraction des chemins copies dans l'etage de build du Dockerfile.
copies=$(awk '/^FROM .* AS build/{d=1;next} /^FROM /{d=0} d && /^COPY /{ $1=""; NF--; print }' "$racine/Dockerfile")
echo "Fichiers copies par l'etage de build :"
for c in $copies; do echo "   - $c"; done

cd "$atelier"
for chemin in $copies; do
  # Les motifs « package-lock.json* » sont resolus comme dans le contexte Docker.
  for reel in $racine/$chemin; do [ -e "$reel" ] && cp -r "$reel" .; done
done

# npm ci est simule par le lien des dependances deja installees : le registre
# npm n'est pas l'objet du test, le jeu de fichiers copies l'est.
[ -d "$racine/node_modules" ] || { echo "Lancer d'abord « npm --prefix backend install »." >&2; exit 1; }
ln -s "$racine/node_modules" node_modules

echo
echo "Contenu de l'image a l'etape « RUN npm run build » :"
ls -1 | sed 's/^/   /'
echo
echo "Execution de « npm run build » :"
if npm run build 2>&1 | sed 's/^/   /'; then
  [ -f dist/server.js ] && echo "   -> dist/server.js produit" || { echo "   -> ECHEC : dist/server.js absent"; exit 1; }
else
  exit 1
fi
