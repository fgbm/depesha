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

# 8. Строка содержимого, начинающаяся с «++ b/», не путается с заголовком хунка.
printf '# комментарий\nneedle\n' > "$patterns"
printf '++ b/needle\n' > g.txt
git add g.txt
if DEPESHA_PRIVATE_PATTERNS="$patterns" "$hook" >out 2>&1; then
  fail "хук принял «++ b/…» за заголовок и пропустил содержимое"
fi
grep -q 'g.txt' out || fail "хук не назвал файл со строкой «++ b/…»"
git rm -q --cached g.txt
rm g.txt

# 9. Без локали UTF-8 хук отказывает с объяснением, а не проверяет вслепую.
mkdir -p "$tmp/bin"
printf '#!/usr/bin/env bash\necho ANSI_X3.4-1968\n' > "$tmp/bin/locale"
chmod +x "$tmp/bin/locale"
printf '# комментарий\nneedle\n' > "$patterns"
printf 'чисто\n' > h.txt
git add h.txt
if PATH="$tmp/bin:$PATH" LC_ALL= LC_CTYPE= LANG= DEPESHA_PRIVATE_PATTERNS="$patterns" "$hook" >out 2>&1; then
  fail "хук не отказал без локали UTF-8"
fi
grep -q 'UTF-8' out || fail "хук не объяснил отказ из-за локали"
git rm -q --cached h.txt
rm h.txt

# 10. textconv-фильтр не прячет содержимое: хук читает сами байты.
printf '# комментарий\nneedle\n' > "$patterns"
printf 'тут needle\n' > i.txt
printf 'i.txt diff=hide\n' > .gitattributes
printf '#!/usr/bin/env bash\necho redacted\n' > "$tmp/hide.sh"
chmod +x "$tmp/hide.sh"
git config diff.hide.textconv "$tmp/hide.sh"
git add .gitattributes i.txt
if DEPESHA_PRIVATE_PATTERNS="$patterns" "$hook" >out 2>&1; then
  fail "хук прочитал textconv вместо самих байтов"
fi
grep -q 'i.txt' out || fail "хук не нашёл слово под textconv"
git rm -q --cached .gitattributes i.txt
rm .gitattributes i.txt
git config --unset diff.hide.textconv

# 11. Внешний diff-драйвер тоже не подменяет содержимое.
printf '# комментарий\nneedle\n' > "$patterns"
printf 'тут needle\n' > j.txt
printf 'j.txt diff=ext\n' > .gitattributes
printf '#!/usr/bin/env bash\necho redacted\n' > "$tmp/ext.sh"
chmod +x "$tmp/ext.sh"
git config diff.ext.command "$tmp/ext.sh"
git add .gitattributes j.txt
if DEPESHA_PRIVATE_PATTERNS="$patterns" "$hook" >out 2>&1; then
  fail "хук прочитал внешний diff вместо самих байтов"
fi
grep -q 'j.txt' out || fail "хук не нашёл слово под внешним diff"
git rm -q --cached .gitattributes j.txt
rm .gitattributes j.txt
git config --unset diff.ext.command

echo "pre-commit hook: ok"
