// The drop steps (e2e/drop-steps.mjs) alone, against a test build and no mail server: for
// Windows CI, where there is no GreenMail (#79). The mailbox is only saved, never logged
// in to; the letter is a new one, written in the page that a reply opens as well.
//
//   npx tauri build --debug --no-bundle --features e2e
//   node e2e/drops.mjs
//
// Env: DEPESHA_APP (the binary), NATIVE_DRIVER (msedgedriver / WebKitWebDriver), TAURI_DRIVER
// (default: `tauri-driver` from PATH), E2E_EXPECT_DPR (the scale the page must report),
// E2E_MIN_DPR (the least it may report: a system scale that the screen may refuse),
// E2E_DISPLAY (Linux only, default :99). The log of the app is left in its own log folder.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Driver } from "./webdriver.mjs";
import { Abort, createStepRunner } from "./step.mjs";
import { dropFixtures, dropSteps } from "./drop-steps.mjs";

const windows = process.platform === "win32";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = process.env.DEPESHA_APP ?? join(root, "target/debug", windows ? "depesha.exe" : "depesha");
const screens = join(root, "e2e/screens");
mkdirSync(screens, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "depesha-e2e-"));
const env = {
  ...process.env,
  DEPESHA_NO_NOTIFICATIONS: "1",
  // Debug for the whole app: the log of a failed drop is the point of this run.
  DEPESHA_LOG: "debug",
  // Only the profile counts as chosen; the dropped files lie elsewhere and are allowed by the drop.
  DEPESHA_E2E_ROOT: profile,
  ...(windows
    ? {}
    : {
        DISPLAY: process.env.E2E_DISPLAY ?? ":99",
        GDK_BACKEND: "x11",
        WAYLAND_DISPLAY: "",
        XDG_CONFIG_HOME: join(profile, "config"),
        XDG_DATA_HOME: join(profile, "data"),
        XDG_CACHE_HOME: join(profile, "cache"),
        WEBKIT_DISABLE_COMPOSITING_MODE: "1",
      }),
};

const results = [];
const d = new Driver();
let shot = 0;

async function screenshot(name) {
  writeFileSync(join(screens, `drops-${String(++shot).padStart(2, "0")}-${name}.png`), await d.screenshot());
}
/** A failed step leaves its letter open: it would cover the next step's. */
const tidyUp = async () => {
  if ((await d.findAll(".compose")).length) await closeCompose().catch(() => {});
};
const step = createStepRunner({ screenshot, tidyUp, log: console.log, results, retried: [] });

const driverArgs = process.env.NATIVE_DRIVER ? ["--native-driver", process.env.NATIVE_DRIVER] : [];
const driverProc = spawn(process.env.TAURI_DRIVER ?? "tauri-driver", driverArgs, { env, stdio: ["ignore", "inherit", "inherit"] });
driverProc.on("error", (e) => console.error("tauri-driver:", e.message));

const fix = dropFixtures();
/** Where the form that carries the drag sits: under the window. */
let formY = 660;
const invoke = async (cmd, args = {}) => {
  const r = await d.req("POST", d.s("/execute/async"), {
    script:
      "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then((v) => done({ ok: v ?? null }), (e) => done({ err: String(e?.message ?? e) }));",
    args: [cmd, args],
  });
  if (r.err) throw new Error(`${cmd}: ${r.err}`);
  return r.ok;
};
const refused = async (cmd, args = {}) => {
  try {
    await invoke(cmd, args);
  } catch (e) {
    return e.message;
  }
  throw new Error(`${cmd} выполнилась, а должна быть отклонена`);
};
async function closeCompose() {
  await d.click(await d.until("discard", () => d.find(".compose [aria-label='Удалить черновик'], .compose [aria-label='Discard draft']").catch(() => null)));
  const ok = await d.find(".modal.confirm .btn.primary").catch(() => null);
  if (ok) await d.click(ok);
  await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0, 15000);
}
/** A key as the window sees it (shortcuts listen on window); `c` is a new letter. */
const press = (key) => d.exec("window.dispatchEvent(new KeyboardEvent('keydown', { key: arguments[0], bubbles: true }))", key);

/** The system's drag of files from another window, see e2e/native-drop.ps1. */
function nativeDrop({ paths, hover, to, title }) {
  const list = join(fix.dir, "files.txt");
  writeFileSync(list, paths.join("\n"), "utf-8");
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "e2e/native-drop.ps1"), "-List", list,
      "-HoverX", hover.x, "-HoverY", hover.y, "-ToX", to.x, "-ToY", to.y, "-FormY", formY, ...(title ? ["-Title", title] : [])].map(String),
    { encoding: "utf-8", timeout: 60000 },
  );
  console.log(`    native-drop: ${(r.stdout + r.stderr).trim().replace(/\s+/g, " ")} (exit ${r.status})`);
  if (r.status !== 0) throw new Error(`настоящий бросок не состоялся (код ${r.status}): ${r.stderr.trim()}`);
}

