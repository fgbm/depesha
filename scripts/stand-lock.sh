#!/usr/bin/env bash
# The one way to take the e2e stand's lock. The stand is single for every worktree and agent
# (GreenMail/Dovecot ports, WebDriver 4444/4445, Xvfb :99): whoever starts containers, seeds
# data or runs the app takes this lock first.
#
#   scripts/stand-lock.sh <command…>   run the command under the lock, wait if it is busy
#   source scripts/stand-lock.sh
#     stand_lock_take [who]            take it for the rest of the calling script
#     stand_lock_reexec <abs-script> "$@"   re-run the script under the lock (no-op if held)
#
# Env: DEPESHA_STAND_LOCK (lock file, default ${XDG_RUNTIME_DIR:-/tmp}/depesha-e2e.lock),
# DEPESHA_STAND_WAIT (seconds to wait, default 3600). DEPESHA_STAND_LOCKED=1 means the lock is
# already held by an outer caller: nothing is taken again, so nested calls do not hang.
#
# The lock file holds one line about the holder (PID, time, command); a waiter prints it.
# Command mode `exec`s the command, so there is no wrapper process: the command itself holds the
# lock (fd 9) and it is gone with the command, however the command ends. The price: children of
# the command inherit fd 9, and an orphan among them keeps the stand locked. A command that
# starts a long-lived child (a driver, a daemon, sccache) starts it with `9>&-`.
stand_lock_take() {
  [[ -n "${DEPESHA_STAND_LOCKED:-}" ]] && return 0
  local lock="${DEPESHA_STAND_LOCK:-${XDG_RUNTIME_DIR:-/tmp}/depesha-e2e.lock}" wait="${DEPESHA_STAND_WAIT:-3600}" rc
  # 9>>: opening must not wipe the holder's line before the lock is ours.
  exec 9>>"$lock" || { echo "не открыть замок стенда ($lock)" >&2; return 1; }
  # 200: flock's own "busy" code (-E), so it cannot be taken for another error.
  flock -n -E 200 9 && rc=0 || rc=$?
  if [[ $rc == 200 ]]; then
    echo "стенд занят, жду до ${wait} с… ($lock)"
    echo "держит: $(cat "$lock" 2>/dev/null)"
    flock -w "$wait" -E 200 9 && rc=0 || rc=$?
    [[ $rc == 200 ]] && { echo "стенд не освободился за ${wait} с ($lock)" >&2; return 1; }
  fi
  [[ $rc == 0 ]] || { echo "flock не взял замок стенда ($lock), код $rc" >&2; return 1; }
  # The PID stays the same through `exec`, so it names the command that holds the lock.
  truncate -s 0 "$lock"
  printf 'PID %s, с %s: %s\n' "$$" "$(date +%H:%M:%S)" "${1:-$0}" >&9
  export DEPESHA_STAND_LOCKED=1
}

# For a script's own start: `stand_lock_reexec "$self" "$@"`, $self an absolute path taken before `cd`.
stand_lock_reexec() {
  [[ -n "${DEPESHA_STAND_LOCKED:-}" ]] && return 0
  local self=$1
  shift
  stand_lock_take "$self $*" || exit 1
  exec "$self" "$@"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -uo pipefail
  [[ $# -gt 0 ]] || { echo "usage: $0 <command…>" >&2; exit 2; }
  stand_lock_take "$*" || exit 1
  exec "$@"
fi
