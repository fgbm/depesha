#!/usr/bin/env bash
# Тест хука scripts/hooks/pre-commit: временный репозиторий, временный файл
# шаблонов с безобидным словом. Коммит с этим словом блокируется, без него
# проходит, при отсутствии файла шаблонов проходит.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
hook="$here/pre-commit"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

patterns="$tmp/patterns"
printf '# комментарий\nneedle\n' > "$patterns"

repo="$tmp/repo"
git init -q "$repo"
cd "$repo"
git config user.email test@example.com
git config user.name test

fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. Слово в содержимом — коммит блокируется, файл назван, шаблон не напечатан.
printf 'тут есть needle слово\n' > a.txt
git add a.txt
if DEPESHA_PRIVATE_PATTERNS="$patterns" "$hook" >out 2>&1; then
  fail "хук не заблокировал коммит со словом в содержимом"
fi
grep -q 'a.txt' out || fail "хук не назвал файл со словом"
if grep -q 'needle' out; then fail "хук напечатал сам шаблон"; fi
git rm -q --cached a.txt
rm a.txt

# 2. Чистое содержимое — коммит проходит.
printf 'чистый текст\n' > b.txt
git add b.txt
DEPESHA_PRIVATE_PATTERNS="$patterns" "$hook" >out 2>&1 \
  || fail "хук заблокировал чистый коммит"
git rm -q --cached b.txt
rm b.txt

# 3. Слово в имени файла — коммит блокируется.
printf 'ok\n' > needle.c
git add needle.c
if DEPESHA_PRIVATE_PATTERNS="$patterns" "$hook" >out 2>&1; then
  fail "хук не заблокировал слово в имени файла"
fi
grep -q 'needle.c' out || fail "хук не назвал файл по имени"
git rm -q --cached needle.c
rm needle.c

# 4. Нет файла шаблонов — коммит проходит даже со словом.
printf 'needle снова\n' > d.txt
git add d.txt
DEPESHA_PRIVATE_PATTERNS="$tmp/нет-такого" "$hook" >out 2>&1 \
  || fail "хук без файла шаблонов должен пропускать коммит"

echo "pre-commit hook: ok"
