#!/usr/bin/env bash
# Test of scripts/lock-guard.sh: what it lets through and what it stops.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0
expect() { # expect <0|1> <what> ; the file under test is $tmp/src/a.rs
  rc=0; scripts/lock-guard.sh "$tmp/src" >/dev/null 2>&1 || rc=$?
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
expect 0 "waiting.rs в исключениях, clock не lock"
rm "$tmp/src/waiting.rs"
printf 'fn lock<T>() {}\n' > "$tmp/src/state.rs"
expect 0 "state.rs — дом lock"
exit $fails
