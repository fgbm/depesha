#!/usr/bin/env bash
# Test of scripts/lock-guard.sh: what it lets through and what it stops.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0
expect() { # expect <0|1> <what> ; the file under test is $tmp/src/a.rs
  rc=0; scripts/lock-guard.sh "$tmp/src" "$tmp/src/${ALLOWED:-state.rs}" >/dev/null 2>&1 || rc=$?
  if [[ $rc != "$1" ]]; then echo "FAIL: $2 (код $rc, ждали $1)"; fails=1; fi
}
mkdir -p "$tmp/src"
printf 'use crate::state::lock;\nfn f(m: &Mutex<u8>) { *lock(m) = 1; }\n' > "$tmp/src/a.rs"
expect 0 "чистый файл"
printf 'fn lock<T>(m: &Mutex<T>) {}\n' > "$tmp/src/a.rs"
expect 1 "fn lock<T>("
printf 'fn lock<U>(m: &Mutex<U>) {}\n' > "$tmp/src/a.rs"
expect 1 "fn lock<U>("
printf 'fn lock(&self) {}\n' > "$tmp/src/a.rs"
expect 1 "метод lock"
printf 'fn f() { m.lock().unwrap_or_else(|e| e.into_inner()); }\n' > "$tmp/src/a.rs"
expect 1 "into_inner() руками"
printf 'fn f() { m.lock().unwrap_or_else(|e| e.into_inner()); }\n' > "$tmp/src/waiting.rs"
printf 'fn clock() {}\n' > "$tmp/src/a.rs"
expect 1 "waiting.rs больше не в исключениях"
rm "$tmp/src/waiting.rs"
printf 'fn clock() {}\n' > "$tmp/src/a.rs"
expect 0 "clock — не lock"
printf 'fn f() { reader.into_inner(); }\n' > "$tmp/src/a.rs"
expect 0 "into_inner() потока — не замок"
printf 'fn lock<T>() {}\n' > "$tmp/src/state.rs"
expect 0 "state.rs — дом lock приложения"
printf 'fn lock<T>() {}\n' > "$tmp/src/state.rs"
expect 0 "state.rs — дом lock приложения (ещё раз)"
mkdir -p "$tmp/src/sub"
printf 'fn lock<T>() {}\n' > "$tmp/src/sub/state.rs"
rm "$tmp/src/state.rs"
expect 1 "state.rs в другой папке — не дом lock"
rm -r "$tmp/src/sub"
printf 'fn lock<T>() {}\n' > "$tmp/src/state.rs"
ALLOWED=lock.rs
expect 1 "в ядре state.rs не дом lock"
rm "$tmp/src/state.rs"
printf 'fn lock<T>() {}\n' > "$tmp/src/lock.rs"
expect 0 "lock.rs — дом lock ядра"
printf 'fn f() { m.lock().unwrap_or_else(|e| e.into_inner()); }\n' > "$tmp/src/tls.rs"
expect 1 "into_inner() руками в ядре"
printf 'fn f() { m.lock().unwrap_or_else(std::sync::PoisonError::into_inner); }\n' > "$tmp/src/tls.rs"
expect 1 "PoisonError::into_inner"
printf 'use std::sync::PoisonError;\nfn f() { m.lock().unwrap_or_else(PoisonError::into_inner); }\n' > "$tmp/src/tls.rs"
expect 1 "PoisonError::into_inner с use"
rm "$tmp/src/tls.rs"
# The real tree passes with the real rule.
scripts/lock-guard.sh >/dev/null 2>&1 || { echo "FAIL: настоящее дерево"; fails=1; }
exit $fails
