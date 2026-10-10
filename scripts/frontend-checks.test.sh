#!/usr/bin/env bash
# Тест проверок scripts/frontend-metrics.sh и scripts/frontend-invariants.sh: рост
# падает, уменьшение проходит, рост с обоснованием проходит, --tighten подтягивает
# вниз и не поднимает. Работает на копиях baseline во временном каталоге.
set -eu
cd "$(dirname "$0")/.."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# --- метрики ----------------------------------------------------------------

m=scripts/frontend-metrics.sh
export METRICS_EXCEPTIONS="$tmp/none.txt"
$m --save "$tmp/base.txt" >/dev/null

# Первая функция с длиной больше 1: из неё делаем «было меньше» (значит, выросла) и «было больше».
key=$(awk -F'\t' '$1 == "function" && $3 > 1 { print $2; exit }' "$tmp/base.txt")
now=$(awk -F'\t' -v k="$key" '$2 == k { print $3 }' "$tmp/base.txt")
[[ -n $key ]] || fail "нет функции для проверки"
setval() { awk -F'\t' -v OFS='\t' -v k="$key" -v v="$1" '$2 == k { $3 = v } { print }' "$tmp/base.txt" > "$2"; }

$m --compare "$tmp/base.txt" >/dev/null || fail "метрики: неизменённый baseline не прошёл"

setval $((now - 1)) "$tmp/grew.txt"
if $m --compare "$tmp/grew.txt" >/dev/null 2>&1; then fail "метрики: рост не пойман"; fi

setval $((now + 5)) "$tmp/shrunk.txt"
$m --compare "$tmp/shrunk.txt" >/dev/null || fail "метрики: уменьшение уронило проверку"

printf 'function\t%s\t%s\tпотому что так надо\n' "$key" "$now" > "$tmp/exc.txt"
METRICS_EXCEPTIONS="$tmp/exc.txt" $m --compare "$tmp/grew.txt" >/dev/null || fail "метрики: рост с обоснованием не прошёл"

printf 'function\t%s\t%s\t\n' "$key" "$now" > "$tmp/exc-nowhy.txt"
if METRICS_EXCEPTIONS="$tmp/exc-nowhy.txt" $m --compare "$tmp/grew.txt" >/dev/null 2>&1; then fail "метрики: исключение без причины принято"; fi

printf 'function\t%s\t%s\tпричина\n' "$key" $((now - 1)) > "$tmp/exc-low.txt"
if METRICS_EXCEPTIONS="$tmp/exc-low.txt" $m --compare "$tmp/grew.txt" >/dev/null 2>&1; then fail "метрики: рост выше предела принят"; fi

# --tighten: уменьшение записывается, рост не записывается.
cp "$tmp/shrunk.txt" "$tmp/t1.txt"
$m --tighten "$tmp/t1.txt" >/dev/null
[[ $(awk -F'\t' -v k="$key" '$2 == k { print $3 }' "$tmp/t1.txt") == "$now" ]] || fail "метрики: --tighten не подтянул вниз"
cp "$tmp/grew.txt" "$tmp/t2.txt"
$m --tighten "$tmp/t2.txt" >/dev/null
[[ $(awk -F'\t' -v k="$key" '$2 == k { print $3 }' "$tmp/t2.txt") == "$((now - 1))" ]] || fail "метрики: --tighten поднял значение"

# --- инварианты -------------------------------------------------------------

i=scripts/frontend-invariants.sh
$i --save "$tmp/inv" >/dev/null
member=$(head -1 "$tmp/inv/app-members.txt")
[[ -n $member ]] || fail "нет члена app.* для проверки"

$i --compare "$tmp/inv" >/dev/null || fail "инварианты: неизменённый baseline не прошёл"

# Новый член: в baseline его нет.
cp -r "$tmp/inv" "$tmp/grew-inv"
sed -i "/^${member}\$/d" "$tmp/grew-inv/app-members.txt"
if $i --compare "$tmp/grew-inv" >/dev/null 2>&1; then fail "инварианты: новый член app.* не пойман"; fi

printf 'app-members\t%s\tпотому что так надо\n' "$member" > "$tmp/grew-inv/exceptions.txt"
$i --compare "$tmp/grew-inv" >/dev/null || fail "инварианты: новый член с обоснованием не прошёл"

printf 'app-members\t%s\t\n' "$member" > "$tmp/grew-inv/exceptions.txt"
if $i --compare "$tmp/grew-inv" >/dev/null 2>&1; then fail "инварианты: исключение без причины принято"; fi

# Исчезнувший член: в baseline есть лишний.
cp -r "$tmp/inv" "$tmp/shrunk-inv"
echo "zzzGone" >> "$tmp/shrunk-inv/app-members.txt"
$i --compare "$tmp/shrunk-inv" >/dev/null || fail "инварианты: исчезновение члена уронило проверку"

# Остальные наборы не требуют «ровно как было».
cp -r "$tmp/inv" "$tmp/other-inv"
echo "zzz.lost.key" >> "$tmp/other-inv/t-keys.txt"
$i --compare "$tmp/other-inv" >/dev/null || fail "инварианты: расхождение ключей t() уронило проверку"

$i --tighten "$tmp/shrunk-inv" >/dev/null
grep -qx zzzGone "$tmp/shrunk-inv/app-members.txt" && fail "инварианты: --tighten не убрал исчезнувший член"
cp -r "$tmp/grew-inv" "$tmp/tight-grew"
$i --tighten "$tmp/tight-grew" >/dev/null
grep -qx "$member" "$tmp/tight-grew/app-members.txt" && fail "инварианты: --tighten добавил новый член"

echo "frontend-checks: ок"
