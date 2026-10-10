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
# Падает только ухудшение, каждое снимается строкой с причиной в DIR/exceptions.txt
# (`вид<TAB>имя<TAB>причина`, пробелы по краям причины не в счёт):
#   app-members   новый член app.*, которого нет в baseline
#   app-nested    новый член app.<контроллер>.* (`ui.toast`, `list.view`), которого нет в baseline
#   aria-attrs    пропавшее имя aria-*
#   roles         пропавшее литеральное значение role=
#   data-kinds    пропавший вид data-*, но только если он встречается в e2e/*.mjs
#   summary       уменьшение счётчика aria_attrs или role_attrs (имя — счётчик)
# Исчезнувший член app.* проходит без пересборки baseline. Ключи t(), остальные
# виды data-* и счётчики только печатаются как разница. Исключение, которое больше
# не нужно, печатается предупреждением. Члены baseline сортируются на лету.
#
# --guard REFDIR [DIR]  сверить членов app.* в DIR с REFDIR (baseline из main):
#                       `--save` поднимает baseline молча, здесь это видно.
# --tighten запускается один раз при слиянии, не в ветке. Рост — только строкой
# в exceptions.txt, `--save` для этого не запускают.
# Только POSIX sh/awk/grep/sort, без нового инструментария.
set -euo pipefail
cd "$(dirname "$0")/.."

DEFAULT_DIR="${INVARIANTS_DIR:-docs/frontend-invariants}"
E2E_DIR="${E2E_DIR:-e2e}"

mode="compare"
dir="$DEFAULT_DIR"
case "${1:-}" in
  ""|--check) mode="compare" ;;
  --print) mode="print" ;;
  --save) mode="save"; dir="${2:-$DEFAULT_DIR}" ;;
  --tighten) mode="tighten"; dir="${2:-$DEFAULT_DIR}" ;;
  --guard) mode="guard"; ref="${2:?--guard REFDIR [DIR]}"; dir="${3:-$DEFAULT_DIR}" ;;
  --compare) mode="compare"; dir="${2:-$DEFAULT_DIR}" ;;
  -h|--help)
    sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
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
# Второй уровень: что компоненты берут у контроллеров напрямую (`ui.toast`, `list.view`, `reader.opened`).
app_nested() { grep -rhoE '\bapp\.(ui|selection|mailboxes|settingsCtl|list|reader|actions|compose|clearing)\.[A-Za-z_][A-Za-z0-9_]*' --include='*.svelte' src | sed 's/^app\.//' | LC_ALL=C sort -u || true; }

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
  app_nested > "$dir/app-nested.txt"
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
  [[ -f "$dir/app-nested.txt" ]] || : > "$dir/app-nested.txt"
  app_nested | LC_ALL=C comm -12 - <(LC_ALL=C sort -u "$dir/app-nested.txt") > "$tmp"
  cp "$tmp" "$dir/app-nested.txt"
  rm -f "$tmp"
  t_keys > "$dir/t-keys.txt"
  role_values > "$dir/roles.txt"
  aria_names > "$dir/aria-attrs.txt"
  data_kinds > "$dir/data-kinds.txt"
  summary > "$dir/summary.txt"
  echo "baseline подтянут: $dir"
  exit 0
fi

# compare / guard
status=0
exc="$dir/exceptions.txt"
usedf=$(mktemp)
trap 'rm -f "$usedf"' EXIT

# Причина исключения (без пробелов по краям); пусто, если исключения нет или причины нет.
exc_reason() {
  printf '%s\t%s\n' "$1" "$2" >> "$usedf"
  [[ -f "$exc" ]] || return 0
  awk -F'\t' -v k="$1" -v n="$2" '$1 == k && $2 == n { r = $3; sub(/^[ \t]+/, "", r); sub(/[ \t]+$/, "", r); print r; exit }' "$exc"
}

