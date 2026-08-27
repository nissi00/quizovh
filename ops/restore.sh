#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Usage : $0 /chemin/vers/quiz-sauvegarde.sql.gz" >&2
  exit 1
fi

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backup_file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
cd "$project_dir"

echo "Cette opération remplace les données actuelles."
read -r -p "Tapez RESTAURER pour continuer : " confirmation
[[ "$confirmation" == "RESTAURER" ]] || exit 1

gzip -dc "$backup_file" | docker compose exec -T db psql -v ON_ERROR_STOP=1 -U quiz_app -d quiz
echo "Restauration terminée."
