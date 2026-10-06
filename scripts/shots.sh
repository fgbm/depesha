#!/usr/bin/env bash
# README screenshots, reproducible: start the test servers, seed tidy demo mail,
# build the app and shoot docs/screenshots/ in one run of e2e/shots.mjs.
#
#   scripts/shots.sh                    the whole thing
#   DEPESHA_APP=… scripts/shots.sh      an already built binary, no build
#
# Needs Xvfb on $E2E_DISPLAY (default :99), tauri-driver and WebKitWebDriver;
# see e2e/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s\n' "$*"; }

step "GreenMail"
docker compose -f compose.test.yaml up -d --force-recreate
for _ in $(seq 30); do
  python3 -c "import imaplib; imaplib.IMAP4('127.0.0.1', 3143).logout(); imaplib.IMAP4('127.0.0.1', 31143).logout()" 2>/dev/null && break
  sleep 1
done

step "демо-данные"
# GreenMail accepts connections a moment before its users exist.
for i in $(seq 10); do
  python3 e2e/imap_helper.py demo-seed 2>/dev/null && break
  [[ $i == 10 ]] && { echo "demo-seed failed"; exit 1; }
  sleep 2
done

if [[ -z "${DEPESHA_APP:-}" ]]; then
  step "сборка"
  npx tauri build --debug --no-bundle --features e2e
fi

step "съёмка"
e2e/keyring.sh node e2e/shots.mjs

step "готово"
ls -1 docs/screenshots/*.png
