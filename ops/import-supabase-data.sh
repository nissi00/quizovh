#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Usage : $0 /chemin/vers/supabase-public-data.sql" >&2
  exit 1
fi

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dump_file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
cd "$project_dir"

echo "Cette opération remplace les données de démonstration ou les données actuelles."
read -r -p "Tapez MIGRER pour continuer : " confirmation
[[ "$confirmation" == "MIGRER" ]] || exit 1

bash ops/backup.sh >/dev/null

{
  echo "TRUNCATE auth_sessions,live_answer_submissions,live_answers,session_participants,live_sessions,quiz_attempts,answer_options,questions,quizzes,chapters,themes,grading_policies,app_users CASCADE;"
  cat "$dump_file"
} | docker compose exec -T db psql --single-transaction -v ON_ERROR_STOP=1 -U quiz_app -d quiz

echo "Import terminé. Ouvrez /setup.html pour définir le mot de passe administrateur OVH."
