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

# Второй уровень: app.ui.* и app.selection.* (#140). Новый `app.ui.newThing` падает.
nested=$(head -1 "$tmp/inv/app-nested.txt")
[[ -n $nested ]] || fail "нет члена app.ui/selection.* для проверки"
cp -r "$tmp/inv" "$tmp/grew-nested"
sed -i "/^${nested}\$/d" "$tmp/grew-nested/app-nested.txt"
if INVARIANTS_DIR="$tmp/grew-nested" $i --check >/dev/null 2>&1; then fail "инварианты: новый app.ui/selection.* не пойман"; fi
printf 'app-nested\t%s\tпотому что так надо\n' "$nested" > "$tmp/grew-nested/exceptions.txt"
INVARIANTS_DIR="$tmp/grew-nested" $i --check >/dev/null || fail "инварианты: новый app.ui/selection.* с обоснованием не прошёл"
cp -r "$tmp/inv" "$tmp/shrunk-nested"
echo "ui.zzzGone" >> "$tmp/shrunk-nested/app-nested.txt"
$i --compare "$tmp/shrunk-nested" >/dev/null || fail "инварианты: исчезновение app.ui.* уронило проверку"
$i --tighten "$tmp/shrunk-nested" >/dev/null
grep -qx "ui.zzzGone" "$tmp/shrunk-nested/app-nested.txt" && fail "инварианты: --tighten не убрал исчезнувший app.ui.*"
cp -r "$tmp/inv" "$tmp/tight-nested"
sed -i "/^${nested}\$/d" "$tmp/tight-nested/app-nested.txt"
$i --tighten "$tmp/tight-nested" >/dev/null
grep -qx "$nested" "$tmp/tight-nested/app-nested.txt" && fail "инварианты: --tighten добавил новый app.ui/selection.*"

# --- 0.8.1: ревью #141 -------------------------------------------------------

# Метрики: перенос с раздуванием. Новый component больше максимума baseline или суммы
# удалённых в том же прогоне — РОСТ; перенос без раздувания проходит.
comp=$(awk -F'\t' '$1 == "component" { print $3 "\t" $2 }' "$tmp/base.txt" | LC_ALL=C sort -n | awk -F'\t' '{ a[NR] = $2 } END { print a[int(NR / 2)] }')
ctotal=$(awk -F'\t' -v k="$comp" '$2 == k { print $3 }' "$tmp/base.txt")
(( ctotal > 10 )) || fail "нет компонента для проверки переноса"
rename() { awk -F'\t' -v OFS='\t' -v k="$comp" -v v="$1" '$2 == k { $2 = "src/zzz-Old.svelte"; $3 = v } { print }' "$tmp/base.txt" > "$2"; }

rename $((ctotal - 10)) "$tmp/moved-small.txt"
if $m --compare "$tmp/moved-small.txt" >/dev/null 2>&1; then fail "метрики: перенос с раздуванием не пойман"; fi
rename $((ctotal + 10)) "$tmp/moved-same.txt"
$m --compare "$tmp/moved-same.txt" >/dev/null || fail "метрики: перенос без раздувания уронил проверку"
printf 'component\t%s\t%s\tперенос с доработкой\n' "$comp" "$ctotal" > "$tmp/exc-move.txt"
METRICS_EXCEPTIONS="$tmp/exc-move.txt" $m --compare "$tmp/moved-small.txt" >/dev/null || fail "метрики: перенос с исключением не прошёл"

maxc=$(awk -F'\t' '$1 == "component" && $3 > m { m = $3; k = $2 } END { print k }' "$tmp/base.txt")
awk -F'\t' -v k="$maxc" '$2 != k' "$tmp/base.txt" > "$tmp/no-max.txt"
if $m --compare "$tmp/no-max.txt" >/dev/null 2>&1; then fail "метрики: новый компонент больше максимума baseline не пойман"; fi
$m --diff "$tmp/base.txt" "$tmp/base.txt" >/dev/null || fail "метрики: --diff равных файлов не прошёл"
if $m --diff "$tmp/grew.txt" "$tmp/base.txt" >/dev/null 2>&1; then fail "метрики: --diff не поймал рост"; fi

# Исключение, которое больше не нужно, — предупреждение; причина из пробелов — не причина.
out=$(METRICS_EXCEPTIONS="$tmp/exc.txt" $m --compare "$tmp/base.txt" 2>&1) || fail "метрики: лишнее исключение уронило проверку"
grep -q 'не нужно' <<<"$out" || fail "метрики: лишнее исключение не предупреждено"
printf 'function\t%s\t%s\t   \n' "$key" "$now" > "$tmp/exc-blank.txt"
if METRICS_EXCEPTIONS="$tmp/exc-blank.txt" $m --compare "$tmp/grew.txt" >/dev/null 2>&1; then fail "метрики: причина из пробелов принята"; fi
printf 'function\t%s\t%s\t  причина с пробелами  \n' "$key" "$now" > "$tmp/exc-pad.txt"
METRICS_EXCEPTIONS="$tmp/exc-pad.txt" $m --compare "$tmp/grew.txt" >/dev/null || fail "метрики: причина с пробелами по краям не принята"

