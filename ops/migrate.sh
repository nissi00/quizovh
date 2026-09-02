#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

shopt -s nullglob
migrations=(db/migrations/*.sql)
if [[ ${#migrations[@]} -eq 0 ]]; then
  echo "Aucune migration à appliquer."
  exit 0
fi

for migration in "${migrations[@]}"; do
  echo "Application de $(basename "$migration")"
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U quiz_app -d quiz < "$migration"
done

echo "Migrations PostgreSQL terminées."
