#!/usr/bin/env bash
# Снимок инвариантов фронтенда (issue #48, R3): набор ключей t("…"), литеральные
# значения role=, имена и число атрибутов role=/aria-*, виды data-*, набор членов
# app.*, используемых компонентами, и число компонентов. Служит для проверки, что
# рефакторинг фаз 1–5 ничего не потерял (AC5, AC8).
#
#   scripts/frontend-invariants.sh                 сравнить с baseline (по умолчанию)
#   scripts/frontend-invariants.sh --print         напечатать текущую сводку
#   scripts/frontend-invariants.sh --save [DIR]    записать baseline в DIR
#   scripts/frontend-invariants.sh --compare [DIR] сравнить с DIR
#   scripts/frontend-invariants.sh --tighten [DIR] убрать из baseline исчезнувшие члены
#                                                  app.* и обновить остальные наборы
#
# Падает только ухудшение: новый член app.*, которого нет в baseline и нет в
# DIR/exceptions.txt (`app-members<TAB>имя<TAB>причина`, причина обязательна).
# Исчезнувший член проходит без пересборки baseline (--tighten подтягивает его).
# Остальные наборы (ключи t(), role=, aria-*, data-*) и счётчики только
# печатаются как разница, не роняя проверку: «ровно как было» не требуется.
# Только POSIX sh/awk/grep/sort, без нового инструментария.
set -euo pipefail
cd "$(dirname "$0")/.."

DEFAULT_DIR="docs/frontend-invariants"

mode="compare"
dir="$DEFAULT_DIR"
case "${1:-}" in
  ""|--check) mode="compare" ;;
  --print) mode="print" ;;
  --save) mode="save"; dir="${2:-$DEFAULT_DIR}" ;;
  --tighten) mode="tighten"; dir="${2:-$DEFAULT_DIR}" ;;
  --compare) mode="compare"; dir="${2:-$DEFAULT_DIR}" ;;
  -h|--help)
    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
    exit 0 ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac

# Строки исходников: только компоненты ядра (как в issue #48). Плагины не входят.
files() { find src -name '*.svelte' | LC_ALL=C sort; }

# --- наборы -----------------------------------------------------------------

# Ключи t()/tn() с литеральным аргументом. Класс без кавычки-ограничителя не
# даёт жадному grep'у перескочить на соседний вызов в той же строке.
t_keys() {
  {
    grep -rhoE "\\b(t|tn)\\(\"[^\"]*\"" --include='*.svelte' src || true
    grep -rhoE "\\b(t|tn)\\('[^']*'" --include='*.svelte' src || true
  } | sed -E "s/^[a-z]+\([\"']//; s/[\"']$//" | LC_ALL=C sort -u
}
role_values() { grep -rhoE '\brole="[^"]+"' --include='*.svelte' src | sed -E 's/^role="//; s/"$//' | LC_ALL=C sort -u || true; }
aria_names() { grep -rhoE '\baria-[a-z-]+=' --include='*.svelte' src | sed 's/=$//' | LC_ALL=C sort -u || true; }
data_kinds() { grep -rhoE '\bdata-[a-z-]+' --include='*.svelte' src | LC_ALL=C sort -u || true; }
app_members() { grep -rhoE '\bapp\.[A-Za-z_][A-Za-z0-9_]*' --include='*.svelte' src | sed 's/^app\.//' | LC_ALL=C sort -u || true; }

# --- счётчики ---------------------------------------------------------------

count() { wc -l | tr -d ' '; }
role_attr_count() { grep -rhoE '\brole=' --include='*.svelte' src | count || true; }
aria_attr_count() { grep -rhoE '\baria-[a-z-]+=' --include='*.svelte' src | count || true; }
component_count() { files | count; }

summary() {
  local ncomp nt nrole naria nkinds nrv nan ndk nam
  ncomp=$(component_count)
  nt=$(t_keys | count)
  nrole=$(role_attr_count)
  naria=$(aria_attr_count)
  nkinds=$({ grep -rhoE '\brole=' --include='*.svelte' src | sed 's/=//' || true; aria_names; } | LC_ALL=C sort -u | count)
  nrv=$(role_values | count)
  nan=$(aria_names | count)
  ndk=$(data_kinds | count)
  nam=$(app_members | count)
  cat <<EOF
# Снимок инвариантов фронтенда. Регенерация: scripts/frontend-invariants.sh --save
components $ncomp
t_keys $nt
role_attrs $nrole
aria_attrs $naria
role_aria_attrs $((nrole + naria))
role_aria_kinds $nkinds
role_values $nrv
aria_names $nan
data_kinds $ndk
app_members $nam
EOF
}

