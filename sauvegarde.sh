#!/usr/bin/env bash
# =====================================================================
# Sauvegarde complete : base de donnees + certificats d'analyse.
# Les archives sont deposees dans ./sauvegardes.
#
#   ./sauvegarde.sh                  sauvegarde
#   ./sauvegarde.sh --restaurer FIC  restauration d une sauvegarde
# =====================================================================
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f .env ] && set -a && . ./.env && set +a

horodatage="$(date +%Y%m%d-%H%M%S)"
dossier="sauvegardes"
mkdir -p "$dossier"

if [ "${1:-}" = "--restaurer" ]; then
  archive="${2:?Usage: ./sauvegarde.sh --restaurer sauvegardes/erp-AAAAMMJJ-HHMMSS.dump}"
  [ -f "$archive" ] || { echo "Archive introuvable : $archive" >&2; exit 1; }
  printf 'Restauration de %s — les donnees actuelles seront remplacees. Continuer ? [oui/non] ' "$archive"
  read -r reponse; [ "$reponse" = "oui" ] || { echo "Abandon."; exit 0; }
  docker compose stop api web
  docker compose exec -T db pg_restore --clean --if-exists --no-owner \
    -U "${POSTGRES_USER:-erp}" -d "${POSTGRES_DB:-erp_derma}" < "$archive"
  fichiers="${archive%.dump}-fichiers.tar.gz"
  if [ -f "$fichiers" ]; then
    docker compose run --rm -T -v "$(pwd)/$fichiers:/restauration.tar.gz:ro" \
      api sh -c 'cd /app/uploads && tar xzf /restauration.tar.gz'
  fi
  docker compose start api web
  echo "Restauration terminee."
  exit 0
fi

archive="$dossier/erp-$horodatage.dump"
docker compose exec -T db pg_dump --format=custom --no-owner \
  -U "${POSTGRES_USER:-erp}" "${POSTGRES_DB:-erp_derma}" > "$archive"
docker compose exec -T api sh -c 'cd /app/uploads && tar czf - .' > "$dossier/erp-$horodatage-fichiers.tar.gz"

echo "Sauvegarde : $archive"
echo "             $dossier/erp-$horodatage-fichiers.tar.gz"

# Retention : 30 sauvegardes les plus recentes
ls -1t "$dossier"/erp-*.dump 2>/dev/null | tail -n +31 | xargs -r rm -f
ls -1t "$dossier"/erp-*-fichiers.tar.gz 2>/dev/null | tail -n +31 | xargs -r rm -f
