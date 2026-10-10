#!/usr/bin/env bash
# One `fn lock<T>(` in src-tauri, in state.rs (#145): a copy in another module fails the check.
set -euo pipefail
cd "$(dirname "$0")/.."
extra=$(grep -rn --include='*.rs' -E 'fn lock<T>\(' src-tauri/src | grep -v '^src-tauri/src/state\.rs:' || true)
if [[ -n $extra ]]; then
  printf 'Второе определение lock: берите crate::state::lock.\n%s\n' "$extra" >&2
  exit 1
fi
