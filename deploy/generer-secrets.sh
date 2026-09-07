#!/usr/bin/env bash
#
# Génère les secrets de production et écrit un `.env.prod` prêt à compléter.
#
# À exécuter SUR LE SERVEUR, une seule fois. Le fichier produit ne doit jamais
# être commité ni transiter par un canal de messagerie.
#
#   ./deploy/generer-secrets.sh exemple.fr exploitation@exemple.fr
#
set -euo pipefail

DOMAINE="${1:-}"
COURRIEL="${2:-}"

if [[ -z "$DOMAINE" || -z "$COURRIEL" ]]; then
  echo "Usage : $0 <domaine> <courriel-pour-lets-encrypt>" >&2
  echo "Exemple : $0 exemple.fr exploitation@exemple.fr" >&2
  exit 1
fi

CIBLE=".env.prod"

# Refus explicite plutôt qu'écrasement : régénérer par mégarde le poivre des
# badges rendrait TOUS les badges du parc introuvables, et la sauvegarde de la
# base ne suffirait pas à réparer.
if [[ -e "$CIBLE" ]]; then
  echo "ERREUR : $CIBLE existe déjà." >&2
  echo "Le régénérer changerait BADGE_HMAC_PEPPER et rendrait tous les badges" >&2
  echo "existants introuvables. Éditez le fichier à la main, ou déplacez-le" >&2
  echo "après en avoir fait une copie sûre." >&2
  exit 1
fi

hex() { openssl rand -hex "$1"; }
motdepasse() { openssl rand -base64 30 | tr -d '/+=' | head -c 32; }

PG_PASS="$(motdepasse)"
REDIS_PASS="$(motdepasse)"
ADMIN_PASS="$(openssl rand -base64 18 | tr -d '/+=')"

sed \
  -e "s|^PUBLIC_DOMAIN=.*|PUBLIC_DOMAIN=${DOMAINE}|" \
  -e "s|^ACME_EMAIL=.*|ACME_EMAIL=${COURRIEL}|" \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${PG_PASS}|" \
  -e "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://phonecontrol:${PG_PASS}@postgres:5432/phonecontrol?schema=public|" \
  -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=${REDIS_PASS}|" \
  -e "s|^REDIS_URL=.*|REDIS_URL=redis://:${REDIS_PASS}@redis:6379|" \
  -e "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$(hex 64)|" \
  -e "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$(hex 64)|" \
  -e "s|^DEVICE_JWT_SECRET=.*|DEVICE_JWT_SECRET=$(hex 64)|" \
  -e "s|^BADGE_HMAC_PEPPER=.*|BADGE_HMAC_PEPPER=$(hex 32)|" \
  -e "s|^DEVICE_MASTER_KEY=.*|DEVICE_MASTER_KEY=$(hex 32)|" \
  -e "s|^CORS_ORIGINS=.*|CORS_ORIGINS=https://admin.${DOMAINE}|" \
  -e "s|^DASHBOARD_URL=.*|DASHBOARD_URL=https://admin.${DOMAINE}|" \
  -e "s|^SMTP_FROM=.*|SMTP_FROM=phone-control@${DOMAINE}|" \
  -e "s|^SEED_SUPER_ADMIN_EMAIL=.*|SEED_SUPER_ADMIN_EMAIL=${COURRIEL}|" \
  -e "s|^SEED_SUPER_ADMIN_PASSWORD=.*|SEED_SUPER_ADMIN_PASSWORD=${ADMIN_PASS}|" \
  .env.prod.example > "$CIBLE"

chmod 600 "$CIBLE"

cat <<MESSAGE

  $CIBLE écrit, permissions 600.

  Compte super-administrateur, à utiliser pour la première connexion :

      ${COURRIEL}
      ${ADMIN_PASS}

  Changez ce mot de passe dès la première connexion, puis videz les deux
  lignes SEED_* du fichier.

  ------------------------------------------------------------------------
  À FAIRE MAINTENANT, avant toute mise en service
  ------------------------------------------------------------------------

  Sauvegardez ces deux valeurs AILLEURS que sur ce serveur, dans un
  gestionnaire de mots de passe ou un coffre :

MESSAGE

grep -E '^(BADGE_HMAC_PEPPER|DEVICE_MASTER_KEY)=' "$CIBLE" | sed 's/^/      /'

cat <<'MESSAGE'

  Une sauvegarde de la base SANS ces valeurs ne permet de restaurer aucun
  badge : les numéros ne sont stockés que sous forme d'empreinte, et
  l'empreinte dépend du poivre. C'est le point de défaillance le plus
  discret de toute l'installation.

MESSAGE
