#!/usr/bin/env bash
# The one way to take the e2e stand's lock. The stand is single for every worktree and agent
# (GreenMail/Dovecot ports, WebDriver 4444/4445, Xvfb :99): whoever starts containers, seeds
# data or runs the app takes this lock first.
#
#   scripts/stand-lock.sh <command…>   run the command under the lock, wait if it is busy
#   source scripts/stand-lock.sh; stand_lock_take   take it for the rest of the calling script
#
# Env: DEPESHA_STAND_LOCK (lock file, default ${XDG_RUNTIME_DIR:-/tmp}/depesha-e2e.lock),
# DEPESHA_STAND_WAIT (seconds to wait, default 3600). DEPESHA_STAND_LOCKED=1 means the lock is
# already held by an outer caller: nothing is taken again, so nested calls do not hang.
#
# Command mode closes the lock's descriptor for the command (9>&-): an orphan left by the run
# (WebKitWebDriver, a sccache server) must not keep the stand locked after the run is over.
stand_lock_take() {
  [[ -n "${DEPESHA_STAND_LOCKED:-}" ]] && return 0
  local lock="${DEPESHA_STAND_LOCK:-${XDG_RUNTIME_DIR:-/tmp}/depesha-e2e.lock}" wait="${DEPESHA_STAND_WAIT:-3600}" rc
  exec 9>"$lock" || { echo "не открыть замок стенда ($lock)" >&2; return 1; }
  # 200: flock's own "busy" code (-E), so it cannot be taken for another error.
  flock -n -E 200 9 && rc=0 || rc=$?
  if [[ $rc == 200 ]]; then
    echo "стенд занят, жду до ${wait} с… ($lock)"
    flock -w "$wait" -E 200 9 && rc=0 || rc=$?
    [[ $rc == 200 ]] && { echo "стенд не освободился за ${wait} с ($lock)" >&2; return 1; }
  fi
  [[ $rc == 0 ]] || { echo "flock не взял замок стенда ($lock), код $rc" >&2; return 1; }
  export DEPESHA_STAND_LOCKED=1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -uo pipefail
  [[ $# -gt 0 ]] || { echo "usage: $0 <command…>" >&2; exit 2; }
  stand_lock_take || exit 1
  "$@" 9>&-
fi
