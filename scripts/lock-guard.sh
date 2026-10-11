#!/usr/bin/env bash
# The poison-tolerant lock lives once per crate (#145): in src-tauri/src/state.rs for the app and in
# crates/depesha-core/src/lock.rs for the core. No other `fn lock` and no hand-written
# `.unwrap_or_else(|e| e.into_inner())` anywhere else in those sources.
# Arguments: <directory with the Rust sources> <the file that may hold the lock>, for
# scripts/lock-guard.test.sh; without arguments both places are checked.
set -euo pipefail
cd "$(dirname "$0")/.."

check() { # check <dir> <allowed file> <what to use instead>
  local extra
  extra=$(grep -rnE --include='*.rs' --exclude="$2" 'fn lock\b|unwrap_or_else\(\|[a-z_]+\| [a-z_]+\.into_inner\(\)\)' "$1" || true)
  if [[ -n $extra ]]; then
    printf 'Свой lock или into_inner() вне %s: берите %s.\n%s\n' "$2" "$3" "$extra" >&2
    return 1
  fi
}

if [[ $# -ge 2 ]]; then
  check "$1" "$2" "общий lock"
else
  rc=0
  check src-tauri/src state.rs crate::state::lock || rc=1
  check crates/depesha-core/src lock.rs crate::lock::lock || rc=1
  exit $rc
fi
