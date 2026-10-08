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

# 5. Некорректное регулярное выражение в шаблонах — хук падает, а не пропускает молча.
printf 'bad(\n' > "$patterns"
printf 'ok\n' > e.txt
git add e.txt
if DEPESHA_PRIVATE_PATTERNS="$patterns" "$hook" >out 2>&1; then
  fail "хук пропустил коммит при некорректном шаблоне"
fi
if grep -q 'bad' out; then fail "хук напечатал сам шаблон"; fi
git rm -q --cached e.txt
rm e.txt

# 6. Слово в файле с кириллическим именем — коммит блокируется (имя не экранируется).
printf '# комментарий\nneedle\n' > "$patterns"
printf 'тут есть needle\n' > "файл.txt"
git add "файл.txt"
if DEPESHA_PRIVATE_PATTERNS="$patterns" "$hook" >out 2>&1; then
  fail "хук не нашёл слово в файле с кириллическим именем"
fi
grep -q 'файл.txt' out || fail "хук не назвал файл с кириллическим именем"
git rm -q --cached "файл.txt"
rm "файл.txt"

# 7. Регистр кириллицы сворачивается при -i, а не только латиницы.
printf 'СЕКРЕТ\n' > "$patterns"
printf 'тут секрет\n' > f.txt
git add f.txt
if LC_ALL=C DEPESHA_PRIVATE_PATTERNS="$patterns" "$hook" >out 2>&1; then
  fail "хук не сверил регистр кириллицы"
fi
grep -q 'f.txt' out || fail "хук не назвал файл со словом в другом регистре"
git rm -q --cached f.txt
rm f.txt

echo "pre-commit hook: ok"
