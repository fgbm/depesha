// The ground of the e2e run (e2e/run.mjs): the paths and the environment of the app, the driver, the
// step runner, and the helpers every section of e2e/sections/ uses to find, press and read. One import
// of this module is the whole of the run's state; the sections hold only their steps.

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { Driver, reloadWindow as reload } from "./webdriver.mjs";
import { exited, groupAlive, killGroup } from "./procs.mjs";
import { ESCAPE_SCRIPT, createFailFirst, createStepRunner } from "./step.mjs";
import { createSectionGate, selectSections } from "./shard.mjs";
import { ensureStandLock } from "./stand-lock.mjs";

ensureStandLock();

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const app = process.env.DEPESHA_APP ?? join(root, "target/debug/depesha");
export const nativeDriver = process.env.WEBKIT_DRIVER ?? join(process.env.HOME, ".local/depesha-testenv/root/usr/bin/WebKitWebDriver");
export const screens = join(root, "e2e/screens");
mkdirSync(screens, { recursive: true });

export const profile = mkdtempSync(join(tmpdir(), "depesha-e2e-"));
export const env = {
  ...process.env,
  DISPLAY: process.env.E2E_DISPLAY ?? ":99",
  GDK_BACKEND: "x11",
  WAYLAND_DISPLAY: "",
  XDG_CONFIG_HOME: join(profile, "config"),
  XDG_DATA_HOME: join(profile, "data"),
  XDG_CACHE_HOME: join(profile, "cache"),
  WEBKIT_DISABLE_COMPOSITING_MODE: "1",
  DEPESHA_NO_NOTIFICATIONS: "1",
  // A build with the `e2e` feature takes files here as chosen in a dialog: WebDriver cannot answer one.
  DEPESHA_E2E_ROOT: [profile, root].join(delimiter),
  // A copy of a sent letter the server refuses waits seconds, not half an hour, before its next try (#88).
  DEPESHA_E2E_COPY_BACKOFF: "3",
  // Test builds only: an own-fields write of a mailbox lands 200 ms late and a check of the connection takes 3 s, so a step can tell a quit that waits for the write from one that does not (7.28) and act while a check is under way (7.26).
  DEPESHA_E2E_PATCH_DELAY_MS: "200",
  DEPESHA_E2E_CHECK_DELAY_MS: "3000",
  // The scenario reads Russian text; the language follows the locale (LANGUAGE wins).
  LANGUAGE: "ru",
  // E2E_DARK=1: the whole run in the dark theme, for its screenshots.
  ...(process.env.E2E_DARK ? { GTK_THEME: "Adwaita:dark" } : {}),
};

export const results = [];
export let shot = 0;
export const d = new Driver();

export function helper(...args) {
  return execFileSync("python3", [join(root, "e2e/imap_helper.py"), ...args], { encoding: "utf-8" }).trim();
}

export async function screenshot(name, { toasts = false } = {}) {
  // Toasts are transient; hide them for the picture without touching Svelte's DOM
  // (`toasts: true` keeps them: the picture is about a toast).
  if (!toasts) await d.exec("document.querySelector('.toasts')?.style.setProperty('visibility', 'hidden')").catch(() => {});
  const file = join(screens, `${String(++shot).padStart(2, "0")}-${name}.png`);
  writeFileSync(file, await d.screenshot());
  await d.exec("document.querySelector('.toasts')?.style.removeProperty('visibility')").catch(() => {});
}

/** Steps that passed only on the second try: the summary lists them, they are not hidden. */
export const retried = [];

/** Only a step marked `{ retry: true }` is restarted (see e2e/step.mjs); `critical` aborts the run. */
export const runStep = createStepRunner({ screenshot, tidyUp, log: console.log, results, retried });

/** DEPESHA_E2E_SHARD=2/3 (or a list of sections): this run is one part of the scenario (e2e/shard.mjs); the steps of the other parts are not run. */
export const { section, gate } = createSectionGate(selectSections(process.env.DEPESHA_E2E_SHARD));
export const step = gate(runStep);

