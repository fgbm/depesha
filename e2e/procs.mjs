// The driver runs as a process group of its own: the app is a child of WebKitWebDriver, and killing
// only tauri-driver leaves it alive, holding the single-instance name on the session bus (#129).

/** Kills the whole group `proc` leads (it was spawned `detached`); true when something was killed. */
export function killGroup(proc) {
  if (!proc?.pid) return false;
  try {
    process.kill(-proc.pid, "SIGKILL");
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    throw e;
  }
}

/** True when some process of the group `proc` led still lives. */
export function groupAlive(proc) {
  if (!proc?.pid) return false;
  try {
    process.kill(-proc.pid, 0);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    throw e;
  }
}

/** Resolves when `proc` has exited, at once if it already has. */
export function exited(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((r) => proc.once("exit", r));
}