print_summary() {
  summary | grep -v '^#'
  echo
  printf 'role= (литеральные значения):\n'; role_values | tr '\n' ' '; echo
  echo
  printf 'виды data-*: '; data_kinds | tr '\n' ' '; echo
}

# --- запись / сверка --------------------------------------------------------

if [[ "$mode" == save ]]; then
  mkdir -p "$dir"
  t_keys > "$dir/t-keys.txt"
  role_values > "$dir/roles.txt"
  aria_names > "$dir/aria-attrs.txt"
  data_kinds > "$dir/data-kinds.txt"
  app_members > "$dir/app-members.txt"
  summary > "$dir/summary.txt"
  echo "baseline записан: $dir"
  print_summary
  exit 0
fi

if [[ "$mode" == print ]]; then
  print_summary
  exit 0
fi

if [[ ! -d "$dir" ]]; then
  echo "нет baseline: $dir (создайте: scripts/frontend-invariants.sh --save $dir)" >&2
  exit 1
fi

if [[ "$mode" == tighten ]]; then
  tmp=$(mktemp)
  # Члены app.*: только пересечение с текущими; новые не добавляются (их судит исключение).
  app_members | LC_ALL=C comm -12 - "$dir/app-members.txt" > "$tmp"
  cp "$tmp" "$dir/app-members.txt"
  rm -f "$tmp"
  t_keys > "$dir/t-keys.txt"
  role_values > "$dir/roles.txt"
  aria_names > "$dir/aria-attrs.txt"
  data_kinds > "$dir/data-kinds.txt"
  summary > "$dir/summary.txt"
  echo "baseline подтянут: $dir"
  exit 0
fi

# compare
status=0
exc="$dir/exceptions.txt"

# Разница набора с baseline: что добавилось и что пропало. Не роняет проверку.
info_set() {
  local name="$1" file="$2" gen="$3" tmp
  [[ -f "$file" ]] || return 0
  tmp=$(mktemp)
  "$gen" > "$tmp"
  LC_ALL=C comm -13 "$file" "$tmp" | sed "s|^|новое ($name): |"
  LC_ALL=C comm -23 "$file" "$tmp" | sed "s|^|исчезло ($name): |"
  rm -f "$tmp"
}

info_set "ключ t()/tn()" "$dir/t-keys.txt"     t_keys
info_set "role="         "$dir/roles.txt"      role_values
info_set "aria-*"        "$dir/aria-attrs.txt" aria_names
info_set "data-*"        "$dir/data-kinds.txt" data_kinds

# Члены app.*: рост — ухудшение (компонент тянет больше состояния из App).
if [[ ! -f "$dir/app-members.txt" ]]; then
  echo "НЕТ ФАЙЛА: $dir/app-members.txt" >&2; status=1
else
  tmp=$(mktemp)
  app_members > "$tmp"
  LC_ALL=C comm -23 "$dir/app-members.txt" "$tmp" | sed 's/^/исчезло (app.*): /'
  while IFS= read -r m; do
    why=""
    if [[ -f "$exc" ]]; then
      why=$(awk -F'\t' -v m="$m" '$1 == "app-members" && $2 == m { print $3; exit }' "$exc")
    fi
    if [[ -n "$why" ]]; then
      echo "рост допущен (app.$m): $why"
    else
      echo "РОСТ: новый член app.$m (обоснуйте строкой в $exc: app-members<TAB>$m<TAB>причина)" >&2
      status=1
    fi
  done < <(LC_ALL=C comm -13 "$dir/app-members.txt" "$tmp")
  rm -f "$tmp"
fi

if [[ "$status" == 0 ]]; then
  echo "инварианты: роста нет"
  print_summary
else
  echo "инварианты: есть рост без обоснования" >&2
fi
exit "$status"
