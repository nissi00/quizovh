#!/usr/bin/env bash
# Deploy this survey-only upgrade on an existing quiz-app installation.
set -Eeuo pipefail
umask 077

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

# Build first: a build failure leaves the running application and database untouched.
docker compose build api

mkdir -p backups
survey_backup="backups/quiz-before-survey-types-$(date -u +%Y%m%d-%H%M%S).sql.gz"
docker compose exec -T db pg_dump -U quiz_app -d quiz --clean --if-exists | gzip > "$survey_backup"
gzip -t "$survey_backup"
echo "Sauvegarde créée : $project_dir/$survey_backup"

docker compose exec -T db psql -v ON_ERROR_STOP=1 -U quiz_app -d quiz \
  < db/migrations/20261030_01_satisfaction_questionnaire_types.sql

# Only the API image changes; the database and Caddy containers stay in place.
docker compose up -d --no-deps api
docker compose ps
