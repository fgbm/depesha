#!/usr/bin/env bash
# Тест scripts/stand-lock.sh на временном файле замка (настоящий замок стенда не трогает):
# вызовы идут по очереди, вложенный с DEPESHA_STAND_LOCKED=1 не виснет, держатель назван в
# сообщении ожидания, команда держит замок сама (без промежуточного процесса), перезапуск
# скрипта по относительному пути не падает с 127.
set -eu
cd "$(dirname "$0")/.."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
export DEPESHA_STAND_LOCK="$tmp/lock"
unset DEPESHA_STAND_LOCKED
sl=$PWD/scripts/stand-lock.sh

# Ждём, пока замок взят держателем: в файле есть его строка.
held() { for _ in $(seq 50); do [[ -s "$DEPESHA_STAND_LOCK" ]] && return 0; sleep 0.1; done; fail "держатель не взял замок"; }

# Держатель назван, и это сама команда: PID в замке совпадает с PID процесса, а не обёртки.
"$sl" sleep 2 &
holder=$!
held
grep -q "PID $holder," "$DEPESHA_STAND_LOCK" || fail "в замке нет PID держателя $holder: $(cat "$DEPESHA_STAND_LOCK")"

# Второй вызов ждёт, печатает PID первого и идёт после него.
out=$("$sl" echo second 2>&1)
wait "$holder"
grep -q "PID $holder," <<<"$out" || fail "ожидающий не назвал держателя: $out"
grep -q "стенд занят" <<<"$out" || fail "ожидающий не написал «стенд занят»: $out"
grep -q second <<<"$out" || fail "второй вызов не выполнился"

# Убит держатель — замок свободен сразу (промежуточного процесса, который его удержал бы, нет).
"$sl" sleep 30 &
holder=$!
held
kill -9 "$holder"
wait "$holder" 2>/dev/null || true
timeout 3 "$sl" true || fail "после убийства держателя замок не освободился"

# Параллельные вызовы: отрезки [начало, конец] не пересекаются.
: >"$tmp/log"
job() { "$sl" bash -c "echo start >>'$tmp/log'; sleep 0.5; echo end >>'$tmp/log'" >/dev/null 2>&1; }
job & p1=$!
for _ in $(seq 50); do [[ -s "$tmp/log" ]] && break; sleep 0.1; done
job & p2=$!
wait "$p1" "$p2"
[[ "$(tr '\n' ' ' <"$tmp/log")" == "start end start end " ]] || fail "вызовы пересеклись: $(tr '\n' ' ' <"$tmp/log")"

# Вложенный вызов под уже взятым замком не берёт его снова.
timeout 10 "$sl" "$sl" echo nested >"$tmp/nested" 2>&1 || fail "вложенный вызов завис или упал: $(cat "$tmp/nested")"
grep -q nested "$tmp/nested" || fail "вложенный вызов не выполнил команду"

# Потомок команды наследует замок; закрытый `9>&-` — нет.
"$sl" bash -c 'sleep 3 9>&- & echo $! >"'"$tmp"'/pid"' >/dev/null
timeout 2 "$sl" true || fail "потомок с 9>&- держит замок"
kill "$(cat "$tmp/pid")" 2>/dev/null || true

# Код команды сохраняется; по таймауту выход с ошибкой.
rc=0; "$sl" bash -c 'exit 7' || rc=$?
[[ $rc == 7 ]] || fail "код команды потерян: $rc"
"$sl" sleep 3 &
holder=$!
held
rc=0; DEPESHA_STAND_WAIT=1 "$sl" true >/dev/null 2>&1 || rc=$?
[[ $rc == 1 ]] || fail "таймаут ожидания: ожидали 1, получили $rc"
wait "$holder"

# Съёмочные скрипты перезапускаются под замком и из своего каталога (относительный $0), не с 127.
# Замок занят и ждать секунду: до docker дело не доходит.
for s in shots.sh release-shots.sh; do
  "$sl" sleep 3 &
  holder=$!
  held
  rc=0
  out=$(cd scripts && DEPESHA_STAND_WAIT=1 ./"$s" 2>&1) || rc=$?
  [[ $rc == 1 ]] || fail "$s из scripts/: ожидали 1 (не дождался замка), получили $rc: $out"
  grep -q "стенд занят" <<<"$out" || fail "$s из scripts/ не встал в очередь: $out"
  wait "$holder"
done
echo "stand-lock: ok"
