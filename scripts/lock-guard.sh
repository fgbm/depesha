#!/usr/bin/env bash
# The poison-tolerant lock lives once, in src-tauri/src/state.rs (#145): no other `fn lock` and no
# hand-written `.unwrap_or_else(|e| e.into_inner())` in src-tauri/src; use crate::state::lock.
# Argument: the directory with the Rust sources (default src-tauri/src), for scripts/lock-guard.test.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
dir=${1:-src-tauri/src}
# waiting.rs moves to the core with #134 and takes its statics along: it leaves with #134.
skip=(--exclude=state.rs --exclude=waiting.rs)
extra=$(grep -rnE --include='*.rs' "${skip[@]}" 'fn lock\b|into_inner\(\)\)' "$dir" || true)
if [[ -n $extra ]]; then
  printf 'Свой lock или into_inner() вне state.rs: берите crate::state::lock.\n%s\n' "$extra" >&2
  exit 1
fi
