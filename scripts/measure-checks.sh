#!/usr/bin/env bash
# Замер времени проверок для сравнения версий (docs/internal/test-timing-0.8.0.md).
# Запускать из корня чистого worktree, sccache тёплый, ничего тяжёлого рядом.
#
#   scripts/measure-checks.sh          тесты и пустое изменение
#   scripts/measure-checks.sh --probe  ещё --changed с правкой одного файла в crates/ и в src/
#                                      (правка откатывается через git checkout этого файла)
set -uo pipefail
cd "$(dirname "$0")/.."
export CARGO_BUILD_JOBS=3 LC_NUMERIC=C

t() {
  local label=$1 s rc
  shift
  s=$(date +%s.%N)
  "$@" >/tmp/measure-checks.out 2>&1
  rc=$?
  printf '%s\t%.1f с\trc=%s\n' "$label" "$(echo "$(date +%s.%N) - $s" | bc)" "$rc"
  sed 's/\x1b\[[0-9;]*m//g' /tmp/measure-checks.out | grep -E '^test result:|Test Files|^ +Tests ' | grep -v ' 0 passed; 0 failed' | cut -c1-140
}

t "cargo test -p depesha-core" cargo test -p depesha-core
t "cargo test -p depesha-core (повтор)" cargo test -p depesha-core
t "cargo test -p depesha --lib" cargo test -p depesha --lib
t "cargo test -p depesha --lib (повтор)" cargo test -p depesha --lib
t "vitest run" npx vitest run
t "scripts/frontend-metrics.sh" scripts/frontend-metrics.sh
t "scripts/frontend-invariants.sh" scripts/frontend-invariants.sh
t "check.sh --changed, без изменений" scripts/check.sh --changed

if [[ "${1:-}" == "--probe" ]]; then
  for f in crates/depesha-core/src/lib.rs src/lib/drops.ts; do
    echo "// timing probe" >> "$f"
    t "check.sh --changed, правка $f" scripts/check.sh --changed
    git checkout -- "$f"
  done
fi