# --- сверка baseline ветки с main -------------------------------------------

g=scripts/frontend-baseline-guard.sh
mkdir "$tmp/main-ref"
cp docs/frontend-metrics-baseline.txt "$tmp/main-ref/frontend-metrics-baseline.txt"
cp docs/frontend-invariants/app-members.txt "$tmp/main-ref/app-members.txt"
$g --from "$tmp/main-ref" >/dev/null || fail "guard: baseline, равный main, не прошёл"

# baseline ветки выше, чем в main (main ниже на 1): `--save` поднял молча.
key2=$(awk -F'\t' '$1 == "function" && $3 > 1 { print $2; exit }' docs/frontend-metrics-baseline.txt)
awk -F'\t' -v OFS='\t' -v k="$key2" '$2 == k { $3 = $3 - 1 } { print }' docs/frontend-metrics-baseline.txt > "$tmp/main-ref/frontend-metrics-baseline.txt"
if METRICS_EXCEPTIONS="$tmp/none.txt" $g --from "$tmp/main-ref" >/dev/null 2>&1; then fail "guard: подъём baseline метрик без исключения не пойман"; fi
v2=$(awk -F'\t' -v k="$key2" '$2 == k { print $3 }' docs/frontend-metrics-baseline.txt)
printf 'function\t%s\t%s\tпотому что так надо\n' "$key2" "$v2" > "$tmp/exc-guard.txt"
METRICS_EXCEPTIONS="$tmp/exc-guard.txt" $g --from "$tmp/main-ref" >/dev/null || fail "guard: подъём baseline с исключением не прошёл"
cp docs/frontend-metrics-baseline.txt "$tmp/main-ref/frontend-metrics-baseline.txt"

# Новый член в baseline ветки; исключения берутся из INVARIANTS_DIR.
cp -r docs/frontend-invariants "$tmp/inv-cur"
mem2=$(head -1 docs/frontend-invariants/app-members.txt)
sed -i "/^${mem2}\$/d" "$tmp/main-ref/app-members.txt"
if INVARIANTS_DIR="$tmp/inv-cur" $g --from "$tmp/main-ref" >/dev/null 2>&1; then fail "guard: новый член app.* в baseline без исключения не пойман"; fi
printf 'app-members\t%s\tпотому что так надо\n' "$mem2" >> "$tmp/inv-cur/exceptions.txt"
INVARIANTS_DIR="$tmp/inv-cur" $g --from "$tmp/main-ref" >/dev/null || fail "guard: новый член с исключением не прошёл"

# Второй уровень в guard: main знает на один член меньше.
cp docs/frontend-invariants/app-nested.txt "$tmp/main-ref/app-nested.txt"
nest2=$(head -1 docs/frontend-invariants/app-nested.txt)
sed -i "/^${nest2}\$/d" "$tmp/main-ref/app-nested.txt"
if INVARIANTS_DIR="$tmp/inv-cur" $g --from "$tmp/main-ref" >/dev/null 2>&1; then fail "guard: новый app.ui/selection.* без исключения не пойман"; fi
printf 'app-nested\t%s\tпотому что так надо\n' "$nest2" >> "$tmp/inv-cur/exceptions.txt"
INVARIANTS_DIR="$tmp/inv-cur" $g --from "$tmp/main-ref" >/dev/null || fail "guard: новый app.ui/selection.* с исключением не прошёл"

# --- инварианты доступности --------------------------------------------------

fresh() { rm -rf "$tmp/a11y"; cp -r "$tmp/inv" "$tmp/a11y"; }
mkdir "$tmp/e2e-empty" "$tmp/e2e-with"
echo 'await click("[data-zzzgone]")' > "$tmp/e2e-with/a.mjs"

fresh; echo "aria-zzz" >> "$tmp/a11y/aria-attrs.txt"
if $i --compare "$tmp/a11y" >/dev/null 2>&1; then fail "инварианты: пропавшее имя aria-* не поймано"; fi
printf 'aria-attrs\taria-zzz\tубрали вместе с компонентом\n' > "$tmp/a11y/exceptions.txt"
$i --compare "$tmp/a11y" >/dev/null || fail "инварианты: пропавшее имя aria-* с исключением не прошло"

fresh; echo "zzzrole" >> "$tmp/a11y/roles.txt"
if $i --compare "$tmp/a11y" >/dev/null 2>&1; then fail "инварианты: пропавшее значение role= не поймано"; fi
printf 'roles\tzzzrole\tубрали вместе с компонентом\n' > "$tmp/a11y/exceptions.txt"
$i --compare "$tmp/a11y" >/dev/null || fail "инварианты: пропавшее значение role= с исключением не прошло"

