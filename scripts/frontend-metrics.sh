#!/usr/bin/env bash
# Метрики фронтенда: размеры компонентов (всего / скрипт / разметка / стиль)
# и самые длинные функции. Повторяет замер из issue #48: границы <script>/<style>
# ищутся awk'ом по строкам.
#
#   scripts/frontend-metrics.sh                 сравнить с baseline (по умолчанию)
#   scripts/frontend-metrics.sh --print         только напечатать текущие метрики
#   scripts/frontend-metrics.sh --save FILE     записать baseline в FILE
#   scripts/frontend-metrics.sh --compare FILE  сравнить с FILE вместо базового
#   scripts/frontend-metrics.sh --tighten [FILE] подтянуть baseline вниз: уменьшившиеся
#                                               значения записать, исчезнувшие убрать,
#                                               новые добавить; выросшие не трогать
#
# Метрики размера — ориентир, не закон. Регрессией считается только рост любого
# размера против baseline (компонент или функция); уменьшение проходит без
# пересборки baseline (её подтягивает --tighten). Рост допускается записью в
# файле исключений (METRICS_EXCEPTIONS, по умолчанию
# docs/frontend-metrics-exceptions.txt): `kind<TAB>имя<TAB>предел<TAB>причина`.
# Причина обязательна, значение выше предела — снова регрессия. Новые и
# исчезнувшие записи печатаются, но не роняют проверку.
# Инструментов не добавляем: только POSIX sh/awk/grep/sort.
set -euo pipefail
cd "$(dirname "$0")/.."

DEFAULT_BASELINE="docs/frontend-metrics-baseline.txt"
EXCEPTIONS="${METRICS_EXCEPTIONS:-docs/frontend-metrics-exceptions.txt}"
TOP_FUNCS=25

mode="compare"
baseline="$DEFAULT_BASELINE"
case "${1:-}" in
  ""|--check) mode="compare" ;;
  --print) mode="print" ;;
  --save) mode="save"; baseline="${2:-$DEFAULT_BASELINE}" ;;
  --tighten) mode="tighten"; baseline="${2:-$DEFAULT_BASELINE}" ;;
  --compare) mode="compare"; baseline="${2:-$DEFAULT_BASELINE}" ;;
  -h|--help)
    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
    exit 0 ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac

# --- компоненты -------------------------------------------------------------

# Печатает: kind \t name \t value. Размеры — как в issue #48:
#   script  = NR(</script>) - NR(<script>)
#   style   = NR(</style>)  - NR(<style>)
#   markup  = всего - script - style
component_metrics() {
  find src -name '*.svelte' | LC_ALL=C sort | while IFS= read -r f; do
    total=$(wc -l < "$f")
    script=$(awk '/<script/{s=NR} /<\/script>/{print NR-s; exit}' "$f")
    # MailFrame держит мини-CSS внутри srcdoc-строки; внешний <style> — последний.
    style=$(awk '/^[[:space:]]*<style/{s=NR} /^[[:space:]]*<\/style>/{v=NR-s} END{print v+0}' "$f")
    script=${script:-0}
    style=${style:-0}
    markup=$((total - script - style))
    printf 'component\t%s\t%s\t%s\t%s\t%s\n' "$f" "$total" "$script" "$markup" "$style"
  done
}

# --- функции ----------------------------------------------------------------

