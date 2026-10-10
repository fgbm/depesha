#!/usr/bin/env bash
# Runs a command in its own D-Bus session with a throwaway unlocked keyring:
# the test passwords never reach the user's keyring, and a locked one does not
# stop the wizard ("SS error: prompt dismissed").
#
#   e2e/keyring.sh node e2e/run.mjs
#
# E2E_SYSTEM_KEYRING=1 runs the command as is, with the session's own keyring.
set -euo pipefail

if [[ -n "${E2E_SYSTEM_KEYRING:-}" ]]; then
  exec "$@"
fi
if [[ -z "${E2E_KEYRING_SESSION:-}" ]]; then
  E2E_KEYRING_SESSION=1 exec dbus-run-session -- "$0" "$@"
fi

data="$(mktemp -d)"
trap 'rm -rf "$data"' EXIT
# --login creates the default collection; --unlock alone leaves none.
# 9>&-: the daemons outlive the run and must not inherit the stand's lock (scripts/stand-lock.sh).
echo -n x | XDG_DATA_HOME="$data" gnome-keyring-daemon --login >/dev/null 2>&1 9>&-
eval "$(XDG_DATA_HOME="$data" gnome-keyring-daemon --start --components=secrets 9>&-)"
"$@"
