#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker n'est pas installé." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose n'est pas disponible." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  read -r -p "Nom de domaine (laisser vide pour tester avec l'adresse IP) : " domain
  if [[ -n "$domain" && ! "$domain" =~ ^[A-Za-z0-9.-]+$ ]]; then
    echo "Nom de domaine invalide." >&2
    exit 1
  fi

  postgres_password="$(openssl rand -hex 32)"
  setup_token="$(openssl rand -hex 24)"
  if [[ -n "$domain" ]]; then
    site_address="$domain"
    cookie_secure="true"
  else
    site_address=":80"
    cookie_secure="false"
  fi

  umask 077
  {
    echo "SITE_ADDRESS=$site_address"
    echo "COOKIE_SECURE=$cookie_secure"
    echo "POSTGRES_PASSWORD=$postgres_password"
    echo "SETUP_TOKEN=$setup_token"
  } > .env
  chmod 600 .env
else
  setup_token="$(sed -n 's/^SETUP_TOKEN=//p' .env | head -n 1)"
  site_address="$(sed -n 's/^SITE_ADDRESS=//p' .env | head -n 1)"
fi

docker compose config --quiet
docker compose up -d --build

echo "Attente du démarrage de l'application..."
application_ready="false"
for _ in $(seq 1 30); do
  if docker compose exec -T api node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    application_ready="true"
    break
  fi
  sleep 2
done

docker compose ps

if [[ "$application_ready" != "true" ]]; then
  echo "L'application n'est pas devenue disponible. Journaux de l'API :" >&2
  docker compose logs --tail=100 api >&2
  exit 1
fi

if [[ "$site_address" == ":80" ]]; then
  server_ip="$(hostname -I | awk '{print $1}')"
  application_url="http://$server_ip"
else
  application_url="https://$site_address"
fi

echo
echo "Application : $application_url"
echo "Installation administrateur : $application_url/setup.html"
echo "Jeton d'installation : $setup_token"
echo
echo "Conservez le jeton dans un gestionnaire de mots de passe et ne le partagez pas."