# Предупреждение об исключениях видов $@, которые ничего не оправдали.
warn_stale() {
  [[ -f "$exc" ]] || return 0
  local kind name
  while IFS=$'\t' read -r kind name _; do
    [[ -z $kind || $kind == \#* ]] && continue
    printf '%s\n' "$@" | grep -qxF -- "$kind" || continue
    grep -qxF -- "$kind"$'\t'"$name" "$usedf" || echo "предупреждение: исключение не нужно: $kind $name"
  done < "$exc"
}

sorted_file() { LC_ALL=C sort -u "$1"; }

# Новые строки now против base требуют исключения вида $1; $2 — как называть в сообщении.
require_exception() {
  local kind="$1" label="$2" name why
  while IFS= read -r name; do
    [[ -z $name ]] && continue
    why=$(exc_reason "$kind" "$name")
    if [[ -n $why ]]; then
      echo "допущено ($label $name): $why"
    else
      echo "РОСТ/ПОТЕРЯ: $label: $name (обоснуйте строкой в $exc: $kind<TAB>$name<TAB>причина; --save не запускайте)" >&2
      status=1
    fi
  done
}

# Члены app.* (kind app-members) и app.ui.*, app.selection.* (kind app-nested):
# рост — ухудшение (компонент тянет больше состояния из App).
check_members() {
  local basef="$1" nowf="$2" kind="${3:-app-members}" b n label="app.*"
  [[ $kind == app-nested ]] && label="app.<контроллер>.*"
  b=$(mktemp); n=$(mktemp)
  sorted_file "$basef" > "$b"; sorted_file "$nowf" > "$n"
  LC_ALL=C comm -23 "$b" "$n" | sed "s/^/исчезло ($label): /"
  require_exception "$kind" "новый член ${label}" < <(LC_ALL=C comm -13 "$b" "$n")
  rm -f "$b" "$n"
}

if [[ "$mode" == guard ]]; then
  [[ -f "$ref/app-members.txt" && -f "$dir/app-members.txt" ]] || { echo "нет app-members.txt в $ref или $dir" >&2; exit 1; }
  check_members "$ref/app-members.txt" "$dir/app-members.txt"
  # Файла второго уровня в main может ещё не быть (его вводит эта проверка): тогда сверять не с чем.
  if [[ -f "$ref/app-nested.txt" && -f "$dir/app-nested.txt" ]]; then
    check_members "$ref/app-nested.txt" "$dir/app-nested.txt" app-nested
  fi
  warn_stale app-members app-nested
  [[ "$status" == 0 ]] && echo "инварианты baseline против main: роста нет"
  exit "$status"
fi

# Печатает набор: имена, которых нет в baseline ($1=new) или которых больше нет ($1=lost).
set_diff() {
  local which="$1" file="$2" gen="$3" tmp base
  tmp=$(mktemp); base=$(mktemp)
  "$gen" > "$tmp"; sorted_file "$file" > "$base"
  if [[ "$which" == new ]]; then LC_ALL=C comm -13 "$base" "$tmp"; else LC_ALL=C comm -23 "$base" "$tmp"; fi
  rm -f "$tmp" "$base"
}

need_file() { [[ -f "$1" ]] || { echo "НЕТ ФАЙЛА: $1" >&2; status=1; return 1; }; }

# Набор с потерей: пропавшее печатается и требует исключения вида $1.
lost_set() {
  local kind="$1" label="$2" file="$3" gen="$4" lost
  need_file "$file" || return 0
  set_diff new "$file" "$gen" | sed "s|^|новое ($label): |"
  lost=$(set_diff lost "$file" "$gen")
  [[ -z $lost ]] && return 0
  sed "s|^|исчезло ($label): |" <<<"$lost"
  require_exception "$kind" "пропало ($label)" <<<"$lost"
}

# Пропавшие виды data-*, которые читает e2e, — потеря; остальные — только разница.
check_data_kinds() {
  local file="$dir/data-kinds.txt" k
  need_file "$file" || return 0
  set_diff new "$file" data_kinds | sed 's/^/новое (data-*): /'
  while IFS= read -r k; do
    [[ -z $k ]] && continue
    echo "исчезло (data-*): $k"
    if grep -rqF --include='*.mjs' -- "$k" "$E2E_DIR" 2>/dev/null; then
      require_exception data-kinds "пропал вид из e2e" <<<"$k"
    fi
  done < <(set_diff lost "$file" data_kinds)
}

# Ключи t() — только информация.
if need_file "$dir/t-keys.txt"; then
  set_diff new "$dir/t-keys.txt" t_keys | sed 's/^/новое (t()): /'
  set_diff lost "$dir/t-keys.txt" t_keys | sed 's/^/исчезло (t()): /'
fi

lost_set aria-attrs "aria-*" "$dir/aria-attrs.txt" aria_names
lost_set roles "role=" "$dir/roles.txt" role_values
check_data_kinds
if need_file "$dir/app-members.txt"; then
  now_members=$(mktemp); app_members > "$now_members"
  check_members "$dir/app-members.txt" "$now_members"
  rm -f "$now_members"
fi
if need_file "$dir/app-nested.txt"; then
  now_nested=$(mktemp); app_nested > "$now_nested"
  check_members "$dir/app-nested.txt" "$now_nested" app-nested
  rm -f "$now_nested"
fi

# Счётчики доступности не убывают.
if [[ -f "$dir/summary.txt" ]]; then
  cur=$(mktemp); summary > "$cur"
  for c in aria_attrs role_attrs; do
    was=$(awk -v n="$c" '$1 == n { print $2 }' "$dir/summary.txt")
    now=$(awk -v n="$c" '$1 == n { print $2 }' "$cur")
    if [[ -n $was && -n $now ]] && (( now < was )); then
      echo "уменьшилось ($c): $was -> $now"
      why=$(exc_reason summary "$c")
      if [[ -n $why ]]; then echo "допущено ($c): $why"
      else
        echo "ПОТЕРЯ: счётчик $c $was -> $now (обоснуйте строкой в $exc: summary<TAB>$c<TAB>причина)" >&2
        status=1
      fi
    fi
  done
  rm -f "$cur"
else
  echo "НЕТ ФАЙЛА: $dir/summary.txt" >&2; status=1
fi

warn_stale app-members app-nested aria-attrs roles data-kinds summary

print_summary
if [[ "$status" == 0 ]]; then
  echo "инварианты: потерь и роста нет"
else
  echo "инварианты: есть рост или потеря без обоснования" >&2
fi
exit "$status"
