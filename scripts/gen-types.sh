#!/usr/bin/env bash
# The TypeScript types of the interface are written from the Rust structs they travel as (#143):
# src/lib/generated/types.ts, from src-tauri/src/ts_types.rs.
#
#   scripts/gen-types.sh           write the file (after a type that reaches the interface changes)
#   scripts/gen-types.sh --check   fail when the committed file is not what the Rust types give
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-}" in
  "") UPDATE_TYPES=1 cargo test -p depesha --lib generated_types_are_current ;;
  --check) cargo test -p depesha --lib generated_types_are_current ;;
  *) echo "usage: scripts/gen-types.sh [--check]" >&2; exit 2 ;;
esac
