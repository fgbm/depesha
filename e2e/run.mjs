// End-to-end acceptance run: the real app (debug build) on a virtual display,
// driven over WebDriver, against GreenMail (compose.test.yaml).
//
//   docker compose -f compose.test.yaml up -d --force-recreate && python3 e2e/imap_helper.py seed
//   npx tauri build --debug --no-bundle --features e2e
//   e2e/keyring.sh node e2e/run.mjs   (a throwaway keyring, see e2e/README.md)
//
// Env: DEPESHA_APP (binary), WEBKIT_DRIVER (WebKitWebDriver), E2E_DISPLAY (default :99),
// DEPESHA_STAND_LOCK (the stand lock file, default $XDG_RUNTIME_DIR/depesha-e2e.lock),
// DEPESHA_E2E_SHARD (one part of the scenario: `2/3` or `list,send`; without it all the steps, see e2e/shard.mjs).
//
// The stand is one for every worktree: unless scripts/check.sh already holds the lock
// (DEPESHA_STAND_LOCKED=1), the run starts itself again under scripts/stand-lock.sh and waits its turn.
//
// Only the order is here; the steps are in e2e/sections/, the ground in e2e/kit.mjs.

import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Abort } from "./step.mjs";
import { killGroup } from "./procs.mjs";
import { d, driverProc, env, failFirst, profile, results, retried, root, screens, startSession, waitDisplay } from "./kit.mjs";
import { run as setup } from "./sections/setup.mjs";
import { run as list } from "./sections/list.mjs";
import { run as send } from "./sections/send.mjs";
import { run as triage } from "./sections/triage.mjs";
import { run as sendlater } from "./sections/sendlater.mjs";
import { run as reminders } from "./sections/reminders.mjs";
import { run as settings } from "./sections/settings.mjs";
import { run as second } from "./sections/second.mjs";

try {
  await waitDisplay(env.DISPLAY);
  await startSession();
  console.log(`Профиль: ${profile}`);
  // A section the part does not run still goes through its code: its steps are skipped (e2e/shard.mjs).
  for (const section of [setup, list, send, triage, sendlater, reminders, settings, second]) await section();
} catch (e) {
  if (e instanceof Abort) console.error(`\nПрогон остановлен: ${e.message}.`);
  else console.error("Прогон прерван:", e);
  results.push({ criteria: "-", name: "прогон", ok: false, error: e.message });
} finally {
  await d.quit();
  killGroup(driverProc);
  // Remove only the test account's password from the keyring.
  try {
    const cfg = JSON.parse(readFileSync(join(profile, "config/ru.depesha.mail/accounts.json"), "utf-8"));
    for (const a of cfg.accounts ?? []) {
      execFileSync("secret-tool", ["clear", "service", "ru.depesha.mail", "username", a.id]);
    }
  } catch {}
  // The log of the app goes to the artifact of a CI run: a step that failed leaves its cause there.
  try {
    cpSync(join(profile, "data", "ru.depesha.mail", "logs"), join(root, "e2e/logs"), { recursive: true });
  } catch {}
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
if (failFirst.unused().length) console.log(`\nDEPESHA_E2E_FAIL_FIRST: до этих шагов прогон не дошёл (опечатка или шаг другой части): ${failFirst.unused().join(", ")}`);
if (retried.length) console.log(`\nПерезапущены и прошли со второй попытки (${retried.length}): ${retried.join("; ")}`);
console.log(`\nИтог: ${results.length - failed.length} из ${results.length} шагов прошли.`);
writeFileSync(join(screens, "results.json"), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);

