// The stand is one for every worktree and agent. Called first in a script that touches it: unless
// the lock is already held (DEPESHA_STAND_LOCKED=1, e.g. by scripts/check.sh), the script starts
// itself again under scripts/stand-lock.sh (which execs it, so it holds the lock), waits its turn
// and exits with the rerun's code. Node children do not inherit the lock's fd 9 (libuv closes it).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function ensureStandLock() {
  if (process.env.DEPESHA_STAND_LOCKED) return;
  const lock = join(dirname(fileURLToPath(import.meta.url)), "../scripts/stand-lock.sh");
  const done = spawnSync(lock, [process.execPath, ...process.argv.slice(1)], { stdio: "inherit" });
  if (done.error) throw done.error;
  process.exit(done.status ?? 1);
}
