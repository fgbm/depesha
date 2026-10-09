#!/usr/bin/env bash
# Full verification: static checks, unit tests, integration tests against GreenMail,
# and the end-to-end GUI run on a virtual display.
#
#   scripts/check.sh          everything
#   scripts/check.sh --fast   static checks and unit tests only
#   scripts/check.sh --changed  only what the branch touched (against the merge-base with
#                               origin/main, plus uncommitted files); for work on a branch.
#                               Merging into main still takes the full run.
#
# The E2E part needs Xvfb on $E2E_DISPLAY (default :99), tauri-driver and WebKitWebDriver;
# see e2e/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s\n' "$*"; }

# One compile cache for every worktree, only where sccache is installed. It does not cache
# incremental crates, hence CARGO_INCREMENTAL=0. It also hashes every CARGO_* variable of the
# environment, CARGO_TARGET_DIR included: a per-worktree value would make every key unique,
# so the target stays the worktree's own default `target/` (see docs/release-process.md).
if [[ -z "${RUSTC_WRAPPER:-}" && -z "${DEPESHA_NO_SCCACHE:-}" ]] && command -v sccache >/dev/null 2>&1; then
  export RUSTC_WRAPPER=sccache CARGO_INCREMENTAL=0
  unset CARGO_TARGET_DIR
fi

if [[ "${1:-}" == "--changed" ]]; then
  base=$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main)
  changed=$({ git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u)
  exists() { while IFS= read -r f; do [[ -f $f ]] && printf '%s\n' "$f"; done; }
  rust=$(grep -E '^(crates/|src-tauri/|Cargo\.(toml|lock)$|rustfmt\.toml$)' <<<"$changed" || true)
  front=$(grep -E '^(src/|plugins/|index\.html$|package(-lock)?\.json$|vite\.config\.ts$|svelte\.config\.js$|tsconfig\.json$|eslint|docs/frontend-)' <<<"$changed" || true)
  lintable=$(grep -E '\.(ts|js|mjs|svelte)$' <<<"$changed" | exists || true)
  printf 'База: %s, изменено файлов: %s\n' "${base:0:9}" "$(grep -c . <<<"$changed" || true)"

  if [[ -n $rust ]]; then
    step "rustfmt"
    cargo fmt --all --check
    step "clippy"
    cargo clippy --workspace --all-targets -- -D warnings
    if grep -qE '^(crates/|Cargo)' <<<"$rust"; then
      step "cargo test -p depesha-core"
      cargo test -p depesha-core
    fi
    if grep -qE '^(src-tauri/|Cargo)' <<<"$rust"; then
      step "cargo test -p depesha --lib"
      cargo test -p depesha --lib
    fi
  fi
  if [[ -n $front ]]; then
    step "svelte-check"
    npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
    step "метрики фронтенда"
    scripts/frontend-metrics.sh
    step "инварианты фронтенда"
    scripts/frontend-invariants.sh
    step "vitest (затронутое)"
    npx vitest run --changed "$base" --passWithNoTests
    step "главный чанк фронтенда"
    scripts/frontend-bundle.sh
  fi
  if [[ -n $lintable ]]; then
    step "eslint (изменённые файлы)"
    # shellcheck disable=SC2086
    npx eslint --no-warn-ignored $lintable
  fi
  step "хук персональных данных"
  scripts/hooks/pre-commit.test.sh
  exit 0
fi

step "rustfmt"
cargo fmt --all --check
step "clippy"
cargo clippy --workspace --all-targets -- -D warnings
step "svelte-check"
npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
step "eslint"
npm run lint
step "хук персональных данных"
scripts/hooks/pre-commit.test.sh
step "метрики фронтенда"
scripts/frontend-metrics.sh
step "инварианты фронтенда"
scripts/frontend-invariants.sh
step "vitest"
npx vitest run
step "главный чанк фронтенда"
scripts/frontend-bundle.sh
step "cargo test (unit + scripted Exchange SMTP)"
cargo test -p depesha-core
cargo test -p depesha --lib

if [[ "${1:-}" == "--fast" ]]; then
  exit 0
fi

step "GreenMail"
docker compose -f compose.test.yaml up -d --force-recreate
for _ in $(seq 30); do
  python3 -c "import imaplib; imaplib.IMAP4('127.0.0.1', 3143).logout(); imaplib.IMAP4('127.0.0.1', 31143).logout()" 2>/dev/null && break
  sleep 1
done
step "integration tests"
# Full parallelism drops dozens of TLS sessions against one Dovecot at once.
DEPESHA_IT=1 cargo test -p depesha-core --test greenmail --test dovecot -- --test-threads=4

step "E2E"
docker compose -f compose.test.yaml up -d --force-recreate
for _ in $(seq 30); do
  python3 -c "import imaplib; imaplib.IMAP4('127.0.0.1', 3143).logout(); imaplib.IMAP4('127.0.0.1', 31143).logout()" 2>/dev/null && break
  sleep 1
done
# GreenMail accepts connections a moment before its users exist.
for i in $(seq 10); do
  python3 e2e/imap_helper.py seed 2>/dev/null && break
  [[ $i == 10 ]] && { echo "seed failed"; exit 1; }
  sleep 2
done
npx tauri build --debug --no-bundle --features e2e
e2e/keyring.sh node e2e/run.mjs
