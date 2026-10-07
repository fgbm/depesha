#!/usr/bin/env bash
# Full verification: static checks, unit tests, integration tests against GreenMail,
# and the end-to-end GUI run on a virtual display.
#
#   scripts/check.sh          everything
#   scripts/check.sh --fast   static checks and unit tests only
#
# The E2E part needs Xvfb on $E2E_DISPLAY (default :99), tauri-driver and WebKitWebDriver;
# see e2e/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s\n' "$*"; }

step "rustfmt"
cargo fmt --all --check
step "clippy"
cargo clippy --workspace --all-targets -- -D warnings
step "svelte-check"
npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
step "eslint"
npm run lint
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
DEPESHA_IT=1 cargo test -p depesha-core --test greenmail --test dovecot

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
