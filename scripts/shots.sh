#!/usr/bin/env bash
# README screenshots, reproducible: start the test servers, seed tidy demo mail,
# build the app and shoot docs/screenshots/ in one run of e2e/shots.mjs.
#
#   scripts/shots.sh                    the whole thing
#   DEPESHA_APP=… scripts/shots.sh      an already built binary, no build
#
# Takes the stand's lock itself (scripts/stand-lock.sh) and waits if the stand is busy.
#
# Needs Xvfb on $E2E_DISPLAY (default :99), tauri-driver and WebKitWebDriver;
# see e2e/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -n "${DEPESHA_STAND_LOCKED:-}" ]] || exec scripts/stand-lock.sh "$0" "$@"

step() { printf '\n== %s\n' "$*"; }

step "GreenMail"
docker compose -f compose.test.yaml up -d --force-recreate
python3 scripts/wait-stand.py

step "демо-данные"
# GreenMail accepts connections a moment before its users exist.
for i in $(seq 10); do
  python3 e2e/imap_helper.py demo-seed 0.8.0 2>/dev/null && break
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
