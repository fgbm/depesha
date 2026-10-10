#!/usr/bin/env bash
# Сверка baseline ветки с baseline в main: `--save` поднимает baseline молча, а здесь
# повышение значения метрики и новый член app.* без строки в файле исключений роняют проверку.
#
#   scripts/frontend-baseline-guard.sh              против origin/main
#   scripts/frontend-baseline-guard.sh REF          против REF (ветка, тег, коммит)
#   scripts/frontend-baseline-guard.sh --from DIR   против файлов из DIR
#                                                   (frontend-metrics-baseline.txt, app-members.txt, app-nested.txt)
#
# На main и на ветке, равной main, роста нет по определению. Исключения —
# docs/frontend-metrics-exceptions.txt и docs/frontend-invariants/exceptions.txt.
set -euo pipefail
cd "$(dirname "$0")/.."

ref="origin/main"
from=""
case "${1:-}" in
  --from) from="${2:?--from DIR}" ;;
  -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) ref="$1" ;;
esac

if [[ -z $from ]]; then
  git rev-parse --verify -q "$ref^{commit}" >/dev/null || {
    echo "нет $ref: git fetch origin main" >&2
    exit 1
  }
  from=$(mktemp -d)
  trap 'rm -rf "$from"' EXIT
  git show "$ref:docs/frontend-metrics-baseline.txt" > "$from/frontend-metrics-baseline.txt"
  git show "$ref:docs/frontend-invariants/app-members.txt" > "$from/app-members.txt"
  # Файла второго уровня в main может ещё не быть.
  git show "$ref:docs/frontend-invariants/app-nested.txt" > "$from/app-nested.txt" 2>/dev/null || rm -f "$from/app-nested.txt"
  # Определение app_nested() в main: изменилось в ветке — baseline второго уровня пересобран с ним.
  git show "$ref:scripts/frontend-invariants.sh" > "$from/frontend-invariants.sh"
fi

scripts/frontend-metrics.sh --diff "$from/frontend-metrics-baseline.txt" docs/frontend-metrics-baseline.txt
scripts/frontend-invariants.sh --guard "$from"
