#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backup_dir="$project_dir/backups"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$backup_dir/quiz-$timestamp.sql"

install -d -m 700 "$backup_dir"
cd "$project_dir"

docker compose exec -T db pg_dump -U quiz_app -d quiz --clean --if-exists > "$backup_file"
gzip "$backup_file"
chmod 600 "$backup_file.gz"

find "$backup_dir" -maxdepth 1 -type f -name 'quiz-*.sql.gz' -mtime +14 -delete
echo "$backup_file.gz"