# Длина функций: от строки объявления до закрывающей скобки тела. Приближение
# (brace counting), достаточно устойчивое для регрессионного baseline.
function_metrics() {
  find src plugins -name '*.ts' -o -name '*.svelte.ts' -o -name '*.svelte' | LC_ALL=C sort -u |
  while IFS= read -r f; do
    awk -v file="$f" '
      function name_of(line,   s, n) {
        if (line ~ /^[[:space:]]*(export[[:space:]]+)?(default[[:space:]]+)?(async[[:space:]]+)?function[[:space:]]+[A-Za-z_$]/) {
          s = line; sub(/^[[:space:]]*(export[[:space:]]+)?(default[[:space:]]+)?(async[[:space:]]+)?function[[:space:]]+/, "", s)
          n = s; sub(/[^A-Za-z0-9_$].*$/, "", n); return n
        }
        if (line ~ /^[[:space:]]*(export[[:space:]]+)?const[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*=[[:space:]]*(async[[:space:]]+)?(\(|[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*=>)/) {
          s = line; sub(/^[[:space:]]*(export[[:space:]]+)?const[[:space:]]+/, "", s)
          n = s; sub(/[^A-Za-z0-9_$].*$/, "", n); return n
        }
        return ""
      }
      { code = $0; sub(/\/\/.*$/, "", code); gsub(/"([^"\\]|\\.)*"/, "", code); gsub(/'"'"'([^'"'"']|\\.)*'"'"'/, "", code)
        if (!in_func) {
          nm = name_of(code)
          if (nm != "") { in_func = 1; start = NR; depth = 0; fname = nm }
        }
        if (in_func) {
          o = gsub(/\{/, "{", code); c = gsub(/\}/, "}", code); depth += o - c
          if (depth <= 0 && (o + c) > 0) { n++; fn[n]=fname; fl[n]=NR-start+1; in_func=0 }
          else if (depth <= 0 && (o + c) == 0 && NR > start) { in_func = 0 }
        }
      }
      END {
        # Одноимённые функции (снаружи и внутри) различаем суффиксом #k.
        for (i = 1; i <= n; i++) cnt[fn[i]]++
        for (i = 1; i <= n; i++) {
          key = fn[i]
          if (cnt[key] > 1) { occ[key]++; key = key "#" occ[key] }
          printf "function\t%s::%s\t%d\n", file, key, fl[i]
        }
      }' "$f"
  done
}

# --- сбор -------------------------------------------------------------------

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
component_metrics > "$tmp"
function_metrics >> "$tmp"

print_report() {
  printf '== Компоненты (всего/скрипт/разметка/стиль)\n'
  awk -F'\t' '$1=="component"{printf "%6d  %6d %6d %6d  %s\n", $3, $4, $5, $6, $2}' "$tmp" | sort -rn
  printf '\n== Топ-%d длинных функций\n' "$TOP_FUNCS"
  # `head` here would close the pipe early and make `sort` die of SIGPIPE, failing the
  # whole script under `set -o pipefail` (racy: it passed locally, broke in CI).
  awk -F'\t' '$1=="function"{printf "%6d  %s\n", $3, $2}' "$tmp" | sort -rn | awk -v n="$TOP_FUNCS" 'NR<=n'
}

case "$mode" in
  print)
    print_report
    ;;
  save)
    mkdir -p "$(dirname "$baseline")"
    cp "$tmp" "$baseline"
    echo "baseline записан: $baseline ($(grep -c . "$baseline") записей)"
    print_report
    ;;
  tighten)
    if [[ ! -f "$baseline" ]]; then
      echo "нет baseline: $baseline (создайте: scripts/frontend-metrics.sh --save $baseline)" >&2
      exit 1
    fi
    new=$(mktemp)
    # Строка выбирается целиком: меньший итог — текущая, иначе — из baseline.
    awk -F'\t' -v OFS='\t' '
      NR==FNR { base[$1"\t"$2]=$0; bv[$1"\t"$2]=$3; next }
      { k=$1"\t"$2; if (!(k in base) || $3 < bv[k]) print $0; else print base[k] }
    ' "$baseline" "$tmp" > "$new"
    cp "$new" "$baseline"
    rm -f "$new"
    echo "baseline подтянут: $baseline ($(grep -c . "$baseline") записей)"
    ;;
  compare)
    if [[ ! -f "$baseline" ]]; then
      echo "нет baseline: $baseline (создайте: scripts/frontend-metrics.sh --save $baseline)" >&2
      exit 1
    fi
    print_report
    printf '\n== Сверка с %s\n' "$baseline"
    exc="$EXCEPTIONS"
    [[ -f "$exc" ]] || exc=/dev/null
    # Сравниваем по ключу kind+name; рост значения — регрессия, если его не
    # оправдывает исключение (причина непустая, значение не выше предела).
    awk -F'\t' '
      FILENAME == ARGV[1] {
        if ($0 !~ /^#/ && NF >= 2) { ek=$1"\t"$2; emax[ek]=$3; ewhy[ek]=$4; ehas[ek]=1 }
        next
      }
      FILENAME == ARGV[2] { base[$1"\t"$2]=$3; next }
      {
        k=$1"\t"$2
        if (!(k in base)) { printf "новое:   %-8s %s\n", $1, $2; next }
        if ($3 > base[k]) {
          if ((k in ehas) && ewhy[k] != "" && $3 <= emax[k] + 0) {
            printf "рост допущен: %-8s %s  %d -> %d  (%s)\n", $1, $2, base[k], $3, ewhy[k]
          } else {
            if (k in ehas) printf "исключение не годится (нужны предел не ниже значения и причина): %s\n", $2
            printf "РОСТ:    %-8s %s  %d -> %d\n", $1, $2, base[k], $3; bad=1
          }
        }
        else if ($3 < base[k]) { printf "уменьш.: %-8s %s  %d -> %d\n", $1, $2, base[k], $3 }
        found[k]=1
      }
      END {
        for (k in base) if (!(k in found)) { n=split(k, a, "\t"); printf "удалено: %-8s %s\n", a[1], a[2] }
        exit bad
      }' "$exc" "$baseline" "$tmp"
    echo "метрики: регрессий нет"
    ;;
esac
