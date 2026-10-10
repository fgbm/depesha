#!/usr/bin/env bash
# Screenshots for a release's description (docs/releases/<version>.md): start the test
# servers, seed the tidy demo mail, build the app and shoot the set in one run of
# e2e/release-shots.mjs.
#
#   scripts/release-shots.sh                       the whole thing
#   DEPESHA_APP=… SHOTS_OUT=… scripts/release-shots.sh   an already built binary, no build
#   SHOTS_SET=0.8.0 scripts/release-shots.sh      the set of 0.8.0 (default: 0.7.0)
#
# Needs Xvfb on $E2E_DISPLAY (default :99), tauri-driver and WebKitWebDriver;
# see e2e/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."
# The stand's lock (scripts/stand-lock.sh), waiting if the stand is busy.
[[ -n "${DEPESHA_STAND_LOCKED:-}" ]] || exec scripts/stand-lock.sh "$0" "$@"

step() { printf '\n== %s\n' "$*"; }

# Fresh containers, as check.sh makes them: no folders or labels left by other runs in the
# pictures.
step "GreenMail"
docker compose -f compose.test.yaml up -d --force-recreate
python3 scripts/wait-stand.py

step "демо-данные"
# GreenMail accepts connections a moment before its users exist.
for i in $(seq 10); do
  python3 e2e/imap_helper.py demo-seed "${SHOTS_SET:-}" 2>/dev/null && break
  [[ $i == 10 ]] && { echo "demo-seed failed"; exit 1; }
  sleep 2
done

if [[ -z "${DEPESHA_APP:-}" ]]; then
  step "сборка"
  npx tauri build --debug --no-bundle --features e2e
fi

step "съёмка"
e2e/keyring.sh node e2e/release-shots.mjs

step "готово"
ls -1 "${SHOTS_OUT:-/tmp/depesha-release-shots}"/*.png