/** Closes what a failed step left open (`ESCAPE_SCRIPT`): it would cover the next step's clicks. */
export async function tidyUp() {
  for (let i = 0; i < 3; i++) {
    await d.exec(ESCAPE_SCRIPT).catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** DEPESHA_E2E_FAIL_FIRST=6.4,7.21: the first try of these steps fails after the input (a test of the retry). */
export const failFirst = createFailFirst(process.env.DEPESHA_E2E_FAIL_FIRST);
export const injectFailure = failFirst.inject;

export async function rowBySubject(subject, timeoutMs = 15000) {
  const xpath = `//div[contains(@class,'row')][.//span[contains(@class,'subject') and contains(., ${JSON.stringify(subject)})]]`;
  return d.until(`row "${subject}"`, async () => {
    const row = await d.xpath(xpath).catch(() => null);
    if (row) return row;
    // The list draws only the rows in view: scroll on, as a person would, and from the top
    // again at the end. The scroll event is dispatched by hand — setting `scrollTop` alone
    // does not always make WebKitWebDriver redraw the virtual list or load the next page.
    await d.exec(`const v = document.querySelector('.list .viewport');
      if (v) {
        const next = v.scrollTop + v.clientHeight >= v.scrollHeight - 1 ? 0 : v.scrollTop + v.clientHeight;
        if (next !== v.scrollTop) { v.scrollTop = next; v.dispatchEvent(new Event('scroll')); }
      }`);
    return null;
  }, timeoutMs);
}

export async function openBySubject(subject) {
  // A row found and clicked may still miss: the virtual list re-renders under the pointer
  // and the reader shows another letter. Retry until the reader shows this one.
  await d.until(`reader shows "${subject}"`, async () => {
    if ((await textOf(".reader h1")).includes(subject)) return true;
    const row = await rowBySubject(subject, 3000).catch(() => null);
    if (!row) return false;
    await d.click(row).catch(() => {});
    return (await textOf(".reader h1")).includes(subject);
  }, 20000);
}

export const reloadWindow = () => reload(d);

export async function openFolder(name) {
  await d.exec(
    // By the folder's name: the row also holds its counter.
    `[...document.querySelectorAll('nav.side .item')].find((b) => (b.querySelector('.name') ?? b).innerText.trim() === arguments[0]).click();`,
    name,
  );
}

/** Picks an item of the list's "View" menu (filter or order) and closes the menu. */
export async function viewOption(label) {
  if (!(await d.exec("return !!document.querySelector('.pop')"))) await d.click(await d.find(".list .view .trigger"));
  const item = await d.until(`view item ${label}`, () =>
    d.xpath(`//div[contains(@class,'pop')]//button[contains(@class,'mi') and normalize-space(.)=${JSON.stringify(label)}]`),
  );
  await d.click(item);
  await press("Escape");
}

export async function textOf(css) {
  return d.exec("return document.querySelector(arguments[0])?.innerText ?? ''", css);
}

export async function setInput(css, value) {
  const el = await d.find(css);
  await d.clear(el);
  await d.type(el, String(value));
}

/** Picks in the app's own drop-down list (Select.svelte) the way a user does. */
export async function setSelect(css, value) {
  await d.click(await d.find(`${css} .trigger`));
  await d.click(await d.until(`option ${value}`, () => d.find(`${css} [role=option][data-value="${value}"]`).catch(() => null)));
}

/** The reminder's menu of the compose window (#103): the «Snooze» menu with two rows more. */
export async function remindMenu() {
  await d.click(await d.find(".compose .remind"));
  await d.until("remind menu", async () => (await d.findAll(".snooze .pop.main")).length === 1);
}

/** Chooses a reminder by typing into the line of that menu, as a user does: «через 3 дня», Enter. */
export async function remindBy(text) {
  await remindMenu();
  await d.type(await d.find(".snooze .pop.main input"), text);
  await d.type(await d.find(".snooze .pop.main input"), "\uE007");
  await d.until("remind menu closed", async () => (await d.findAll(".snooze .pop.main")).length === 0);
}

/** An Alt key of the compose window, pressed where the caret is: in the text, unless a field is named. */
export async function altKey(key, code, css = ".compose .subject") {
  await pressIn(css, key, { altKey: true, code });
}

/** Calls a backend command the way the GUI does. */
export async function invoke(cmd, args = {}) {
  const r = await d.req("POST", d.s("/execute/async"), {
    script:
      "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then((v) => done({ ok: v ?? null }), (e) => done({ err: String(e?.message ?? e) }));",
    args: [cmd, args],
  });
  if (r.err) throw new Error(`${cmd}: ${r.err}`);
  return r.ok;
}

/** A command the backend must refuse: returns its error. */
export async function refused(cmd, args = {}) {
  const r = await d.req("POST", d.s("/execute/async"), {
    script:
      "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then((v) => done({ ok: v ?? null }), (e) => done({ err: String(e?.message ?? e) }));",
    args: [cmd, args],
  });
  if (!r.err) throw new Error(`${cmd} выполнилась, а должна быть отклонена`);
  return r.err;
}

/**
 * The next folder dialog (`pick_folder`) answers `path` without showing up.
 * Tauri defines `__TAURI_INTERNALS__.invoke` read-only, so assigning over it is
 * silently ignored; the call is caught one level down, where the IPC goes out
 * as `fetch("ipc://localhost/<command>")`.
 */
export function pickFolder(path) {
  return d.exec(`
    const path = arguments[0];
    const fetch = window.fetch;
    window.fetch = (url, init) => {
      if (!decodeURIComponent(String(url)).endsWith("/pick_folder")) return fetch(url, init);
      window.fetch = fetch;
      return Promise.resolve(new Response(JSON.stringify(path), {
        headers: { "Content-Type": "application/json", "Tauri-Response": "ok" },
      }));
    };`, path);
}

export async function idOf(subject) {
  const rows = await invoke("messages", { query: { role: "inbox", limit: 2000 } });
  const row = rows.find((m) => m.subject.includes(subject));
  if (!row) throw new Error(`нет письма «${subject}» в кэше`);
  return row.id;
}

/** A key press as the window sees it (shortcuts listen on window). */
export async function press(key, mods = {}) {
  await d.exec("window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: arguments[0], bubbles: true }, arguments[1])))", key, mods);
}

/** A key press on an element (the palette input listens on itself, not on the window). */
export async function pressIn(css, key, mods = {}) {
  await d.exec(
    "document.querySelector(arguments[0]).dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: arguments[1], bubbles: true }, arguments[2])))",
    css,
    key,
    mods,
  );
}

export async function newMessage(to, subject, text) {
  await d.button("Написать");
  await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
  await d.type((await d.findAll(".compose .box input"))[0], to);
  await setInput(".compose .subject", subject);
  await d.exec(
    "const t = document.querySelector('.compose textarea'); t.focus(); t.setSelectionRange(0, 0); document.execCommand('insertText', false, arguments[0]);",
    text,
  );
}

/**
 * A tall picture is picked and the text is scrolled until its top is out of sight: the frame and the panel must stay inside the text box, not climb over the fields and the toolbar above it. The clipped rectangle is read the way the eye sees it: the frame's box cut by every ancestor that clips.
 */
export async function pictureFrameInSight(label) {
  const seen = () =>
    d.exec(`
      const rich = document.querySelector('.compose .rich');
      const rb = rich.getBoundingClientRect();
      const view = { left: rb.left + rich.clientLeft, top: rb.top + rich.clientTop, right: rb.left + rich.clientLeft + rich.clientWidth, bottom: rb.top + rich.clientTop + rich.clientHeight };
      const cut = (el) => {
        let r = el.getBoundingClientRect();
        let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        for (let p = el.parentElement; p; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
          const q = p.getBoundingClientRect();
          box = { left: Math.max(box.left, q.left), top: Math.max(box.top, q.top), right: Math.min(box.right, q.right), bottom: Math.min(box.bottom, q.bottom) };
        }
        return box.right > box.left && box.bottom > box.top ? box : null;
      };
      const frame = document.querySelector('.compose .rich-wrap .frame');
      const bar = document.querySelector('.compose .rich-wrap .picture-bar');
      const img = rich.querySelector('img');
      const ir = img.getBoundingClientRect();
      return { view, frame: frame && cut(frame), bar: bar && cut(bar), imgTop: ir.top, imgBottom: ir.bottom };
    `);
  const inside = (b, v) => b.left >= v.left - 1 && b.top >= v.top - 1 && b.right <= v.right + 1 && b.bottom <= v.bottom + 1;
  await d.exec(
    `const r = document.querySelector('.compose .rich'); r.focus(); document.execCommand('insertHTML', false, '<div>Верх</div>');
     const c = document.createElement('canvas'); c.width = 400; c.height = r.clientHeight * 2;
     const g = c.getContext('2d'); g.fillStyle = '#9ab'; g.fillRect(0, 0, c.width, c.height);
     document.execCommand('insertHTML', false, '<img src="' + c.toDataURL('image/png') + '"><div style="height:' + r.clientHeight * 2 + 'px">Низ</div>');`,
  );
  await d.click(await d.until("picture", () => d.find(".compose .rich img")));
  await d.until("frame", async () => (await d.findAll(".compose .rich-wrap .frame")).length === 1);
  await d.until("panel", async () => (await d.findAll(".compose .rich-wrap .picture-bar")).length === 1);
  await screenshot(`picture-frame-${label}-whole`);
  // The picture runs below the text, so the panel sticks to its lower edge: measured, not guessed, it fits.
  const whole = await seen();
  if (!whole.bar || !inside(whole.bar, whole.view)) throw new Error(`${label}: плашка сразу после выделения выходит из поля текста: ${JSON.stringify({ bar: whole.bar, view: whole.view })}`);
  // The top of the picture goes 150 px past the upper edge of the text.
  await d.exec("const r = document.querySelector('.compose .rich'); const img = r.querySelector('img'); r.scrollTop += img.getBoundingClientRect().top - r.getBoundingClientRect().top + 150;");
  const s = await d.until("scrolled", async () => {
    const now = await seen();
    return now.imgTop < now.view.top - 100 && now.frame ? now : null;
  }, 5000);
  await screenshot(`picture-frame-${label}-scrolled`);
  if (!inside(s.frame, s.view)) throw new Error(`${label}: рамка картинки выходит из поля текста: ${JSON.stringify({ frame: s.frame, view: s.view })}`);
  if (s.bar && !inside(s.bar, s.view)) throw new Error(`${label}: плашка картинки выходит из поля текста: ${JSON.stringify({ bar: s.bar, view: s.view })}`);
  // The picture is scrolled away altogether: no frame to see.
  await d.exec("const r = document.querySelector('.compose .rich'); const img = r.querySelector('img'); r.scrollTop += img.getBoundingClientRect().bottom - r.getBoundingClientRect().top + 40;");
  const gone = await d.until("out of sight", async () => {
    const now = await seen();
    return now.imgBottom < now.view.top ? now : null;
  }, 5000);
  if (gone.frame || gone.bar) throw new Error(`${label}: картинки не видно, а рамка или плашка на месте: ${JSON.stringify(gone)}`);
  // A picture nobody sees is not deleted by a key.
  const count = async () => (await d.findAll(".compose .rich img")).length;
  const pictures = await count();
  for (const key of ["Backspace", "Delete"]) {
    await pressIn(".compose .rich", key);
    if ((await count()) !== pictures) throw new Error(`${label}: ${key} стёр картинку, которой не видно`);
  }
}

export async function composeClosed() {
  await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0, 15000);
}

/** Closes the settings window without touching what it saves with its own button. */
export async function closeSettings() {
  if ((await d.findAll(".prefs")).length === 0) return;
  // A mailbox's page keeps its own footer and hides the shared one, so its «Cancel»
  // would only go back to the list. Escape closes the window from anywhere inside it,
  // and its handler sits on the window element: the event must start there.
  await d.exec(
    "document.querySelector('.modal.prefs')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
  );
  await d.until("settings closed", async () => (await d.findAll(".prefs")).length === 0);
}

/** What has the focus in the settings, for the message of a step that waited for a row to get it. */
export const focusInfo = () =>
  d.exec(
    "const a = document.activeElement; return { active: a ? `${a.tagName}.${a.className} ${a.dataset?.row ?? ''}` : null, hasFocus: document.hasFocus(), page: document.querySelector('.prefs .pane h2')?.textContent, rows: [...document.querySelectorAll('.prefs [data-row]')].map((r) => r.dataset.row).join(',') };",
  );

/** The page of one mailbox: the «Mailboxes» page of the settings lists them, in the order of `accounts` (#102, 2.6 Б). */
export async function openMailboxPage(id) {
  await press(",", { ctrlKey: true });
  await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
  await d.click(await d.find(".prefs .tab[data-page='accounts']"));
  await d.until("manager", async () => (await d.findAll(".prefs .accounts")).length === 1);
  const at = Math.max(0, (await invoke("accounts")).findIndex((a) => a.id === id));
  await d.click((await d.findAll(".prefs .accounts .acc > .btn.icon"))[at]);
  await d.until("mailbox page", async () => (await d.findAll(".prefs .account-page")).length === 1);
}

export async function sidebarText() {
  return d.exec("return document.querySelector('nav.side').innerText");
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits until the X server of `display` takes connections: CI starts Xvfb in the background a moment
 *  before the run, and an app that meets no server panics in GTK ("Failed to initialize gtk backend"),
 *  while tauri-driver keeps the session request waiting (#129). Only a local display (`:N`) is checked. */
export async function waitDisplay(display, timeoutMs = 30000) {
  const n = /^:(\d+)/.exec(display)?.[1];
  if (n === undefined) return;
  await d.until(`X server ${display}`, () => new Promise((resolve) => {
    const s = connect(`/tmp/.X11-unix/X${n}`);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  }), timeoutMs, 200);
}

export let driverProc;

/** tauri-driver and the session: the driver is up when it answers `/status`; a session that does not
 *  start in a minute (the app died on start, the driver waits for it for good) is tried again on a
 *  fresh driver, three times. Only the start is repeated, never a step. */
export async function startSession() {
  for (let attempt = 1; ; attempt++) {
    driverProc = spawn(join(process.env.HOME, ".cargo/bin/tauri-driver"), ["--native-driver", nativeDriver], {
      env,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    });
    try {
      await d.until("tauri-driver", async () => (await fetch("http://127.0.0.1:4444/status", { signal: AbortSignal.timeout(2000) })).ok, 30000);
      // E2E_FIRST_START_TIMEOUT_MS: a test of this very retry makes the first attempt too short to finish.
      await d.start(app, {}, attempt === 1 && process.env.E2E_FIRST_START_TIMEOUT_MS ? Number(process.env.E2E_FIRST_START_TIMEOUT_MS) : 60000);
      return;
    } catch (e) {
      // The app is a child of WebKitWebDriver: the group goes, or it holds the single-instance name.
      killGroup(driverProc);
      await exited(driverProc);
      console.error(`Группа драйвера ${groupAlive(driverProc) ? "ещё жива" : "завершена"}`);
      if (attempt === 3) throw e;
      console.error(`Старт сессии, попытка ${attempt} из 3: ${e.message}; драйвер запускается заново`);
      await sleep(2000);
    }
  }
}

/** The text of the letter the run sends first and finds again; the stamp tells this run's letters from others'. */
export const stamp = new Date().toISOString().slice(11, 19);
export const subject = `E2E проверка ${stamp}`;

