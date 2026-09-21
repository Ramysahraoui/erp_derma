#!/usr/bin/env bash
# =====================================================================
# ERP / MES dermo-cosmetique — installation sur un serveur local
#
#   ./installer.sh
#
# Le script verifie Docker, genere les secrets, construit les images,
# demarre les services et affiche l'adresse d'acces ainsi que les
# identifiants du compte administrateur.
# =====================================================================
set -euo pipefail

racine="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$racine"

vert=$'\033[0;32m'; rouge=$'\033[0;31m'; jaune=$'\033[0;33m'; gras=$'\033[1m'; fin=$'\033[0m'
info()    { printf '%s\n' "  $1"; }
etape()   { printf '\n%s%s%s\n' "$gras" "$1" "$fin"; }
succes()  { printf '%s✔%s %s\n' "$vert" "$fin" "$1"; }
echec()   { printf '%s✘%s %s\n' "$rouge" "$fin" "$1" >&2; exit 1; }

printf '\n%s================================================================%s\n' "$gras" "$fin"
printf '%s  ERP / MES dermo-cosmetique — installation%s\n' "$gras" "$fin"
printf '%s================================================================%s\n' "$gras" "$fin"

# --------------------------------------------------------------- 1/5
etape "1/5  Verification des prerequis"
command -v docker >/dev/null 2>&1 || echec "Docker n'est pas installe. Voir https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || echec "Le plugin « docker compose » est absent (Docker 20.10+ requis)."
docker info >/dev/null 2>&1 || echec "Le service Docker n'est pas demarre, ou l'utilisateur courant n'a pas les droits (voir « sudo usermod -aG docker \$USER »)."
succes "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '') operationnel"

# --------------------------------------------------------------- 2/5
etape "2/5  Configuration"
secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

if [ -f .env ]; then
  succes "Fichier .env existant conserve"
else
  cp .env.exemple .env
  motdepasse_bd="$(secret)"
  jeton="$(secret)"
  # Portable BSD/GNU : on reecrit via un fichier temporaire.
  tmp="$(mktemp)"
  sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${motdepasse_bd}|" \
      -e "s|^JWT_SECRET=.*|JWT_SECRET=${jeton}|" .env > "$tmp" && mv "$tmp" .env
  chmod 600 .env
  succes "Fichier .env cree avec des secrets aleatoires"
  info "Renseignez si besoin le nom et les coordonnees de la societe dans .env,"
  info "puis relancez ce script (les documents imprimes reprennent ces informations)."
fi

port_web="$(grep -E '^PORT_WEB=' .env | cut -d= -f2)"
port_web="${port_web:-8080}"

# --------------------------------------------------------------- 3/5
etape "3/5  Construction des images (quelques minutes la premiere fois)"
docker compose build --pull
succes "Images construites"

# --------------------------------------------------------------- 4/5
etape "4/5  Demarrage des services"
docker compose up -d
succes "Services demarres"

printf '  Attente de la disponibilite de l application'
pret=0
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${port_web}/" >/dev/null 2>&1; then pret=1; break; fi
  printf '.'; sleep 2
done
printf '\n'
[ "$pret" = "1" ] || { docker compose logs --tail=40; echec "L'application n'a pas demarre. Journaux ci-dessus."; }
succes "Application disponible"

# --------------------------------------------------------------- 5/5
etape "5/5  Compte administrateur"
identifiants="$(docker compose logs api 2>/dev/null | grep -A3 'MOT DE PASSE ADMINISTRATEUR GENERE' || true)"
if [ -n "$identifiants" ]; then
  docker compose logs api 2>/dev/null | sed -n '/MOT DE PASSE ADMINISTRATEUR GENERE/,/└/p' | sed 's/^[^|┌├└]*//'
  printf '%s  Notez ce mot de passe : il n apparait qu une seule fois.%s\n' "$jaune" "$fin"
else
  info "Compte administrateur deja initialise (voir .env : ADMIN_EMAIL)."
fi

adresse_ip="$( (hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || echo '') | awk '{print $1}')"
printf '\n%s================================================================%s\n' "$gras" "$fin"
succes "Installation terminee"
printf '\n'
info "Acces depuis ce poste      : http://localhost:${port_web}"
[ -n "$adresse_ip" ] && info "Acces depuis le reseau local : http://${adresse_ip}:${port_web}"
printf '\n'
info "Journaux          : docker compose logs -f"
info "Arret             : docker compose stop"
info "Redemarrage       : docker compose start"
info "Sauvegarde        : ./sauvegarde.sh"
info "Mise a jour       : git pull && ./installer.sh"
printf '%s================================================================%s\n\n' "$gras" "$fin"
