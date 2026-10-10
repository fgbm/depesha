#!/usr/bin/env bash
# Тест scripts/stand-lock.sh на временном файле замка (настоящий замок стенда не трогает):
# два параллельных вызова идут по очереди, вложенный с DEPESHA_STAND_LOCKED=1 не виснет,
# дочерний процесс не наследует дескриптор замка, по таймауту выход с ошибкой.
set -eu
cd "$(dirname "$0")/.."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
export DEPESHA_STAND_LOCK="$tmp/lock"
unset DEPESHA_STAND_LOCKED
sl=scripts/stand-lock.sh

# Параллельные вызовы: отрезки [начало, конец] не пересекаются.
job() { "$sl" bash -c "echo start >>'$tmp/log'; sleep 0.5; echo end >>'$tmp/log'" >"$tmp/out$1" 2>&1; }
job 1 & p1=$!
job 2 & p2=$!
wait "$p1" "$p2"
[[ "$(tr '\n' ' ' <"$tmp/log")" == "start end start end " ]] || fail "вызовы пересеклись: $(tr '\n' ' ' <"$tmp/log")"
grep -q "стенд занят" "$tmp"/out1 "$tmp"/out2 || fail "второй вызов не написал «стенд занят»"

# Вложенный вызов под уже взятым замком не берёт его снова.
timeout 10 "$sl" "$sl" echo nested >"$tmp/nested" 2>&1 || fail "вложенный вызов завис или упал: $(cat "$tmp/nested")"
grep -q nested "$tmp/nested" || fail "вложенный вызов не выполнил команду"

# Команда не наследует дескриптор замка: фоновый осиротевший процесс не держит стенд.
"$sl" bash -c 'sleep 3 & echo $! >"'"$tmp"'/pid"' >/dev/null
timeout 2 "$sl" true || fail "осиротевший процесс держит замок"
kill "$(cat "$tmp/pid")" 2>/dev/null || true

# Код команды сохраняется; по таймауту выход с ошибкой.
rc=0; "$sl" bash -c 'exit 7' || rc=$?
[[ $rc == 7 ]] || fail "код команды потерян: $rc"
"$sl" sleep 3 & holder=$!
sleep 0.3
rc=0; DEPESHA_STAND_WAIT=1 "$sl" true >/dev/null 2>&1 || rc=$?
[[ $rc == 1 ]] || fail "таймаут ожидания: ожидали 1, получили $rc"
wait "$holder"
echo "stand-lock: ok"