fresh
awk '$1 == "aria_attrs" { $2 = $2 + 1 } { print }' "$tmp/inv/summary.txt" > "$tmp/a11y/summary.txt"
if $i --compare "$tmp/a11y" >/dev/null 2>&1; then fail "инварианты: уменьшение aria_attrs не поймано"; fi
printf 'summary\taria_attrs\tубрали вместе с компонентом\n' > "$tmp/a11y/exceptions.txt"
$i --compare "$tmp/a11y" >/dev/null || fail "инварианты: уменьшение aria_attrs с исключением не прошло"
awk '$1 == "role_attrs" { $2 = $2 + 1 } { print }' "$tmp/inv/summary.txt" > "$tmp/a11y/summary.txt"
rm "$tmp/a11y/exceptions.txt"
if $i --compare "$tmp/a11y" >/dev/null 2>&1; then fail "инварианты: уменьшение role_attrs не поймано"; fi

fresh; echo "data-zzzgone" >> "$tmp/a11y/data-kinds.txt"
E2E_DIR="$tmp/e2e-empty" $i --compare "$tmp/a11y" >/dev/null || fail "инварианты: data-* вне e2e уронил проверку"
if E2E_DIR="$tmp/e2e-with" $i --compare "$tmp/a11y" >/dev/null 2>&1; then fail "инварианты: пропавший data-* из e2e не пойман"; fi
printf 'data-kinds\tdata-zzzgone\tсценарий переписан\n' > "$tmp/a11y/exceptions.txt"
E2E_DIR="$tmp/e2e-with" $i --compare "$tmp/a11y" >/dev/null || fail "инварианты: data-* из e2e с исключением не прошёл"

# Низкие: лишнее исключение, пробелы в причине, несортированный baseline, сводка при падении.
fresh; printf 'app-members\t%s\tбыл нужен\n' "$member" > "$tmp/a11y/exceptions.txt"
out=$($i --compare "$tmp/a11y" 2>&1) || fail "инварианты: лишнее исключение уронило проверку"
grep -q 'не нужно' <<<"$out" || fail "инварианты: лишнее исключение не предупреждено"

cp -r "$tmp/inv" "$tmp/blank-inv"
sed -i "/^${member}\$/d" "$tmp/blank-inv/app-members.txt"
printf 'app-members\t%s\t   \n' "$member" > "$tmp/blank-inv/exceptions.txt"
if $i --compare "$tmp/blank-inv" >/dev/null 2>&1; then fail "инварианты: причина из пробелов принята"; fi
printf 'app-members\t%s\t  причина  \n' "$member" > "$tmp/blank-inv/exceptions.txt"
$i --compare "$tmp/blank-inv" >/dev/null || fail "инварианты: причина с пробелами по краям не принята"

fresh; tac "$tmp/inv/app-members.txt" > "$tmp/a11y/app-members.txt"
$i --compare "$tmp/a11y" >/dev/null 2>&1 || fail "инварианты: несортированный baseline уронил проверку"

fresh; echo "aria-zzz" >> "$tmp/a11y/aria-attrs.txt"
out=$($i --compare "$tmp/a11y" 2>&1) || true
grep -q 'виды data-' <<<"$out" || fail "инварианты: при падении нет сводки"

# --- measure-checks.sh --probe -----------------------------------------------

probe="$tmp/probe"
mkdir -p "$probe/scripts" "$probe/crates/depesha-core/src" "$probe/src/lib"
cp scripts/measure-checks.sh "$probe/scripts/"
printf '#!/usr/bin/env bash\nexit 0\n' > "$probe/scripts/check.sh"
chmod +x "$probe/scripts/check.sh"
echo "x" > "$probe/crates/depesha-core/src/lib.rs"; echo "y" > "$probe/src/lib/drops.ts"
( cd "$probe" && git init -q . && git config user.email t@e.x && git config user.name t && git add -A && git commit -q -m init )

echo "грязно" >> "$probe/src/lib/drops.ts"
if "$probe/scripts/measure-checks.sh" --probe-only >/dev/null 2>&1; then fail "measure: грязная проба не остановила"; fi
grep -q грязно "$probe/src/lib/drops.ts" || fail "measure: чужая правка пробного файла потеряна"
git -C "$probe" checkout -q -- src/lib/drops.ts

"$probe/scripts/measure-checks.sh" --probe-only >/dev/null 2>&1 || fail "measure: чистая проба не прошла"
[[ -z $(git -C "$probe" status --porcelain) ]] || fail "measure: проба не откатилась"

printf '#!/usr/bin/env bash\nkill -INT "$PPID"\nsleep 1\n' > "$probe/scripts/check.sh"
"$probe/scripts/measure-checks.sh" --probe-only >/dev/null 2>&1 || true
[[ -z $(git -C "$probe" status --porcelain -- src crates) ]] || fail "measure: проба не откатилась после прерывания"

echo "frontend-checks: ок"