/** The size of the main window, which a letter's window is given as well. */
let windowSize = null;
const SEED_TITLE = "Seed letter";

/**
 * A letter's own window with no mail server: the test build puts a letter into the cache
 * (`e2e_seed_message`) and `message_window` opens it, as a double click in the list does.
 * `fn` works in that window; the main one is back in front afterwards.
 */
async function inLetterWindow(fn) {
  const account = (await invoke("accounts"))[0];
  const id = await invoke("e2e_seed_message", { accountId: account.id });
  const main = await d.req("GET", d.s("/window"));
  await invoke("message_window", { id, title: SEED_TITLE });
  const handles = () => d.req("GET", d.s("/window/handles"));
  await d.until("the letter's window", async () => (await handles()).length === 2, 20000);
  const other = (await handles()).find((h) => h !== main);
  await d.req("POST", d.s("/window"), { handle: other });
  try {
    if (windowSize) await d.req("POST", d.s("/window/rect"), { x: 0, y: 0, ...windowSize });
    await d.until("the letter", async () => (await d.exec("return document.querySelector('.reader h1')?.innerText ?? ''")).includes(SEED_TITLE), 30000);
    await fn({
      title: SEED_TITLE,
      openReply: async () => {
        await d.exec("document.activeElement?.blur?.()");
        await press("r");
        await d.until("reply", async () => (await d.findAll(".compose .rich")).length === 1, 20000);
      },
    });
    // Esc closes the window of a letter with nothing being written.
    await press("Escape");
    await d.until("the letter's window closed", async () => (await handles()).length === 1, 20000);
  } finally {
    await d.req("POST", d.s("/window"), { handle: main }).catch(() => {});
  }
}

try {
  await d.until("tauri-driver", async () => {
    await fetch("http://127.0.0.1:4444/status");
    return true;
  }, 30000);
  await d.start(app);

  await step("0", "ящик без сервера и страница с ним", async () => {
    await d.until("the app", async () => (await d.findAll("body")).length === 1, 60000);
    await d.until("tauri api", async () => d.exec("return !!window.__TAURI_INTERNALS__"), 60000);
    await invoke("account_save", {
      account: {
        id: "",
        display_name: "Кэрол Тестова",
        email: "carol@local.test",
        username: "carol",
        imap: { host: "127.0.0.1", port: 3143, security: "plain" },
        smtp: { host: "127.0.0.1", port: 3025, security: "plain" },
      },
      password: "secret",
    });
    // The window fits the runner's screen, with room under it for the form that carries the drag.
    // WebDriver sizes a window in the page's pixels, so a scaled page asks for fewer of them.
    if (windows) {
      const [dpr, screenW, screenH] = await d.exec("return [window.devicePixelRatio, screen.width * window.devicePixelRatio, screen.height * window.devicePixelRatio]");
      const width = Math.min(900, Math.floor((screenW - 20) / dpr));
      const height = Math.min(600, Math.floor((screenH - 120) / dpr));
      await d.req("POST", d.s("/window/rect"), { x: 0, y: 0, width, height });
      windowSize = { width, height };
      formY = Math.round(height * dpr) + 20;
      console.log(`    screen ${screenW}x${screenH} px, window ${width}x${height} (dpr ${dpr}), form at y=${formY}`);
    }
    await d.exec("location.reload()");
    await d.until("the main page", async () => (await d.findAll("nav.side")).length === 1, 60000);
  }, { critical: true });

  await dropSteps({
    d,
    step,
    refused,
    fix,
    nativeDrop: windows ? nativeDrop : null,
    inLetterWindow,
    expectDpr: process.env.E2E_EXPECT_DPR ? Number(process.env.E2E_EXPECT_DPR) : null,
    minDpr: process.env.E2E_MIN_DPR ? Number(process.env.E2E_MIN_DPR) : null,
    openCompose: async () => {
      await d.exec("document.activeElement?.blur?.()");
      await press("c");
      await d.until("compose", async () => (await d.findAll(".compose .rich")).length === 1, 20000);
    },
    closeCompose,
  });
  await screenshot("final");
} catch (e) {
  if (e instanceof Abort) console.error(`\nПрогон остановлен: ${e.message}.`);
  else console.error("Прогон прерван:", e);
  results.push({ criteria: "-", name: "прогон", ok: false, error: e.message });
} finally {
  await d.quit();
  driverProc.kill();
  fix.clean();
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\nИтог: ${results.length - failed.length} из ${results.length} шагов прошли.`);
writeFileSync(join(screens, "drops-results.json"), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
