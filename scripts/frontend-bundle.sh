#!/usr/bin/env bash
# Размер главного чанка фронтенда. Тяжёлое (редактор Markdown на CodeMirror, PDF,
# Word, Excel) грузится отдельными чанками по требованию; главный чанк не должен
# вбирать их код и расти без нужды.
#
#   scripts/frontend-bundle.sh           собрать и сравнить с baseline
#   scripts/frontend-bundle.sh --save    собрать и записать baseline
#   scripts/frontend-bundle.sh --print   собрать и напечатать размеры
#
# Регрессия: в главном чанке есть код CodeMirror или lezer, или его gzip вырос
# больше чем на SLACK байт против baseline.
set -euo pipefail
cd "$(dirname "$0")/.."

BASELINE="docs/frontend-bundle-baseline.txt"
SLACK=1024

mode="${1:---check}"
npx vite build --logLevel error >/dev/null

# Главный чанк — тот, что подключает dist/index.html.
main="dist/$(grep -o 'assets/index-[^"]*\.js' dist/index.html | head -1)"
gz() { gzip -9c "$1" | wc -c; }

sizes() {
  printf 'main\t%s\t%s\n' "$(wc -c < "$main")" "$(gz "$main")"
  for f in dist/assets/markdownEditor-*.js; do
    [[ -e "$f" ]] && printf 'markdown-editor\t%s\t%s\n' "$(wc -c < "$f")" "$(gz "$f")"
  done
}

case "$mode" in
  --print) sizes; exit 0 ;;
  --save) sizes > "$BASELINE"; cat "$BASELINE"; exit 0 ;;
  --check) ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac

fail=0
# Классы и имена узлов, без которых CodeMirror и lezer не обходятся.
if grep -q -e 'cm-content' -e 'StrikethroughMark' "$main"; then
  echo "в главном чанке код редактора Markdown: его можно грузить только через import()" >&2
  fail=1
fi
now=$(gz "$main")
was=$(awk -F'\t' '$1 == "main" { print $3 }' "$BASELINE")
if (( now > was + SLACK )); then
  echo "главный чанк вырос: gzip $was → $now байт (допуск $SLACK); если рост оправдан — $0 --save отдельным коммитом" >&2
  fail=1
fi
sizes
exit "$fail"
