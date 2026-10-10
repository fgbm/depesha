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
// (DEPESHA_STAND_LOCKED=1), the run starts itself again under `flock` and waits its turn.

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { Driver } from "./webdriver.mjs";
import { Abort, createStepRunner } from "./step.mjs";
import { dropFixtures, dropOn, dropSteps, zonesStayInView } from "./drop-steps.mjs";
import { createSectionGate, selectSections } from "./shard.mjs";

if (!process.env.DEPESHA_STAND_LOCKED) {
  const lock = process.env.DEPESHA_STAND_LOCK ?? join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "depesha-e2e.lock");
  const again = (flags) =>
    spawnSync("flock", [...flags, lock, process.execPath, ...process.argv.slice(1)], {
      stdio: "inherit",
      env: { ...process.env, DEPESHA_STAND_LOCKED: "1" },
    });
  // 200: flock's own "busy" code (-E), so it cannot be taken for the run's exit code.
  let done = again(["-n", "-E", "200"]);
  if (done.status === 200) {
    console.log(`стенд занят, жду до часа… (${lock})`);
    done = again(["-w", "3600", "-E", "200"]);
    if (done.status === 200) {
      console.error(`стенд не освободился за час (${lock}): прогон не начат`);
      process.exit(1);
    }
  }
  if (done.error) throw done.error;
  process.exit(done.status ?? 1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = process.env.DEPESHA_APP ?? join(root, "target/debug/depesha");
const nativeDriver = process.env.WEBKIT_DRIVER ?? join(process.env.HOME, ".local/depesha-testenv/root/usr/bin/WebKitWebDriver");
const screens = join(root, "e2e/screens");
mkdirSync(screens, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "depesha-e2e-"));
const env = {
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

const results = [];
let shot = 0;
const d = new Driver();

function helper(...args) {
  return execFileSync("python3", [join(root, "e2e/imap_helper.py"), ...args], { encoding: "utf-8" }).trim();
}

async function screenshot(name, { toasts = false } = {}) {
  // Toasts are transient; hide them for the picture without touching Svelte's DOM
  // (`toasts: true` keeps them: the picture is about a toast).
  if (!toasts) await d.exec("document.querySelector('.toasts')?.style.setProperty('visibility', 'hidden')").catch(() => {});
  const file = join(screens, `${String(++shot).padStart(2, "0")}-${name}.png`);
  writeFileSync(file, await d.screenshot());
  await d.exec("document.querySelector('.toasts')?.style.removeProperty('visibility')").catch(() => {});
}

/** Steps that passed only on the second try: the summary lists them, they are not hidden. */
const retried = [];

/** Only a step marked `{ retry: true }` is restarted (see e2e/step.mjs); `critical` aborts the run. */
const runStep = createStepRunner({ screenshot, tidyUp, log: console.log, results, retried });

/** DEPESHA_E2E_SHARD=2/3 (or a list of sections): this run is one part of the scenario (e2e/shard.mjs); the steps of the other parts are not run. */
const { section, gate } = createSectionGate(selectSections(process.env.DEPESHA_E2E_SHARD));
const step = gate(runStep);

/** Closes what a failed step left open (menus, the viewer, dialogs): it would cover the next step's clicks. */
async function tidyUp() {
  // Like closeSettings(): the settings window and the search box listen on themselves, not on
  // the window, so the key starts at the window element or at the focused one.
  for (let i = 0; i < 3; i++) {
    await d
      .exec(
        `const t = document.querySelector('.modal.prefs') ?? document.activeElement ?? document.body;
         t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`,
      )
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** DEPESHA_E2E_FAIL_FIRST=6.4,7.21: the first try of these steps fails after the input (a test of the retry). */
const failFirst = new Set((process.env.DEPESHA_E2E_FAIL_FIRST ?? "").split(",").filter(Boolean));
function injectFailure(id) {
  if (failFirst.delete(id)) throw new Error(`DEPESHA_E2E_FAIL_FIRST: ${id}`);
}

async function rowBySubject(subject, timeoutMs = 15000) {
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

async function openBySubject(subject) {
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

async function openFolder(name) {
  await d.exec(
    // By the folder's name: the row also holds its counter.
    `[...document.querySelectorAll('nav.side .item')].find((b) => (b.querySelector('.name') ?? b).innerText.trim() === arguments[0]).click();`,
    name,
  );
}

/** Picks an item of the list's "View" menu (filter or order) and closes the menu. */
async function viewOption(label) {
  if (!(await d.exec("return !!document.querySelector('.pop')"))) await d.click(await d.find(".list .view .trigger"));
  const item = await d.until(`view item ${label}`, () =>
    d.xpath(`//div[contains(@class,'pop')]//button[contains(@class,'mi') and normalize-space(.)=${JSON.stringify(label)}]`),
  );
  await d.click(item);
  await press("Escape");
}

async function textOf(css) {
  return d.exec("return document.querySelector(arguments[0])?.innerText ?? ''", css);
}

async function setInput(css, value) {
  const el = await d.find(css);
  await d.clear(el);
  await d.type(el, String(value));
}

/** Picks in the app's own drop-down list (Select.svelte) the way a user does. */
async function setSelect(css, value) {
  await d.click(await d.find(`${css} .trigger`));
  await d.click(await d.until(`option ${value}`, () => d.find(`${css} [role=option][data-value="${value}"]`).catch(() => null)));
}

/** The reminder's menu of the compose window (#103): the «Snooze» menu with two rows more. */
async function remindMenu() {
  await d.click(await d.find(".compose .remind"));
  await d.until("remind menu", async () => (await d.findAll(".snooze .pop.main")).length === 1);
}

/** Chooses a reminder by typing into the line of that menu, as a user does: «через 3 дня», Enter. */
async function remindBy(text) {
  await remindMenu();
  await d.type(await d.find(".snooze .pop.main input"), text);
  await d.type(await d.find(".snooze .pop.main input"), "\uE007");
  await d.until("remind menu closed", async () => (await d.findAll(".snooze .pop.main")).length === 0);
}

/** An Alt key of the compose window, pressed where the caret is: in the text, unless a field is named. */
async function altKey(key, code, css = ".compose .subject") {
  await pressIn(css, key, { altKey: true, code });
}

/** Calls a backend command the way the GUI does. */
async function invoke(cmd, args = {}) {
  const r = await d.req("POST", d.s("/execute/async"), {
    script:
      "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then((v) => done({ ok: v ?? null }), (e) => done({ err: String(e?.message ?? e) }));",
    args: [cmd, args],
  });
  if (r.err) throw new Error(`${cmd}: ${r.err}`);
  return r.ok;
}

/** A command the backend must refuse: returns its error. */
async function refused(cmd, args = {}) {
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
function pickFolder(path) {
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

async function idOf(subject) {
  const rows = await invoke("messages", { query: { role: "inbox", limit: 2000 } });
  const row = rows.find((m) => m.subject.includes(subject));
  if (!row) throw new Error(`нет письма «${subject}» в кэше`);
  return row.id;
}

/** A key press as the window sees it (shortcuts listen on window). */
async function press(key, mods = {}) {
  await d.exec("window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: arguments[0], bubbles: true }, arguments[1])))", key, mods);
}

/** A key press on an element (the palette input listens on itself, not on the window). */
async function pressIn(css, key, mods = {}) {
  await d.exec(
    "document.querySelector(arguments[0]).dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: arguments[1], bubbles: true }, arguments[2])))",
    css,
    key,
    mods,
  );
}

async function newMessage(to, subject, text) {
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
async function pictureFrameInSight(label) {
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

async function composeClosed() {
  await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0, 15000);
}

/** Closes the settings window without touching what it saves with its own button. */
async function closeSettings() {
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
const focusInfo = () =>
  d.exec(
    "const a = document.activeElement; return { active: a ? `${a.tagName}.${a.className} ${a.dataset?.row ?? ''}` : null, hasFocus: document.hasFocus(), page: document.querySelector('.prefs .pane h2')?.textContent, rows: [...document.querySelectorAll('.prefs [data-row]')].map((r) => r.dataset.row).join(',') };",
  );

/** The page of one mailbox: the «Mailboxes» page of the settings lists them, in the order of `accounts` (#102, 2.6 Б). */
async function openMailboxPage(id) {
  await press(",", { ctrlKey: true });
  await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
  await d.click(await d.find(".prefs .tab[data-page='accounts']"));
  await d.until("manager", async () => (await d.findAll(".prefs .accounts")).length === 1);
  const at = Math.max(0, (await invoke("accounts")).findIndex((a) => a.id === id));
  await d.click((await d.findAll(".prefs .accounts .acc > .btn.icon"))[at]);
  await d.until("mailbox page", async () => (await d.findAll(".prefs .account-page")).length === 1);
}

async function sidebarText() {
  return d.exec("return document.querySelector('nav.side').innerText");
}

const driverProc = spawn(join(process.env.HOME, ".cargo/bin/tauri-driver"), ["--native-driver", nativeDriver], {
  env,
  stdio: ["ignore", "inherit", "inherit"],
});

try {
  await d.until("tauri-driver", async () => {
    await fetch("http://127.0.0.1:4444/status");
    return true;
  }, 10000);
  await d.start(app);
  console.log(`Профиль: ${profile}`);

  const stamp = new Date().toISOString().slice(11, 19);
  const subject = `E2E проверка ${stamp}`;

  await step("1.1", "мастер открывается на пустом профиле", async () => {
    await d.until("wizard", async () => (await d.bodyText()).includes("Добавить почтовый ящик"));
    await screenshot("wizard");
  }, { critical: true });

  await step("1.1", "автоопределение и ручная правка параметров", async () => {
    await setInput(".wizard input[placeholder='Иван Петров']", "Кэрол Тестова");
    await setInput(".wizard input[type=email]", "carol@local.test");
    await setInput(".wizard input[type=password]", "secret");
    await d.button("Далее");
    await d.until("settings step", async () => (await d.bodyText()).includes("Входящая почта (IMAP)"), 30000);
    await setInput(".wizard input[placeholder^='адрес или']", "carol");
    const hosts = await d.findAll(".wizard fieldset .host input");
    const ports = await d.findAll(".wizard fieldset .port input");
    await setSelect(".wizard fieldset:nth-of-type(1) .select", "plain");
    await setSelect(".wizard fieldset:nth-of-type(2) .select", "plain");
    for (const [i, [host, port]] of [["127.0.0.1", 3143], ["127.0.0.1", 3025]].entries()) {
      await d.clear(hosts[i]);
      await d.type(hosts[i], host);
      await d.clear(ports[i]);
      await d.type(ports[i], String(port));
    }
    await screenshot("wizard-settings");
  }, { critical: true });

  await step("1.2", "неверный пароль даёт понятную ошибку", async () => {
    await setInput(".wizard .grid input[type=password]", "wrong");
    await d.button("Проверить и сохранить");
    await d.until("auth error", async () => (await d.bodyText()).includes("отклонил вход"), 20000);
    await screenshot("wizard-auth-error");
  });

  await step("1.2", "проверка входа и сохранение", async () => {
    await setInput(".wizard .grid input[type=password]", "secret");
    await d.button("Проверить и сохранить");
    await d.until("wizard closed", async () => (await d.findAll(".wizard")).length === 0, 30000);
  }, { critical: true });

  await step("1.3", "пароль не попал в файлы профиля", async () => {
    const cfg = readFileSync(join(profile, "config/ru.depesha.mail/accounts.json"), "utf-8");
    if (cfg.includes("secret")) throw new Error("пароль найден в accounts.json");
    if (!cfg.includes("carol@local.test")) throw new Error("учётная запись не сохранена");
    let found = "";
    try {
      // grep exits 1 when nothing matches: that is the good outcome.
      found = execFileSync("grep", ["-rlaF", "--", "secret", profile], { encoding: "utf-8" });
    } catch {}
    if (found.trim()) throw new Error(`пароль найден в файлах: ${found}`);
  });

  await step("5.9", "новая установка пишет письма в HTML", async () => {
    const settings = await invoke("settings_get");
    if (settings.compose_format !== "html") throw new Error(`формат новых писем: ${settings.compose_format}`);
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose .rich")).length === 1);
    // The format button of the footer shows the current mode and opens its menu (#45, frame 6).
    const fmt = await d.find(".compose footer button[aria-label='Формат письма']");
    if (!(await d.text(fmt)).includes("HTML")) throw new Error(`подпись кнопки формата: ${await d.text(fmt)}`);
    await d.click(fmt);
    const modes = await d.exec("return [...document.querySelectorAll('.pop [role=menuitemradio]')].map((b) => b.textContent.trim() + (b.getAttribute('aria-checked') === 'true' ? '*' : ''))");
    if (modes.join(" ") !== "Обычный текст HTML* Markdown") throw new Error(`формат письма в меню кнопки: ${modes.join(" ")}`);
    await d.click(fmt);
    if ((await d.findAll(".compose [role=toolbar] button")).length < 9) throw new Error("нет строки оформления");
    await d.click(await d.find(".compose header > button:last-child"));
    await composeClosed();
  });

  await step("5.9", "HTML-письмо с картинкой в тексте уходит с частью multipart/related", async () => {
    const subj = `Картинка ${stamp}`;
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose .rich")).length === 1);
    await d.type((await d.findAll(".compose .box input"))[0], "carol@local.test");
    await setInput(".compose .subject", subj);
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    await d.exec(
      "const r = document.querySelector('.compose .rich'); r.focus(); document.execCommand('insertHTML', false, arguments[0]);",
      `<div>Фото <b>зала</b>:</div><img src="data:image/png;base64,${png}">`,
    );
    await d.button("Отправить");
    await composeClosed();
    await d.until("delivered", async () => helper("count", "INBOX", subj) === "1", 60000, 1000);
    const raw = helper("raw", "INBOX", subj);
    for (const want of ["multipart/alternative", "text/plain", "multipart/related", "text/html", "image/png", "Content-ID: <"]) {
      if (!raw.includes(want)) throw new Error(`в письме нет ${want}`);
    }
    // The copy that came back stays in INBOX and would shift the counts below.
    helper("delete", "INBOX", subj);
    await d.until("copy gone", async () => helper("count", "INBOX", subj) === "0", 15000);
    // The steps below type into the plain-text field.
    const settings = await invoke("settings_get");
    await invoke("settings_set", { settings: { ...settings, compose_format: "plain" } });
    await d.until("plain format", async () => (await invoke("settings_get")).compose_format === "plain");
  });

  await step("3.1–3.3", "папки: роли, русские имена, служебные скрыты", async () => {
    const text = await d.until("folders", async () => {
      const t = await sidebarText();
      return t.includes("Корзина") && t.includes("Работа") ? t : null;
    }, 30000);
    for (const want of ["Входящие", "Отправленные", "Черновики", "Корзина", "Работа"]) {
      if (!text.includes(want)) throw new Error(`нет папки «${want}»`);
    }
    for (const hidden of ["Calendar", "Birthdays"]) {
      if (text.includes(hidden)) throw new Error(`служебная папка «${hidden}» видна`);
    }
    await screenshot("main");
  }, { retry: true });

  await step("6.5", "поиск на сервере находит письмо вне локального кэша", async () => {
    const box = await d.find(".list .search input");
    await d.clear(box);
    await d.type(box, "Quarterly");
    await d.until("search view", async () => (await textOf(".list h2")).trim() === "Поиск");
    if ((await textOf(".list")).includes("Quarterly report archive")) throw new Error("письмо уже в кэше — тест ничего не проверит");
    await d.button("На сервере");
    await rowBySubject("Quarterly report archive", 20000);
    await d.type(box, "\uE00C");
  });

  await step("3.4", "первая синхронизация: свежие письма сразу, старые — при прокрутке", async () => {
    await rowBySubject("Счёт за октябрь", 30000);
    await d.button("Входящие");
    await d.until("folder view", async () => (await textOf(".list h2")).trim() === "Входящие");
    const carol = (await invoke("accounts")).find((a) => a.email === "carol@local.test");
    const query = { account_id: carol.id, folder: "INBOX", threads: true, limit: 2000 };
    const count = async () => d.exec("return document.querySelector('.list').dataset.count");
    const scrollEnd = () => d.exec("const v = document.querySelector('.viewport'); v.scrollTop = v.scrollHeight; v.dispatchEvent(new Event('scroll'));");
    // The label is the cache's length ("625" or "625 писем"); a trailing "+" means the list
    // has not caught up. A hardcoded 625 races the search of the step before (it caches one
    // old letter) and a conversation that has not collapsed yet (626).
    await d.until("inbox caught up with the cache", async () => {
      await scrollEnd();
      const rows = await invoke("messages", { query });
      const shown = String(await count());
      const budget = rows.filter((m) => (m.subject || "").includes("Бюджет на ноябрь")).length;
      const oldest = rows.some((m) => m.subject === "Массовое письмо 000");
      if (!oldest || budget !== 1 || shown.includes("+") || !shown.startsWith(String(rows.length))) return null;
      return true;
    }, 15000);
    // The list is virtual: only rows near the viewport exist, so scroll to the end again.
    await scrollEnd();
    await rowBySubject("Массовое письмо 000", 5000);
  });

  section("list");
  await step("108.1", "аватары в списке: круг в каждой строке, снимки в обеих темах, выключатель #108", async () => {
    await d.button("Входящие");
    await d.exec("document.querySelector('.viewport').scrollTop = 0");
    const count = async (sel) => Number(await d.exec(`return document.querySelectorAll('${sel}').length`));
    await d.until("a circle in every row", async () => {
      const rows = await count(".list .row");
      return rows > 0 && (await count(".list .row .pic")) === rows ? rows : null;
    }, 15000);
    // Initials: the stand's mail brings no DMARC verdict, so no logo is asked from the network.
    const initials = await d.exec("return document.querySelector('.list .row .pic')?.textContent.trim()");
    if (!initials) throw new Error("в круге нет инициалов");
    if ((await count(".list .row .pic button, .list .row .pic a, .list .row .pic [tabindex]")) > 0) throw new Error("кружок получил фокус или стал ссылкой");
    const settings = await invoke("settings_get");
    const theme = async (name) => {
      await invoke("settings_set", { settings: { ...settings, theme: name } });
      await d.until(`theme ${name}`, async () => (await d.exec("return document.documentElement.dataset.theme")) === name, 10000);
    };
    // The same list in the light theme and in the dark one, then back: the run keeps its own.
    await theme("paper");
    await screenshot("list-avatars-paper");
    await theme("night");
    await screenshot("list-avatars-night");
    await invoke("settings_set", { settings });
    // Off, the list is as before the avatars: no circles, the text starts where it did.
    await invoke("settings_set", { settings: { ...settings, list_avatars: false } });
    await d.until("no circles", async () => (await count(".list .row .pic")) === 0 && (await count(".list .row.avatars")) === 0, 10000);
    await invoke("settings_set", { settings: { ...settings, list_avatars: true } });
    await d.until("circles back", async () => (await count(".list .row .pic")) > 0, 10000);
  }, { retry: true });

  await step("72.1", "важность: «!» в строке списка, строка в шапке письма, поиск «это:важное» (#72)", async () => {
    const subj = `Важное ${stamp}`;
    helper("deliver-important", subj);
    await d.button("Входящие");
    await rowBySubject(subj, 60000);
    const bang = () => d.exec(`return [...document.querySelectorAll('.list .row')].find(r => r.innerText.includes(arguments[0]))?.querySelector('.imp')?.innerText.trim() ?? ''`, subj);
    await d.until("a bang in the row", async () => (await bang()) === "!", 15000);
    await screenshot("importance-list");
    await openBySubject(subj);
    await d.until("the line in the header", async () => (await textOf(".reader")).includes("Отправитель отметил как важное"), 15000);
    await screenshot("importance-reader");
    // An ordinary letter beside it has neither.
    if ((await d.exec(`return [...document.querySelectorAll('.list .row')].filter(r => r.querySelector('.imp')).length`)) !== 1) throw new Error("«!» не только у важного письма");
    const box = await d.find(".list .search input");
    await d.clear(box);
    await d.type(box, "это:важное");
    await d.until("search view", async () => (await textOf(".list h2")).trim() === "Поиск");
    await rowBySubject(subj, 15000);
    const found = await d.exec(`return document.querySelectorAll('.list .row').length`);
    if (found < 1) throw new Error("поиск «это:важное» ничего не нашёл");
    await d.type(box, "\uE00C");
  }, { retry: true });

  await step("108.2", "выбор и курсор не путаются: открытое письмо с кругом и полосой, выбранные с галочкой (#108, 2.5 Б), снимки в обеих темах", async () => {
    await d.button("Входящие");
    await d.exec("document.querySelector('.viewport').scrollTop = 0");
    const settings = await invoke("settings_get");
    // Read mass letters far from the top: opening them changes no counter the later steps read.
    const OPEN = 6;
    const rowAt = (i) => `document.querySelectorAll('.list .row')[${i}]`;
    const ctrlClick = (i) => d.exec(`${rowAt(i)}.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))`);
    const state = (i) => d.exec(`const r = ${rowAt(i)}; return { pic: !!r.querySelector('.pic'), pick: !!r.querySelector('.pick'), selected: r.classList.contains('selected'), cursor: r.classList.contains('cursor') }`);
    const theme = async (name) => {
      await invoke("settings_set", { settings: { ...settings, theme: name, list_avatars: shotAvatars } });
      await d.until(`theme ${name}`, async () => (await d.exec("return document.documentElement.dataset.theme")) === name, 10000);
    };
    let shotAvatars = true;
    for (const avatars of [true, false]) {
      shotAvatars = avatars;
      const tag = avatars ? "" : "-plain";
      await theme("paper");
      // The letter that is open: the circle stays, the bar stands at the left, no ground, no tick.
      await d.exec(`${rowAt(OPEN)}.click()`);
      await d.until("opened row", async () => (await state(OPEN)).cursor, 10000);
      let s = await state(OPEN);
      if (s.pick || s.selected) throw new Error(`открытое письмо показано как выбранное: ${JSON.stringify(s)}`);
      if (avatars && !s.pic) throw new Error("у открытого письма пропал круг");
      await screenshot(`row-cursor${tag}-paper`);
      await theme("night");
      await screenshot(`row-cursor${tag}-night`);
      // Two chosen together: a tick and the ground on both; the open one keeps its bar too.
      await ctrlClick(OPEN + 1);
      await d.until("two chosen", async () => (await state(OPEN + 1)).selected, 10000);
      for (const i of [OPEN, OPEN + 1]) {
        s = await state(i);
        if (!s.pick || !s.selected || s.pic) throw new Error(`строка ${i} не показана как выбранная: ${JSON.stringify(s)}`);
      }
      await screenshot(`row-chosen${tag}-night`);
      await theme("paper");
      await screenshot(`row-chosen${tag}-paper`);
      // Back to one letter.
      await d.exec(`${rowAt(OPEN + 2)}.click()`);
      await d.until("one again", async () => !(await state(OPEN + 1)).selected, 10000);
    }
    await invoke("settings_set", { settings });
  }, { retry: true });

  await step("108.3", "полоса курсора переезжает на j сразу, до ответа сервера (#108, 2.5 Б)", async () => {
    await d.button("Входящие");
    await d.exec("document.querySelector('.viewport').scrollTop = 0");
    const at = 6;
    const rows = `document.querySelectorAll('.list .row')`;
    await d.until("the list is drawn", async () => (await d.exec(`return ${rows}.length`)) > at + 2, 15000);
    await d.exec(`${rows}[${at}].click()`);
    await d.until("first letter open", async () => (await d.exec(`return ${rows}[${at}].classList.contains('cursor')`)) && (await textOf(".reader h1")).length > 0, 10000);
    const shown = await textOf(".reader h1");
    await press("j");
    // The key was just pressed: the letter is asked for after a pause and comes later, the bar
    // is already on the next row while the reader still shows the old letter.
    const now = await d.exec(`return { cursor: [...${rows}].findIndex(r => r.classList.contains('cursor')), h1: document.querySelector('.reader h1')?.innerText ?? '' }`);
    if (now.cursor !== at + 1) throw new Error(`полоса не переехала на j сразу: строка ${now.cursor}, ждали ${at + 1}`);
    if (now.h1.trim() !== shown.trim()) throw new Error("письмо открылось раньше полосы: шаг ничего не проверил");
    await d.until("the next letter opened", async () => (await textOf(".reader h1")) !== shown, 10000);
  }, { retry: true });

  await step("4.6", "открытие ставит «прочитано» на сервере", async () => {
    await d.exec("document.querySelector('.viewport').scrollTop = 0");
    await openBySubject("Счёт за октябрь");
    await d.until("\\Seen on server", async () => helper("flags", "INBOX", "Счёт за октябрь").includes("\\Seen"), 10000);
  });

  await step("4.2", "Windows-1251 и KOI8-R без кракозябр", async () => {
    await openBySubject("Счёт на оплату");
    const text = await textOf(".reader");
    if (!text.includes("Оплатите до пятницы")) throw new Error(text.slice(0, 300));
    if (!text.includes("Бухгалтерия")) throw new Error("имя отправителя KOI8-R");
  }, { retry: true });

  await step("4.3–4.5", "HTML: скрипты вырезаны, трекер скрыт, cid-картинка и вложение на месте", async () => {
    await openBySubject("HTML-письмо с картинками");
    await d.until("banner", async () => (await d.bodyText()).includes("Внешние картинки скрыты"));
    const info = await d.until("iframe", () =>
      d.exec(`const doc = document.querySelector('.reader iframe')?.contentDocument;
        if (!doc || !doc.body || !doc.body.innerHTML) return null;
        return { html: doc.body.innerHTML, logo: doc.querySelector('img[src^="data:image/png"]') !== null,
                 scripts: doc.querySelectorAll('script').length, onclick: doc.querySelectorAll('[onclick]').length,
                 tracker: doc.body.innerHTML.includes('tracker.example') };`),
    );
    if (!info.logo) throw new Error("встроенная картинка не подставлена");
    if (info.scripts || info.onclick) throw new Error("скрипты не вырезаны");
    if (info.tracker) throw new Error("трекер загружается без разрешения");
    if (!(await d.bodyText()).includes("report.pdf")) throw new Error("нет вложения report.pdf");
    await screenshot("html-message");
    await d.button("Показать");
    try {
      await d.until("tracker allowed", () =>
        d.exec("return document.querySelector('.reader iframe')?.contentDocument?.body?.innerHTML.includes('tracker.example')"),
      );
    } catch (e) {
      const diag = await d.exec(`const f = document.querySelector('.reader iframe');
        return { srcdoc: (f?.getAttribute('srcdoc') ?? '').includes('tracker.example'),
                 csp: (f?.getAttribute('srcdoc') ?? '').match(/img-src[^;]*/)?.[0],
                 body: f?.contentDocument?.body?.innerHTML?.slice(0, 400) };`);
      throw new Error(`${e.message}; ${JSON.stringify(diag)}`);
    }
  });

  await step("4.4", "«всегда для отправителя» запоминает доверие", async () => {
    await d.button("Входящие");
    await openBySubject("Счёт за октябрь");
    await openBySubject("HTML-письмо с картинками");
    await d.button("Всегда для news@example.org");
    await d.until("remote shown", () =>
      d.exec("return document.querySelector('.reader iframe')?.contentDocument?.body?.innerHTML.includes('tracker.example')"),
    );
    await openBySubject("Счёт за октябрь");
    await openBySubject("HTML-письмо с картинками");
    // The letter is drawn a moment after it is opened: wait for the answer, not for the first look.
    await d.until("trust kept", async () => !(await d.bodyText()).includes("Внешние картинки скрыты"));
  });

  await step("4.5", "вложение сохраняется на диск без искажений", async () => {
    const target = join(profile, "report.pdf");
    const rowId = await d.req("POST", d.s("/execute/async"), {
      script: `const done = arguments[arguments.length - 1];
        window.__TAURI_INTERNALS__.invoke('search', { text: 'HTML письмо картинками', accountId: null })
          .then(r => done(r[0]?.id ?? null), e => done(null));`,
      args: [],
    });
    if (!rowId) throw new Error("письмо не найдено поиском");
    const res = await d.req("POST", d.s("/execute/async"), {
      script: `const done = arguments[arguments.length - 1];
        window.__TAURI_INTERNALS__.invoke('attachment_save', { id: arguments[0], index: 1, path: arguments[1] })
          .then(() => done('ok'), e => done(JSON.stringify(e)));`,
      args: [rowId, target],
    });
    if (res !== "ok") throw new Error(res);
    const head = readFileSync(target).subarray(0, 8).toString();
    if (head !== "%PDF-1.4") throw new Error(`содержимое: ${head}`);
  });

  await step("4.5", "папка для вложений: «Сохранить» и «Сохранить все» без диалога, имена не затираются", async () => {
    const dir = join(profile, "Вложения");
    const setDir = async (value) => {
      await press(",", { ctrlKey: true });
      await d.click(await d.until("writing page", () => d.find(".prefs .tab[data-page='writing']")));
      const row = ".prefs [data-row='attachments_dir']";
      const shown = () => d.exec(`return document.querySelector("${row} .path").title`);
      await d.until("folder field", () => d.find(`${row} .folder`));
      // Picked in the dialog: the field is not typed into.
      if (value) {
        await pickFolder(value);
        await d.click(await d.find(`${row} .folder .btn:not(.ghost)`));
        await d.until("folder picked", async () => (await shown()) === value);
      } else {
        const clear = await d.findAll(`${row} .folder .btn.ghost`);
        if (clear.length) await d.click(clear[0]);
        await d.until("folder cleared", async () => (await shown()) === "");
      }
      // Saved the moment it was picked: the window closes with nothing to confirm.
      await closeSettings();
    };
    await setDir(dir);
    await d.button("Входящие");
    await openBySubject("HTML-письмо с картинками");
    const saveButton = () => d.xpath("//div[contains(@class,'file')][contains(., 'report.pdf')]//button[@aria-label='Сохранить']");
    // The folder does not exist yet: it is made.
    await d.click(await saveButton());
    await d.until("saved without a dialog", async () => readdirSync(dir).includes("report.pdf"), 10000);
    await d.click(await saveButton());
    await d.until("second copy beside", async () => readdirSync(dir).includes("report (1).pdf"), 10000);
    await openFolder("Работа");
    await openBySubject("Документы на проверку");
    // With a few files more than two rows hold, «Save all» ends the list behind «+N more».
    if ((await d.findAll(".reader .files > button")).length) {
      await d.button("Сохранить все");
    } else {
      await d.click(await d.find(".reader .files .more"));
      await d.click(await d.until("save all in the list", () => d.xpath("//div[contains(@class,'pop')]//button[normalize-space(.)='Сохранить все']")));
    }
    await d.until("all saved", async () => ["contract.pdf", "sums.csv"].every((f) => readdirSync(dir).includes(f)), 10000);
    await d.button("Входящие");
    if (readFileSync(join(dir, "report (1).pdf")).subarray(0, 8).toString() !== "%PDF-1.4") throw new Error("копия искажена");
    await setDir("");
  });

  await step("8.5", "пути не из диалога отклоняются: файлы не пишутся и не читаются", async () => {
    const outside = join(tmpdir(), `depesha-e2e-outside-${process.pid}`);
    const rows = await invoke("search", { text: "HTML письмо картинками", accountId: null });
    const id = rows[0]?.id;
    if (!id) throw new Error("письмо не найдено поиском");
    const accountId = (await invoke("accounts"))[0].id;
    const settings = await invoke("settings_get");
    await refused("attachment_save", { id, index: 1, path: join(outside, "report.pdf") });
    await refused("settings_set", { settings: { ...settings, attachments_dir: outside } });
    if ((await invoke("settings_get")).attachments_dir !== settings.attachments_dir) throw new Error("папка вложений сменилась");
    await refused("attachments_save_all", { id, dir: outside });
    if (existsSync(outside)) throw new Error(`создано: ${outside}`);
    const secret = "/etc/hostname";
    const err = await refused("file_info", { path: secret });
    if (/\d{2,}/.test(err)) throw new Error(`file_info раскрыл размер: ${err}`);
    const draft = { from: null, to: [{ name: null, email: "someone@example.org" }], subject: "e2e: чужой файл", text: "", attachments: [{ kind: "file", path: secret }] };
    await refused("draft_save", { accountId, draft, replace: null });
    await refused("send", { accountId, draft, discardDraft: null, at: null, followupSecs: null });
    if ((await invoke("outbox")).some((o) => o.draft.subject === draft.subject)) throw new Error("письмо с чужим файлом в «Исходящих»");
    await refused("extension_install", { path: join(outside, "plugin"), permissions: [], hooks: [] });
    await refused("extension_storage_set", { id: "../../x", key: "k", value: 1 });
  });

  await step("4.10", "просмотрщик вложений в области чтения: PDF, Word, Excel, Markdown, CSV в cp1251; ←/→ и Esc", async () => {
    // The shown file's chip is framed; a file behind «+N more» frames that button instead.
    const current = () =>
      d.exec("const c = [...document.querySelectorAll('.reader .file.current .fname')].map((e) => e.innerText); if (document.querySelector('.reader .files .more.current')) c.push('+N ещё'); return c;");
    const frameText = () =>
      d.exec("return document.querySelector('.viewer iframe')?.contentDocument?.body?.innerText ?? ''");
    await openFolder("Работа");
    await openBySubject("Документы на проверку");
    await d.click(await d.until("contract.pdf", () => d.xpath("//button[contains(@class,'file-name')][contains(., 'contract.pdf')]")));
    await d.until("pdf page drawn", () => d.exec("return !!document.querySelector('.viewer .page canvas')"), 20000);
    await d.until("pdf text layer", async () => (await textOf(".viewer .page")).includes("Договор поставки"), 10000);
    await screenshot("viewer-pdf");
    // In place of the letter's text: the list, the letter's header and its attachments stay.
    if (!(await d.exec("return !!document.querySelector('.reader .viewer') && !!document.querySelector('.list .row') && !!document.querySelector('.reader h1')")))
      throw new Error("просмотрщик не в области чтения");
    if ((await current()).join() !== "contract.pdf") throw new Error(`подсвечено: ${await current()}`);
    await press("ArrowRight");
    await d.until("docx", async () => (await frameText()).includes("Поставщик обязуется"), 20000);
    await screenshot("viewer-docx");
    await press("ArrowRight");
    await d.until("xlsx", async () => (await frameText()).includes("Реагент Б"), 20000);
    await press("ArrowRight");
    await d.until("markdown", async () => (await frameText()).includes("Заметки к встрече"));
    const md = await d.exec("return document.querySelector('.viewer iframe').contentDocument.body.innerHTML");
    if (!md.includes("<h1") || !md.includes("<table") || md.includes("<script")) throw new Error(`markdown: ${md}`);
    await screenshot("viewer-markdown");
    await press("ArrowRight");
    await d.until("csv in cp1251", async () => (await textOf(".viewer table")).includes("Петров"));
    const csv = await current();
    if (csv.length !== 1 || !(csv[0].endsWith(".csv") || csv[0] === "+N ещё")) throw new Error(`подсвечено: ${csv}`);
    await press("Escape");
    await d.until("viewer closed", async () => (await d.findAll(".viewer")).length === 0);
    if ((await current()).length) throw new Error("подсветка осталась после Esc");
    if (!(await textOf(".reader .body")).trim()) throw new Error("текст письма не вернулся");
    // The shown attachment clicked again takes back to the letter.
    const pdf = () => d.xpath("//button[contains(@class,'file-name')][contains(., 'contract.pdf')]");
    await d.click(await pdf());
    await d.until("viewer open", async () => (await d.findAll(".viewer")).length === 1);
    await d.click(await pdf());
    await d.until("viewer closed by its attachment", async () => (await d.findAll(".viewer")).length === 0);
    // A file that only pretends to be a PDF: the viewer says so and offers the application.
    await d.button("Входящие");
    await openBySubject("HTML-письмо с картинками");
    await d.click(await d.until("report.pdf", () => d.xpath("//button[contains(@class,'file-name')][contains(., 'report.pdf')]")));
    await d.until("fallback", async () => (await textOf(".viewer")).includes("не получилось показать"), 20000);
    await press("Escape");
    await d.until("viewer closed", async () => (await d.findAll(".viewer")).length === 0);
  });

  await step("4.10", "много вложений в письме: не больше двух рядов фишек и «+N ещё ›», текст виден; список с клавиатуры, Enter — просмотр, «Сохранить все» в конце списка", async () => {
    const subj = "Сканы акта сверки, 29 файлов";
    helper("many-files", "Работа", subj, "29")
    await openFolder("Работа");
    await rowBySubject(subj, 30000);
    await openBySubject(subj);
    const dir = process.env.E2E_SHOTS_DIR;
    const shotTo = async (name) => {
      if (!dir) return;
      // A toast in the frame is not what the picture is about.
      await d.exec("document.querySelector('.toasts')?.style.setProperty('visibility', 'hidden')").catch(() => {});
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.png`), await d.screenshot());
      await d.exec("document.querySelector('.toasts')?.style.removeProperty('visibility')").catch(() => {});
    };
    const strip = () =>
      d.exec(`
        const files = [...document.querySelectorAll('.reader .files .file')];
        const more = document.querySelector('.reader .files .more');
        const tops = new Set(files.map((f) => Math.round(f.getBoundingClientRect().top)));
        const body = document.querySelector('.reader .body').getBoundingClientRect();
        const box = document.querySelector('.reader .scroll').getBoundingClientRect();
        return {
          chips: files.length,
          rows: tops.size,
          more: more ? more.innerText.trim() : '',
          width: document.querySelector('.reader .files').clientWidth,
          seen: Math.max(0, Math.min(body.bottom, box.bottom) - Math.max(body.top, box.top)),
          text: document.querySelector('.reader .body').innerText.includes('Строка 1 '),
          saveAll: [...document.querySelectorAll('.reader .files > button')].length,
        };`);
    const check = (s, label) => {
      const m = /^\+(\d+) ещё ›$/.exec(s.more);
      if (!m) throw new Error(`${label}: нет «+N ещё ›»: ${JSON.stringify(s)}`);
      if (s.chips + Number(m[1]) !== 29) throw new Error(`${label}: ${s.chips} фишек и «${s.more}», а файлов 29`);
      if (s.rows > 2) throw new Error(`${label}: фишки в ${s.rows} рядах`);
      if (s.seen < 160) throw new Error(`${label}: текст письма виден на ${s.seen} px, нужно не меньше 160`);
      if (!s.text) throw new Error(`${label}: текста письма нет в панели`);
      if (s.saveAll) throw new Error(`${label}: «Сохранить все» осталось в ряду при свёртке`);
    };
    const settings = await invoke("settings_get");
    const theme = async (name) => {
      await invoke("settings_set", { settings: { ...settings, theme: name } });
      await d.until(`theme ${name}`, async () => (await d.exec("return document.documentElement.dataset.theme")) === name, 10000);
    };
    const rect = await d.rect();
    try {
      const wide = await d.until("folded", async () => {
        const s = await strip();
        return s.more ? s : null;
      }, 15000);
      check(wide, "широкая панель");
      for (const name of ["paper", "night"]) {
        await theme(name);
        await screenshot(`many-attach-wide-${name}`);
        await shotTo(`wide-${name}`);
      }
      await theme("paper");

      // The pane resized: the rows are counted again for its width.
      await d.setRect(960, rect.height);
      const narrow = await d.until("recounted", async () => {
        const s = await strip();
        return s.more && s.width !== wide.width ? s : null;
      }, 15000);
      check(narrow, "узкая панель");
      if (narrow.chips > wide.chips) throw new Error(`панель сузилась ${wide.width} → ${narrow.width}, а фишек стало больше: ${wide.chips} → ${narrow.chips}`);
      for (const name of ["paper", "night"]) {
        await theme(name);
        await screenshot(`many-attach-narrow-${name}`);
        await shotTo(`narrow-${name}`);
      }
      await theme("paper");
      await d.setRect(rect.width, rect.height);
      await d.until("wide again", async () => (await strip()).width === wide.width);
      check(await strip(), "широкая панель снова");

      // By Tab the last chip is followed by «+N more ›», which opens the list of every file.
      const [TAB, ENTER, UP, DOWN, LEFT, RIGHT, END, ESC] = ["\uE004", "\uE007", "\uE013", "\uE015", "\uE012", "\uE014", "\uE010", "\uE00C"];
      const active = (js) => d.exec(`const a = document.activeElement; return ${js};`);
      const onMore = () => active("a.classList.contains('more')");
      const listOf = (n) => d.until(`list of ${n}`, async () => (await d.findAll(".pop [data-att]")).length === n);
      const folded = (await strip()).chips;
      await d.exec("const f = [...document.querySelectorAll('.reader .files .file')].pop(); f.querySelectorAll('button')[f.querySelectorAll('button').length - 1].focus();");
      await d.pressKey(TAB);
      if (!(await onMore())) throw new Error("после последней фишки Tab не на «+N ещё ›»");
      await d.pressKey(ENTER);
      await listOf(29);
      // It opens from the top, the cursor on the first folded file (nothing is shown yet).
      await d.until("cursor on the first folded file", () => active(`a.dataset.att === '${folded}'`));
      const top = await d.exec("return document.querySelector('.pop').scrollTop");
      if (top !== 0) throw new Error(`список открылся прокрученным на ${top} px`);
      await shotTo("list-paper");
      await theme("night");
      await shotTo("list-night");
      await theme("paper");
      await d.pressKey(DOWN);
      if (!(await active(`a.dataset.att === '${folded + 1}'`))) throw new Error("↓ не на следующем файле");
      await d.pressKey(RIGHT);
      if (!(await active("a.dataset.act !== undefined"))) throw new Error("→ не на «Сохранить» у файла");
      await d.pressKey(DOWN);
      if (!(await active(`a.dataset.att === '${folded + 2}'`))) throw new Error("↓ от «Сохранить» не на следующем файле");
      await d.pressKey(UP);
      await d.pressKey(UP);
      if (!(await active(`a.dataset.att === '${folded}'`))) throw new Error("↑ не вернула на первый свёрнутый файл");
      // Enter on a file shows it, as a click on its chip does; the focus goes to the viewer.
      await d.pressKey(ENTER);
      await d.until("viewer from the list", async () => (await d.findAll(".reader .viewer")).length === 1);
      if (!(await active("a.classList.contains('viewer')"))) throw new Error("после Enter в списке фокус не на просмотре");
      if ((await d.findAll(".pop [data-att]")).length) throw new Error("список остался после просмотра");
      const viewerHeight = await d.exec("return document.querySelector('.reader .viewer').getBoundingClientRect().height");
      if (viewerHeight < 160) throw new Error(`просмотр сжат до ${viewerHeight} px`);
      if ((await d.findAll(".reader .files .more.current")).length !== 1) throw new Error("«+N ещё ›» не показывает, что открыт свёрнутый файл");

      // The viewer open: the list opens on the shown file, and → goes to the row's «Save», not to the next file.
      const shown = () => textOf(".reader .viewer .name");
      const name = await shown();
      await d.exec("document.querySelector('.reader .files .more').focus()");
      await d.pressKey(ENTER);
      await listOf(29);
      await d.until("cursor on the shown file", () => active(`a.dataset.att === '${folded}'`));
      // Enter on the shown file keeps it: only a click on its chip closes the viewer.
      await d.pressKey(ENTER);
      await d.until("list closed by Enter", async () => (await d.findAll(".pop [data-att]")).length === 0);
      if ((await d.findAll(".reader .viewer")).length !== 1 || (await shown()) !== name) throw new Error("Enter на показанном файле закрыл или сменил просмотр");
      if (!(await active("a.classList.contains('viewer')"))) throw new Error("после Enter на показанном файле фокус не на просмотре");
      await d.exec("document.querySelector('.reader .files .more').focus()");
      await d.pressKey(ENTER);
      await listOf(29);
      await d.until("cursor on the shown file again", () => active(`a.dataset.att === '${folded}'`));
      await d.pressKey(DOWN);
      if (!(await active(`a.dataset.att === '${folded + 1}'`))) throw new Error("↓ при открытом просмотре не на следующем файле");
      await d.pressKey(RIGHT);
      if (!(await active("a.dataset.act !== undefined"))) throw new Error("→ при открытом просмотре не на «Сохранить»: просмотр перехватил стрелку");
      if ((await shown()) !== name) throw new Error(`просмотр сменился: «${name}» → «${await shown()}»`);
      await d.pressKey(ESC);
      await d.until("list closed", async () => (await d.findAll(".pop [data-att]")).length === 0);
      if (!(await onMore())) throw new Error("после Esc из списка фокус не на «+N ещё ›»");
      if ((await d.findAll(".reader .viewer")).length !== 1) throw new Error("Esc из списка закрыл и просмотр");
      await d.pressKey(ESC);
      await d.until("viewer closed", async () => (await d.findAll(".reader .viewer")).length === 0);
      if (!(await onMore())) throw new Error("после Esc из просмотра фокус не на «+N ещё ›»");

      // «Save all» ends the list; Esc closes it and gives the focus back.
      await d.pressKey(ENTER);
      await listOf(29);
      await d.pressKey(END);
      if (!(await active("a.innerText.trim() === 'Сохранить все'"))) throw new Error("«Сохранить все» не последнее в списке");
      await d.pressKey(ESC);
      await d.until("list closed", async () => (await d.findAll(".pop [data-att]")).length === 0);
      if (!(await onMore())) throw new Error("после Esc из списка фокус не на «+N ещё ›»");
    } finally {
      await invoke("settings_set", { settings });
      await d.setRect(rect.width, rect.height);
      helper("delete", "Работа", subj);
    }
  });

  await step("4.11", "письмо в отдельном окне: двойной щелчок, ответ в этом окне, «Готово» закрывает окно, z в главном", async () => {
    const subj = "Документы на проверку";
    const main = await d.req("GET", d.s("/window"));
    await openFolder("Работа");
    await rowBySubject(subj);
    await d.exec(
      `const row = [...document.querySelectorAll('.row')].find(r => r.innerText.includes(arguments[0]));
       row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));`,
      subj,
    );
    const handles = () => d.req("GET", d.s("/window/handles"));
    await d.until("second window", async () => (await handles()).length === 2, 15000);
    const other = (await handles()).find((h) => h !== main);
    await d.req("POST", d.s("/window"), { handle: other });
    try {
      await d.until("letter in its window", async () => (await textOf(".reader h1")).includes(subj), 20000);
      if ((await d.findAll(".list, nav.side")).length) throw new Error("в окне письма есть список или боковая панель");
      // What a letter's window has no use for, it cannot call.
      const accountsBefore = await invoke("accounts");
      const settingsBefore = await invoke("settings_get");
      const extensionsBefore = (await invoke("extensions")).length;
      await refused("account_remove", { id: accountsBefore[0].id });
      await refused("settings_set", { settings: { ...settingsBefore, undo_send_secs: 0 } });
      await refused("extension_install", { path: join(root, "plugins/community/reading-time"), permissions: [], hooks: [] });
      await refused("update_install");
      if ((await invoke("accounts")).length !== accountsBefore.length) throw new Error("ящик удалён из окна письма");
      if ((await invoke("settings_get")).undo_send_secs !== settingsBefore.undo_send_secs) throw new Error("настройки изменены из окна письма");
      if ((await invoke("extensions")).length !== extensionsBefore) throw new Error("плагин поставлен из окна письма");
      // Double click again: the same window comes forward, no second one.
      await d.req("POST", d.s("/window"), { handle: main });
      await d.exec(
        `const row = [...document.querySelectorAll('.row')].find(r => r.innerText.includes(arguments[0]));
         row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));`,
        subj,
      );
      await new Promise((r) => setTimeout(r, 1500));
      if ((await handles()).length !== 2) throw new Error(`окон: ${(await handles()).length}`);
      await d.req("POST", d.s("/window"), { handle: other });
      await d.click(await d.until("reply", () => d.xpath("//div[contains(@class,'acts')]//button[contains(., 'Ответить')]")));
      await d.until("compose in the window", async () => (await d.findAll(".compose")).length === 1);
      const re = await d.exec("return document.querySelector('.compose .subject').value");
      if (re !== `Re: ${subj}`) throw new Error(`тема ответа: ${re}`);
      await screenshot("message-window-reply");
      await d.click(await d.until("discard", () => d.find(".compose [aria-label='Удалить черновик']")));
      if ((await d.findAll(".confirm")).length) await d.click(await d.xpath("//div[contains(@class,'confirm')]//button[contains(@class,'primary')]"));
      await d.until("compose gone", async () => (await d.findAll(".compose")).length === 0);
      await d.click(await d.until("done", () => d.xpath("//div[contains(@class,'toolbar')]//button[contains(., 'Готово')]")));
      await d.until("window closed", async () => (await handles()).length === 1, 20000);
    } finally {
      await d.req("POST", d.s("/window"), { handle: main });
    }
    await d.until("archived on server", async () => helper("count", "Работа", subj) === "0", 20000);
    await d.until("undo offered in the main window", async () => (await textOf(".toasts")).includes("Отменить"));
    await press("z");
    await d.until("back in its folder", async () => helper("count", "Работа", subj) === "1", 20000);
  });

  // A drop on a reply (#79): the backend makes the window report a drop of real files, the rest is the real path.
  const drops = dropFixtures();
  /** The reply is in the form of the letter it answers: the drop zones come with an HTML one, so the reply is switched to it. */
  const toHtml = async () => {
    await d.until("reply compose", async () => (await d.findAll(".compose")).length === 1, 20000);
    if ((await d.findAll(".compose .rich")).length === 0) {
      await d.click(await d.find(".compose footer button[aria-label='Формат письма']"));
      await d.click(await d.until("HTML", () => d.xpath("//div[contains(@class,'pop')]//*[@role='menuitemradio'][contains(., 'HTML')]")));
    }
    await d.until("rich reply", async () => (await d.findAll(".compose .rich")).length === 1, 20000);
  };
  const discardCompose = async () => {
    await d.click(await d.until("discard", () => d.find(".compose [aria-label='Удалить черновик']").catch(() => null)));
    if ((await d.findAll(".confirm")).length) await d.click(await d.xpath("//div[contains(@class,'confirm')]//button[contains(@class,'primary')]"));
    await d.until("compose gone", async () => (await d.findAll(".compose")).length === 0, 15000);
  };
  await dropSteps({
    d,
    step,
    refused,
    fix: drops,
    openCompose: async () => {
      await d.button("Входящие");
      await openBySubject("HTML-письмо с картинками");
      await d.click(await d.until("reply", () => d.xpath("//div[contains(@class,'acts')]//button[contains(., 'Ответить')]")));
      await toHtml();
    },
    closeCompose: discardCompose,
  });

  await step("2.9", "бросок в ответ в отдельном окне письма (message-*)", async () => {
    const subj = "HTML-письмо с картинками";
    const main = await d.req("GET", d.s("/window"));
    await d.button("Входящие");
    await rowBySubject(subj);
    await d.exec(
      `const row = [...document.querySelectorAll('.row')].find(r => r.innerText.includes(arguments[0]));
       row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));`,
      subj,
    );
    const handles = () => d.req("GET", d.s("/window/handles"));
    await d.until("second window", async () => (await handles()).length === 2, 15000);
    const other = (await handles()).find((h) => h !== main);
    await d.req("POST", d.s("/window"), { handle: other });
    try {
      await d.until("letter in its window", async () => (await textOf(".reader h1")).includes(subj), 20000);
      await d.click(await d.until("reply", () => d.xpath("//div[contains(@class,'acts')]//button[contains(., 'Ответить')]")));
      await toHtml();
      await dropOn(d, [drops.pdf, drops.png], { zone: "attach" });
      await d.until("attachments", async () => (await d.findAll(".compose .files .file")).length === 2, 10000);
      await discardCompose();
      // Esc closes the window of a letter with nothing being written; «Готово» would archive the letter on the server.
      await press("Escape");
      await d.until("window closed", async () => (await handles()).length === 1, 20000);
    } finally {
      await d.req("POST", d.s("/window"), { handle: main });
    }
  });
  drops.clean();

  await step("7.3", "клавиатура: j/k по списку, c — новое письмо, Esc — закрыть", async () => {
    await d.button("Входящие");
    await openBySubject("Счёт за октябрь");
    const body = await d.find("body");
    const before = await textOf(".reader h1");
    await d.type(body, "j");
    await d.until("next message", async () => (await textOf(".reader h1")) !== before);
    await d.type(body, "k");
    await d.until("back", async () => (await textOf(".reader h1")) === before);
    await d.type(body, "c");
    await d.until("compose by key", async () => (await d.findAll(".compose")).length === 1);
    await d.type(await d.find(".compose textarea"), "");
    // Esc folds the window into a bar, as in Gmail; the cross closes it.
    await d.until("compose folded by Esc", async () => (await d.findAll(".compose.min")).length === 1);
    await d.click(await d.find(".compose header > button:last-child"));
    await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0);
  });

  await step("7.3", "клавиши работают на русской раскладке (о = j, л = k)", async () => {
    await openBySubject("Счёт за октябрь");
    const before = await textOf(".reader h1");
    await press("о", { code: "KeyJ" });
    await d.until("next message", async () => (await textOf(".reader h1")) !== before);
    await press("л", { code: "KeyK" });
    await d.until("back", async () => (await textOf(".reader h1")) === before);
  });

  await step("7.20", "клавиши: переназначение записью, конфликт, запреты, русская раскладка, подсказки", async () => {
    const row = (id) => `.prefs .kr[data-command='${id}']`;
    const openKeys = async () => {
      await press(",", { ctrlKey: true });
      await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
      await d.click(await d.find(".prefs .tab[data-page='keys']"));
      await d.until("keys page", async () => (await d.findAll(row("core.archive"))).length === 1);
    };
    try {
      await openKeys();
      // Both labels of one key: e and the Russian у.
      const archive = await textOf(row("core.archive"));
      if (!archive.includes("e") || !archive.includes("у")) throw new Error(`«Готово»: ${archive}`);
      // A click on the key records the next press at once: Shift+R for «Reply all».
      await d.click(await d.find(`${row("core.reply-all")} button.combo`));
      await d.until("recording", async () => (await d.findAll(".prefs .kr.recording")).length === 1);
      await press("R", { shiftKey: true });
      await d.until("changed", async () => (await d.findAll(`${row("core.reply-all")}.changed`)).length === 1);
      if (!(await textOf(row("core.reply-all"))).includes("было a")) throw new Error("нет «было a»");
      // A key taken already: a card under the row; «у» is saved by its place as e.
      await d.click(await d.find(`${row("core.forward")} button.combo`));
      await press("у", { code: "KeyE" });
      await d.until("conflict", async () => (await textOf(".prefs .kconf")).includes("Готово"));
      await screenshot("keys-conflict");
      await d.button("Поменять местами");
      await d.until("swapped", async () => (await textOf(row("core.archive"))).includes("было e"));
      // Not allowed: a single letter in the letter window, Ctrl+C anywhere; the recording goes on.
      await d.click(await d.find(`${row("compose.bold")} button.combo`));
      await press("b");
      await d.until("letter refused", async () => (await textOf(".prefs .kconf.err")).includes("Ctrl или Alt"));
      await press("c", { ctrlKey: true });
      await d.until("copy refused", async () => (await textOf(".prefs .kconf.err")).includes("за системой"));
      await press("Escape");
      await d.until("recording cancelled", async () => (await d.findAll(".prefs .kr.recording")).length === 0);
      if ((await d.findAll(`${row("compose.bold")}.changed`)).length) throw new Error("запрещённая клавиша записалась");
      // The page saves as it changes: no shared «Save / Cancel» line at all.
      if ((await d.findAll(".prefs footer")).length) throw new Error("на странице «Клавиши» осталась общая строка Сохранить/Отмена");
      const saved = (await invoke("settings_get")).keybindings.custom;
      if (saved["core.reply-all"]?.[0] !== "Shift+r" || saved["core.forward"]?.[0] !== "e" || saved["core.archive"]?.[0] !== "f")
        throw new Error(`сохранено: ${JSON.stringify(saved)}`);
      await closeSettings();
      await d.until("settings closed", async () => (await d.findAll(".prefs")).length === 0);
      // Tooltips and the keys follow at once.
      await openBySubject("Счёт за октябрь");
      // The settings come back from the backend a moment after the save: wait for the tip.
      const tipOf = () => d.exec("return [...document.querySelectorAll('.reader button')].map((b) => b.title).find((t) => t.startsWith('Переслать')) ?? ''");
      await d.until("подсказка «Переслать (e/у)»", async () => (await tipOf()) === "Переслать (e/у)");
      await press("a");
      await new Promise((r) => setTimeout(r, 400));
      if ((await d.findAll(".compose")).length) throw new Error("старая клавиша a ещё отвечает всем");
      await press("К", { code: "KeyR", shiftKey: true });
      await d.until("reply all", async () => (await d.findAll(".compose")).length === 1);
      await d.click(await d.find(".compose header > button:last-child"));
      await composeClosed();
    } finally {
      // Back to the defaults for the steps after this one: «Reset all» and save. A recording
      // left by a failure takes the first Escape.
      if ((await d.findAll(".prefs .kr.recording")).length) await press("Escape");
      await closeSettings();
      if (Object.keys((await invoke("settings_get")).keybindings.custom).length) {
        await openKeys();
        await d.button("Сбросить все");
        await closeSettings();
        const left = (await invoke("settings_get")).keybindings.custom;
        if (Object.keys(left).length) throw new Error(`после сброса осталось: ${JSON.stringify(left)}`);
      }
    }
  });

  await step("7.20", "Alt+Enter из палитры приводит на строку команды; запись применяется без «Сохранить»", async () => {
    const row = (id) => `.prefs .kr[data-command='${id}']`;
    try {
      // The palette's own entry opens the page even without a highlighted command.
      await press("k", { ctrlKey: true });
      await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
      await d.type(await d.find(".palette .q"), "настроить");
      await d.button("Настроить клавиши…");
      await d.until("keys page", async () => (await d.findAll(row("core.archive"))).length === 1);
      await d.until("no shared footer", async () => (await d.findAll(".prefs footer")).length === 0);
      await closeSettings();

      // Alt+Enter on the highlighted command goes to its row, lit; the command does not run.
      await press("k", { ctrlKey: true });
      await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
      await d.type(await d.find(".palette .q"), "переслать");
      await d.until("highlighted", async () => (await textOf(".palette .item.active")) !== "");
      await pressIn(".palette .q", "Enter", { altKey: true });
      await d.until("row lit", async () => (await d.findAll(`${row("core.forward")}.hl`)).length === 1);
      if ((await d.findAll(".palette")).length) throw new Error("палитра не закрылась по Alt+Enter");
      await screenshot("keys-from-palette");

      // Record a key there: it takes effect with no «Save», at once.
      await d.click(await d.find(`${row("core.reply")} button.combo`));
      await press("m");
      await d.until("changed", async () => (await d.findAll(`${row("core.reply")}.changed`)).length === 1);
      const saved = (await invoke("settings_get")).keybindings.custom;
      if (saved["core.reply"]?.[0] !== "m") throw new Error(`не сохранилось сразу: ${JSON.stringify(saved)}`);
      await closeSettings();
      // The new key runs at once in the main window: m answers the open letter.
      await openFolder("Входящие");
      await openBySubject("Счёт за октябрь");
      await press("m");
      await d.until("answered by the new key", async () => (await d.findAll(".compose")).length === 1);
      await d.click(await d.find(".compose header > button:last-child"));
      await composeClosed();
    } finally {
      if ((await d.findAll(".prefs .kr.recording")).length) await press("Escape");
      await closeSettings();
      await press(",", { ctrlKey: true });
      await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
      await d.click(await d.find(".prefs .tab[data-page='keys']"));
      await d.until("keys page", async () => (await d.findAll(row("core.archive"))).length === 1);
      await d.button("Сбросить все");
      await closeSettings();
      const left = (await invoke("settings_get")).keybindings.custom;
      if (Object.keys(left).length) throw new Error(`после сброса осталось: ${JSON.stringify(left)}`);
      await d.button("Входящие");
    }
  });

  await step("6.3", "групповые действия: три письма отмечаются непрочитанными", async () => {
    await d.button("Входящие");
    const subjects = ["Массовое письмо 619", "Массовое письмо 618", "Массовое письмо 617"];
    await d.click(await rowBySubject(subjects[0]));
    for (const subj of subjects.slice(1)) {
      await d.exec(
        `const row = [...document.querySelectorAll('.row')].find(r => r.innerText.includes(arguments[0]));
         row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));`,
        subj,
      );
    }
    // The panel names the count and the size of the selection.
    await d.until("bulk panel", async () => /Выбрано 3 письма · [\d,]+ (Б|КБ|МБ)/.test(await d.bodyText()));
    await d.button("Не прочитано");
    for (const subj of subjects) {
      await d.until(`unseen ${subj}`, async () => !helper("flags", "INBOX", subj).includes("\\Seen"), 10000);
    }
  });

  await step("6.6", "контекстное меню строки: флаг, подменю «Отложить» и папок", async () => {
    await d.button("Входящие");
    const subj = "Массовое письмо 616";
    await rowBySubject(subj);
    const rightClick = () =>
      d.exec(
        `const row = [...document.querySelectorAll('.row')].find(r => r.innerText.includes(arguments[0]));
         const r = row.getBoundingClientRect();
         row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 }));`,
        subj,
      );
    await rightClick();
    await d.until("menu", async () => (await textOf(".pop")).includes("Поставить флаг"));
    const menu = await textOf(".pop");
    for (const item of ["Ответить", "Ответить всем", "Переслать", "Готово", "Это спам", "Удалить"]) {
      if (!menu.includes(item)) throw new Error(`нет пункта «${item}»: ${menu}`);
    }
    await screenshot("row-menu");
    await d.click(await d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Поставить флаг')]"));
    await d.until("\\Flagged on server", async () => helper("flags", "INBOX", subj).includes("\\Flagged"), 10000);
    // Submenus open in place of the menu.
    await rightClick();
    await d.click(await d.until("snooze item", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Отложить')]")));
    await d.until("snooze presets", async () => (await textOf(".pop")).includes("Завтра"));
    await press("Escape");
    await d.until("menu closed", async () => (await d.findAll(".pop")).length === 0);
  });

  await step("6.7", "контекстное меню папки: новая вложенная папка; версия в сайдбаре", async () => {
    const version = await textOf("nav.side .brand .version");
    if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`версия: «${version}»`);
    await d.exec(
      `const item = [...document.querySelectorAll('nav.side .item')].find((b) => b.innerText.trim() === 'Работа');
       const r = item.getBoundingClientRect();
       item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 10 }));`,
    );
    await d.until("folder menu", async () => (await textOf(".pop")).includes("Синхронизировать папку"));
    await screenshot("folder-menu");
    await d.click(await d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Новая папка внутри')]"));
    const input = await d.until("name input", () => d.find(".pop input").catch(() => null));
    await d.type(input, "Проекты\uE007");
    await d.until("subfolder in sidebar", async () => (await sidebarText()).includes("Проекты"), 15000);
    // Inside «Работа», not in a new folder named by the raw modified UTF-7 of it.
    const side = await sidebarText();
    if (side.includes("&")) throw new Error(`папка с сырым именем: ${side}`);
    const nested = await d.exec(
      "const p = [...document.querySelectorAll('nav.side .item')].find((b) => b.innerText.trim() === 'Проекты'); return p ? parseInt(p.style.paddingLeft) : 0;",
    );
    if (nested <= 14) throw new Error(`«Проекты» не вложена (отступ ${nested}px)`);
  });

  await step("6.8", "вложенные папки сворачиваются своим треугольником, остальное на месте", async () => {
    const shown = () => d.exec("return [...document.querySelectorAll('nav.side .item .name')].map((n) => n.innerText.trim())");
    const toggles = () => d.exec("return [...document.querySelectorAll('nav.side .fold')].map((b) => b.getAttribute('aria-label'))");
    const t = await toggles();
    if (!t.some((l) => l.endsWith(": Работа"))) throw new Error(`нет треугольника у «Работы»: ${t}`);
    if (t.some((l) => l.endsWith(": Корзина") || l.endsWith(": Проекты"))) throw new Error(`треугольник у папки без подпапок: ${t}`);
    const before = await shown();
    await d.click(await d.find("nav.side .fold[aria-label$=': Работа']"));
    await d.until("branch folded", async () => !(await shown()).includes("Проекты"));
    const after = await shown();
    const lost = before.filter((n) => n !== "Проекты" && !after.includes(n));
    if (lost.length) throw new Error(`пропали другие папки: ${lost}`);
    // The folder itself still opens with a click on its name.
    await openFolder("Работа");
    await d.until("Работа open", async () => (await textOf(".list")).includes("Документы на проверку"));
    await d.click(await d.find("nav.side .fold[aria-label$=': Работа']"));
    await d.until("branch back", async () => (await shown()).includes("Проекты"));
    await d.button("Входящие");
  });

  await step("7.11", "избранные папки: звёздочка в строке, блок над деревом, свёрнутый ящик и ветка, полоса", async () => {
    const accountId = (await invoke("accounts"))[0].id;
    // Rows carry the server's name of the folder (modified UTF-7), not what it reads as.
    const nameOf = async (...path) =>
      (await invoke("folders")).find((f) => f.account_id === accountId && f.display_name === path.join(f.delimiter ?? ""))?.name;
    // A folder on the third level: Работа / Проекты / 2026.
    await invoke("folder_create", { accountId, parent: await nameOf("Работа", "Проекты"), name: "2026" });
    const tree = "nav.side .group .folder-row:not(.fav-row)";
    const starrable = () => d.exec(`return [...document.querySelectorAll(arguments[0])].filter((r) => r.querySelector('.star')).map((r) => r.dataset.folder)`, tree);
    const deep = await d.until("third level folder", async () => {
      const name = await nameOf("Работа", "Проекты", "2026");
      return name && (await starrable()).includes(name) ? name : null;
    }, 15000);
    const work = await nameOf("Работа");
    // Ten folders to star: enough of them made up top-level if the mailbox has fewer.
    for (let i = 1, n = (await starrable()).length; n < 10; i++, n++) {
      await invoke("folder_create", { accountId, parent: null, name: `Звезда ${i}` });
      await d.until(`folder ${i}`, async () => (await starrable()).length > n, 15000);
    }
    const all = await starrable();
    const ten = [deep, work, ...all.filter((n) => n !== deep && n !== work).slice(0, 8)];
    const star = (name, where = tree) => d.find(`${where}[data-folder=${JSON.stringify(name)}] .star`);
    const favs = () => d.exec("return [...document.querySelectorAll('nav.side .favs .fav-row')].map((r) => r.dataset.folder)");
    const active = () => d.exec("return document.querySelector('nav.side .item.active')?.innerText ?? ''");
    const before = await active();
    // Straight down the star column, one click per row.
    for (const name of ten) await d.click(await star(name));
    await d.until("ten favourites", async () => (await favs()).length === 10);
    // A star again on a starred folder takes it off; once more puts it back: still ten, no copy.
    await d.click(await star(ten[1]));
    await d.until("unstarred in the tree", async () => (await favs()).length === 9);
    await d.click(await star(ten[1]));
    await d.until("starred again", async () => (await favs()).length === 10);
    if (new Set(await favs()).size !== 10) throw new Error(`повтор в избранном: ${await favs()}`);
    if ((await active()) !== before) throw new Error("звёздочка открыла папку");
    const pressed = await d.exec(`return [...document.querySelectorAll(arguments[0])].filter((r) => r.querySelector('.star[aria-pressed=true]')).length`, tree);
    if (pressed !== 10) throw new Error(`в дереве отмечено ${pressed}`);
    // One column of stars and one of counters, the shared sections included.
    const columns = await d.exec(`const x = (css, side) => new Set([...document.querySelectorAll(css)].map((e) => Math.round(e.getBoundingClientRect()[side])));
      return { stars: [...x('nav.side .star', 'right')], counts: [...x('nav.side .count', 'right')] };`);
    if (columns.stars.length !== 1 || columns.counts.length !== 1) throw new Error(`столбцы съехали: ${JSON.stringify(columns)}`);
    const path = await d.exec("return document.querySelector(`nav.side .fav-row[data-folder=${JSON.stringify(arguments[0])}] .path`)?.innerText ?? ''", deep);
    if (path !== "Работа / Проекты") throw new Error(`путь вложенной: «${path}»`);
    await screenshot("favourites-tree");
    // The block's star is outline and only under the pointer or in focus; the tree's is gold at rest.
    const colorIn = (where, name) =>
      d.exec(`const s = document.querySelector(arguments[0] + '[data-folder="' + arguments[1] + '"] .star'); return s ? getComputedStyle(s).color : null`, where, name);
    const block = "nav.side .favs .fav-row";
    // Park the pointer on neutral chrome first: where the last click left it is not a promise.
    await d.moveTo(await d.find("nav.side .brand"));
    const blockIdle = await colorIn(block, ten[0]);
    if (blockIdle !== "rgba(0, 0, 0, 0)") throw new Error(`звезда блока видна в покое: «${blockIdle}»`);
    await d.moveTo(await d.find(`${block}[data-folder=${JSON.stringify(ten[0])}] .item`));
    await d.until("звезда блока проявилась", async () => (await colorIn(block, ten[0])) !== blockIdle);
    // The keyboard half of the rule: with the pointer away again, focus shows the block's star too.
    await d.moveTo(await d.find("nav.side .brand"));
    await d.until("звезда блока снова невидима", async () => (await colorIn(block, ten[0])) === blockIdle);
    await d.exec("document.querySelector(arguments[0] + ' .star').focus()", `${block}[data-folder=${JSON.stringify(ten[0])}]`);
    await d.until("звезда блока проявилась в фокусе", async () => (await colorIn(block, ten[0])) !== blockIdle);
    if ((await colorIn(tree, ten[0])) !== "rgb(224, 176, 64)") throw new Error("звезда избранной папки в дереве не золотая");
    // The row's paint belongs to the row: the star lies over the row, so crossing onto it must
    // not blink the background off (#60). Hovering the row and hovering its star read the same.
    const bgIn = (where, name) =>
      d.exec(`const r = document.querySelector(arguments[0] + '[data-folder="' + arguments[1] + '"] .item'); return r ? getComputedStyle(r).backgroundColor : null`, where, name);
    const rowsel = `${block}[data-folder=${JSON.stringify(ten[0])}]`;
    const bgUnder = async (part) => {
      await d.moveTo(await d.find(`${rowsel} ${part}`));
      return d.until(`row background under ${part}`, async () => {
        const c = await bgIn(block, ten[0]);
        return c && c !== "rgba(0, 0, 0, 0)" ? c : null;
      });
    };
    const bgRow = await bgUnder(".item");
    const bgStar = await bgUnder(".star");
    if (bgStar !== bgRow) throw new Error(`фон строки гаснет на звезде: ${bgRow} → ${bgStar}`);

    // A folded branch keeps its favourite in the block.
    await d.click(await d.find("nav.side .fold[aria-label$=': Работа']"));
    await d.until("branch folded", async () => !(await starrable()).includes(deep));
    if (!(await favs()).includes(deep)) throw new Error("вложенная избранная пропала со свёрнутой веткой");
    await d.click(await d.find("nav.side .fold[aria-label$=': Работа']"));
    // A folded mailbox: the tree goes, the favourites stay and open their folders.
    await d.click(await d.find("nav.side .account-name"));
    await d.until("tree hidden", async () => (await d.findAll(tree)).length === 0);
    if ((await favs()).length !== 10) throw new Error("избранное скрылось со свёрнутым ящиком");
    await d.click(await d.find(`nav.side .fav-row[data-folder=${JSON.stringify(work)}] .item`));
    await d.until("Работа from favourites", async () => (await textOf(".list")).includes("Документы на проверку"));
    if ((await d.findAll(tree)).length !== 0) throw new Error("ящик развернулся");
    await screenshot("favourites-collapsed");
    await d.click(await d.find("nav.side .account-name"));
    const inboxCounts = await d.exec(`return [...document.querySelectorAll('nav.side .group [data-folder="INBOX"] .count')].map((c) => c.innerText)`);
    if (inboxCounts.length === 2 && inboxCounts[0] !== inboxCounts[1]) throw new Error(`счётчики «Входящих» разные: ${inboxCounts}`);
    await openFolder("Работа");
    await d.until("Работа from the tree", async () => (await textOf(".list")).includes("Документы на проверку"));

    // In the strip the favourites come first; the whole tree under «All folders».
    const rect = await d.rect();
    try {
      await d.setRect(960, rect.height);
      await d.until("strip", async () => (await d.findAll("nav.side.strip")).length === 1);
      await d.click((await d.findAll("nav.side .circle"))[0]);
      await d.until("flyout favourites", async () => (await d.findAll(".pop .favs .fav-row")).length === 10);
      // The same in the strip's flyout: outline at rest, shown under the pointer on the row.
      const fly = ".pop .favs .fav-row";
      const flyColor = () =>
        d.exec("const s = document.querySelector(arguments[0] + ' .star'); return s ? getComputedStyle(s).color : null", fly);
      // Neutral chrome again, not wherever the circle's click left the pointer.
      await d.moveTo(await d.find("nav.side .brand"));
      const flyIdle = await flyColor();
      if (flyIdle !== "rgba(0, 0, 0, 0)") throw new Error(`звезда блока в полосе видна в покое: «${flyIdle}»`);
      await d.moveTo(await d.find(`${fly} .item`));
      await d.until("звезда блока в полосе проявилась", async () => (await flyColor()) !== flyIdle);
      await screenshot("favourites-strip");
      await d.click(await d.find(".pop .all-folders"));
      await d.until("tree in the flyout", async () => (await d.findAll(".pop .folder-row:not(.fav-row)")).length > 0);
      await press("Escape");
    } finally {
      await d.setRect(rect.width, rect.height);
      await d.until("full sidebar again", async () => (await d.findAll("nav.side.strip")).length === 0).catch(() => {});
    }

    // Unstarred in the block: the row fades in place, a second press keeps it.
    const second = (await favs())[1];
    await d.click(await star(second, "nav.side .fav-row"));
    if (!(await d.exec("return !!document.querySelector('nav.side .fav-row.leaving')"))) throw new Error("строка не затухает");
    await d.click(await star(second, "nav.side .fav-row"));
    await new Promise((r) => setTimeout(r, 1200));
    if (!(await favs()).includes(second)) throw new Error("повторное нажатие не вернуло папку");
    // From the keyboard: Space on the star, and the focus goes to the next row's star.
    const list = await favs();
    await d.type(await star(list[0], "nav.side .fav-row"), "");
    await d.until("first one gone", async () => !(await favs()).includes(list[0]), 3000);
    const focused = await d.exec("const e = document.activeElement; return e.classList.contains('star') ? e.closest('.fav-row')?.dataset.folder : e.className");
    if (focused !== list[1]) throw new Error(`фокус ушёл на «${focused}»`);
    // The folder itself stays on the server and in the tree.
    if ((await d.findAll(`${tree}[data-folder=${JSON.stringify(list[0])}]`)).length !== 1) throw new Error("папка пропала из дерева");
    // The folder's menu says the same as the star.
    await d.exec(
      `const item = document.querySelector('${tree}[data-folder="' + arguments[0] + '"] .item'); const r = item.getBoundingClientRect();
       item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 10 }));`,
      list[1],
    );
    await d.click(await d.until("menu item", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Убрать из избранного')]")));
    await d.until("removed by the menu", async () => !(await favs()).includes(list[1]));
    if (await d.exec(`return document.querySelector('${tree}[data-folder="' + arguments[0] + '"] .star').getAttribute('aria-pressed')`, list[1]) !== "false")
      throw new Error("звёздочка не сброшена после меню");

    // Without favourites the mailbox folds whole again, as before.
    // Unstarred in the tree, the folder's row in the block above stays and fades as well: the
    // tree does not move under the pointer, the star is empty at once, a second press keeps it.
    const top = (name) => d.exec(`return document.querySelector('${tree}[data-folder="' + arguments[0] + '"]').getBoundingClientRect().top`, name);
    const pressedIn = (name) => d.exec(`return document.querySelector('${tree}[data-folder="' + arguments[0] + '"] .star').getAttribute('aria-pressed')`, name);
    const leavingRow = (name) => d.exec(`return !!document.querySelector('nav.side .fav-row.leaving[data-folder="' + arguments[0] + '"]')`, name);
    const rest = await favs();
    const was = await top(rest[0]);
    await d.click(await star(rest[0]));
    if ((await top(rest[0])) !== was) throw new Error("дерево сдвинулось сразу после звёздочки");
    if ((await pressedIn(rest[0])) !== "false" || !(await leavingRow(rest[0]))) throw new Error("строка в блоке не затухает, или звёздочка в дереве не сброшена");
    await d.click(await star(rest[0]));
    await new Promise((r) => setTimeout(r, 1200));
    if (!(await favs()).includes(rest[0]) || (await pressedIn(rest[0])) !== "true") throw new Error("повторное нажатие в дереве не вернуло папку");
    // The rows go after their pause, and then the tree moves up: the next star waits for it.
    for (const name of rest) {
      const at = await top(name);
      await d.click(await star(name));
      if ((await top(name)) !== at) throw new Error(`дерево сдвинулось под «${name}»`);
      await d.until(`${name} out of the block`, async () => (await d.findAll(`nav.side .favs .fav-row[data-folder=${JSON.stringify(name)}]`)).length === 0);
    }
    await d.until("no favourites", async () => (await d.findAll("nav.side .fav-row")).length === 0);
    await d.click(await d.find("nav.side .account-name"));
    const left = await d.exec("return document.querySelector('nav.side .group.collapsed')?.querySelectorAll('.item').length ?? -1");
    await d.click(await d.find("nav.side .account-name"));
    if (left !== 0) throw new Error(`у свёрнутого ящика без избранного видно ${left} папок`);
    await d.button("Входящие");
  });

  await step("6.4", "крупные письма: размер в каждой строке, готовый запрос из подсказок, в:Папка/*", async () => {
    const subj = "Фото с праздника";
    // About 1,6 MB: a 1200 KB attachment in base64.
    helper("big", "Работа.Проекты", subj, "1200");
    await openFolder("Проекты");
    await rowBySubject(subj, 30000);
    const sizes = () => d.exec("return [...document.querySelectorAll('.list .row')].map((r) => r.querySelector('.size')?.innerText.trim() ?? '')");
    // Every row has its size, quiet while the list is ordered by date.
    const shown = await sizes();
    if (!shown.length || shown.some((s) => !/^[\d\s,]+ (Б|КБ|МБ|ГБ)$/.test(s))) throw new Error(`размеры в строках: ${shown}`);
    if (!shown.some((s) => /^1,\d МБ$/.test(s))) throw new Error(`нет размера крупного письма: ${shown}`);
    if ((await d.findAll(".list .row .size.strong")).length) throw new Error("размер выделен без сортировки по размеру");

    // The threshold is a setting; 1 MB here, so the ready query finds the letter.
    await press(",", { ctrlKey: true });
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    await d.click(await d.find(".prefs .tab[data-page='storage']"));
    await setInput(".prefs [data-row='large_mb'] input", "1");
    await d.type(await d.find(".prefs [data-row='large_mb'] input"), "\uE007");
    await d.until("threshold saved", async () => (await invoke("settings_get")).large_mb === 1);
    await closeSettings();

    // A ready query from the suggestions of the empty search box.
    const box = await d.find(".list .search input");
    await d.click(box);
    const ready = await d.until("ready query", () =>
      d.xpath("//div[contains(@class,'suggest')]//button[contains(., 'Крупные (больше 1 МБ)')]").catch(() => null),
    );
    await screenshot("search-suggestions");
    await d.click(ready);
    await rowBySubject(subj, 10000);
    const query = await d.exec("return document.querySelector('.list .search input').value");
    if (query.trim() !== "больше:1М") throw new Error(`в поле: «${query}»`);
    // "больше:" puts the largest first by itself; totals of the cache above the results.
    if (!(await textOf(".list .view .trigger")).includes("Крупные сначала")) throw new Error(`сортировка: ${await textOf(".list .view .trigger")}`);
    if (!/\d+ пис\S* · [\d,\s]+ (КБ|МБ|ГБ)/.test(await textOf(".list .server")) || !(await textOf(".list .server")).includes("по кэшу")) {
      throw new Error(`итоги: ${await textOf(".list .server")}`);
    }
    if (!(await d.findAll(".list .row .size.strong")).length) throw new Error("при сортировке по размеру размер не выделен");
    await screenshot("large-mail");

    // A folder with its subfolders, and the folder alone.
    await d.clear(box);
    await d.type(box, "больше:1М в:Работа/*\uE007");
    await rowBySubject(subj, 10000);
    await d.clear(box);
    await d.type(box, "больше:1М в:Работа\uE007");
    await d.until("the folder alone", async () => {
      const value = await d.exec("return document.querySelector('.list .search input').value");
      return value.trim() === "больше:1М в:Работа" && !(await textOf(".list .viewport")).includes(subj);
    }, 10000);

    // Nothing of this step stays for the next ones: the threshold, the letter, the recent searches.
    const settings = await invoke("settings_get");
    await invoke("settings_set", { settings: { ...settings, large_mb: 25 } });
    await d.clear(box);
    await d.type(box, "\uE00C");
    await d.exec("localStorage.removeItem('depesha.search.recent')");
    helper("delete", "Работа.Проекты", subj);
    await openFolder("Проекты");
    await d.until("letter gone", async () => !(await textOf(".list .viewport")).includes(subj), 30000);
    await d.button("Входящие");
  });

  await step("3.11", "офлайн: письма за 30 дней скачиваются сами, ход виден в «Фоновых задачах»", async () => {
    const overview = () => invoke("sync_overview");
    await d.until("offline download done", async () => {
      const [o] = await overview();
      return o && o.offline_total > 0 && o.offline_done === o.offline_total;
    }, 60000);
    await d.click(await d.find("button[aria-label='Фоновые задачи']"));
    await d.until("tasks window", async () => (await textOf(".modal.tasks")).includes("Офлайн: скачано"));
    const text = await textOf(".modal.tasks");
    if (!text.includes("Синхронизирован")) throw new Error(text);
    await screenshot("tasks");
    await d.button("Закрыть");
    await d.until("tasks closed", async () => (await d.findAll(".modal.tasks")).length === 0);
  });

  await step("6.3", "«Непрочитанные»: прочитанное письмо остаётся в списке до смены вида", async () => {
    await d.button("Непрочитанные");
    await openBySubject("Массовое письмо 619");
    await d.until("\\Seen on server", async () => helper("flags", "INBOX", "Массовое письмо 619").includes("\\Seen"), 10000);
    // The change comes back from the server and reloads the list: the letter must stay open.
    await new Promise((r) => setTimeout(r, 2000));
    await rowBySubject("Массовое письмо 619", 1000);
    if (!(await textOf(".reader h1")).includes("Массовое письмо 619")) throw new Error("письмо закрылось");
    await d.button("Входящие");
    await d.button("Непрочитанные");
    await rowBySubject("Массовое письмо 618");
    const gone = await d.exec("return ![...document.querySelectorAll('.row .subject')].some((s) => s.innerText.includes('Массовое письмо 619'))");
    if (!gone) throw new Error("прочитанное письмо осталось после смены вида");
  });

  /** Picks an item of the signature menu open in the letter or in the settings. */
  async function menuItem(label) {
    const item = await d.until(`menu item ${label}`, () =>
      d.xpath(`//div[contains(@class,'pop')]//button[contains(@class,'mi') and normalize-space(.)=${JSON.stringify(label)}]`).catch(() => null),
    );
    await d.click(item);
  }

  /** Types lines into the signature open in its editor, as the editor's own commands do. */
  async function typeSignature(lines) {
    await d.exec(
      `const el = document.querySelector('.account-page .sig-rich .rich'); el.focus();
       arguments[0].forEach((line, i) => { if (i) document.execCommand('insertParagraph'); document.execCommand('insertText', false, line); });`,
      lines,
    );
  }

  await step("5.7", "две подписи в настройках ящика, подпись по умолчанию попадает в новое письмо", async () => {
    await d.click(await d.find(".menu-btn"));
    await d.button("Настройки…");
    await d.until("settings", async () => (await d.findAll(".account-page")).length === 1);
    // The first one becomes the default by itself.
    await d.button("Добавить подпись");
    await setInput(".account-page .signatures input.name", "Рабочая");
    await typeSignature(["С уважением,", "Кэрол"]);
    await d.click(await d.xpath("//div[contains(@class,'signatures')]//button[contains(., 'Свернуть')]"));
    await d.button("Добавить подпись");
    await setInput(".account-page .signatures input.name", "Короткая");
    await typeSignature(["Кэрол, отдел ИТ"]);
    await d.click(await d.xpath("//div[contains(@class,'signatures')]//button[contains(., 'Свернуть')]"));
    const list = await textOf(".account-page .signatures");
    if (!/Рабочая\s*по умолчанию/.test(list) || !list.includes("Короткая")) throw new Error(`список подписей: ${list}`);
    // Signatures are no part of the connection: saved as they change, with no button and no login (#102, 1.7 Б).
    await d.until("signatures saved", async () => {
      const [saved] = await invoke("accounts");
      return saved.signatures?.length === 2 && saved.default_signature === saved.signatures[0].id;
    }, 20000);
    await d.until("saved mark", async () => (await textOf(".account-page footer")).includes("Сохранено"));
    if ((await d.findAll(".account-page footer .btn.primary:not([disabled])")).length) throw new Error("кнопка подключения горит, хотя подключение не менялось");
    await closeSettings();
    if ((await d.findAll(".dialog, .confirm")).length) throw new Error("закрытие страницы ящика о чём-то спросило");
    const [acc] = await invoke("accounts");
    if (acc.signatures?.length !== 2 || acc.default_signature !== acc.signatures[0].id) throw new Error(JSON.stringify(acc.signatures));
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    // The field has only what is typed; the signature stands under it, apart.
    const text = await d.exec("return document.querySelector('.compose textarea').value");
    if (text.includes("Кэрол")) throw new Error(`подпись в поле ввода: ${JSON.stringify(text)}`);
    const sig = await textOf(".compose .sig-plain .sig-text");
    if (!sig.includes("-- \nС уважением,\nКэрол")) throw new Error(JSON.stringify(sig));
    // Only the signature is there: closing must neither ask nor save a draft.
    await d.click(await d.find(".compose header > button:last-child"));
    await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0, 10000);
  });

  await step("5.7", "подпись выбирается на самом блоке подписи, «Без подписи» убирает блок", async () => {
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await d.exec("const t = document.querySelector('.compose textarea'); t.focus(); document.execCommand('insertText', false, 'Текст письма.');");
    // The menu sits on the block and shows when it is pointed at; a click opens it.
    await d.exec("document.querySelector('.compose .sig-plain .chip').click()");
    await menuItem("Короткая");
    await d.until("short one", async () => (await textOf(".compose .sig-plain .sig-text")).includes("Кэрол, отдел ИТ"));
    if ((await textOf(".compose .sig-plain .sig-text")).includes("С уважением")) throw new Error("в письме две подписи");
    if ((await d.exec("return document.querySelector('.compose textarea').value")) !== "Текст письма.") throw new Error("текст письма изменился");
    await d.exec("document.querySelector('.compose .sig-plain .chip').click()");
    await menuItem("Без подписи");
    await d.until("no signature", async () => (await d.findAll(".compose .sig-plain")).length === 0);
    if (!(await textOf(".compose .sig-none")).includes("Без подписи")) throw new Error("нет строки «Без подписи · добавить»");
    await d.click(await d.find(".compose .sig-none button"));
    await menuItem("Рабочая");
    await d.until("back", async () => (await textOf(".compose .sig-plain .sig-text")).includes("С уважением,"));
    // In HTML the signature is a block of the editor that the caret does not enter.
    await d.click(await d.find(".compose footer button[aria-haspopup=menu]"));
    await menuItem("HTML");
    await d.until("html signature", async () =>
      d.exec("const b = document.querySelector('.compose .rich .depesha-signature'); return !!b && b.isContentEditable === false && b.innerText.includes('Кэрол');"));
    await d.exec("const bar = document.querySelector('.compose .block-bar .chip'); bar.click();");
    await menuItem("Короткая");
    await d.until("html swapped", async () => (await textOf(".compose .rich .depesha-signature")).includes("отдел ИТ"));
    if ((await d.findAll(".compose .rich .depesha-signature")).length !== 1) throw new Error("в письме две подписи");
    if (!(await textOf(".compose .rich")).includes("Текст письма.")) throw new Error("текст письма потерялся");
    // A long letter scrolled so that the signature's top is under the fields: its tint stays in
    // the letter's area and its menu goes to the bottom of the part in sight, still there to click.
    await d.exec(`
      const el = document.querySelector('.compose .rich');
      // Lines above the signature and below it, as a quote of an answer would be.
      el.insertAdjacentHTML('afterbegin', '<div>Строка.</div>'.repeat(40));
      el.insertAdjacentHTML('beforeend', '<div>Строка.</div>'.repeat(40));
      el.dispatchEvent(new Event('input'));`);
    await d.until("letter scrolled", async () =>
      d.exec(`
        const el = document.querySelector('.compose .rich');
        const sig = el.querySelector('.depesha-signature');
        const lift = sig.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientTop + 6;
        if (Math.abs(lift) > 1) {
          el.scrollTop += lift;
          return false;
        }
        sig.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
        return true;`));
    const geometry = await d.until("signature tint", async () =>
      d.exec(`
        const el = document.querySelector('.compose .rich');
        const hover = document.querySelector('.compose .block-hover');
        if (!hover) return null;
        const e = el.getBoundingClientRect();
        const view = { left: e.left + el.clientLeft, top: e.top + el.clientTop, right: e.left + el.clientLeft + el.clientWidth, bottom: e.top + el.clientTop + el.clientHeight };
        // What of the tint is painted: its box with its frame, cut by every box that clips it.
        const h = hover.getBoundingClientRect();
        let seen = { left: h.left - 4, top: h.top - 4, right: h.right + 4, bottom: h.bottom + 4 };
        for (let p = hover.parentElement; p && p !== document.body; p = p.parentElement) {
          if (getComputedStyle(p).overflow === 'visible') continue;
          const c = p.getBoundingClientRect();
          seen = { left: Math.max(seen.left, c.left), top: Math.max(seen.top, c.top), right: Math.min(seen.right, c.right), bottom: Math.min(seen.bottom, c.bottom) };
        }
        const sig = el.querySelector('.depesha-signature').getBoundingClientRect();
        const bar = document.querySelector('.compose .block-bar').getBoundingClientRect();
        return { view, seen, bar, sigTop: sig.top, sigBottom: Math.min(sig.bottom, view.bottom) };`));
    const within = (b, v) => b.left >= v.left - 0.5 && b.top >= v.top - 0.5 && b.right <= v.right + 0.5 && b.bottom <= v.bottom + 0.5;
    if (!(geometry.sigTop < geometry.view.top)) throw new Error(`верх подписи не ушёл под шапку: ${JSON.stringify(geometry)}`);
    if (!within(geometry.seen, geometry.view)) throw new Error(`подсветка подписи выходит за область письма: ${JSON.stringify(geometry)}`);
    if (!within(geometry.bar, geometry.view)) throw new Error(`бейдж подписи выходит за область письма: ${JSON.stringify(geometry)}`);
    if (geometry.bar.bottom < geometry.sigBottom - 0.5) throw new Error(`бейдж не у нижнего края подписи: ${JSON.stringify(geometry)}`);
    await screenshot("5.7-signature-scrolled");
    // The letter was typed in: it goes away without a draft.
    await d.click(await d.find(".compose footer button[aria-label='Удалить черновик']"));
    await d.click(await d.until("confirm", () => d.find(".modal.confirm .btn.primary").catch(() => null), 5000));
    await composeClosed();
  });

  await step("5.7", "в Markdown-письме подпись показана оформлением, а не текстом под «-- »", async () => {
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await d.exec("const t = document.querySelector('.compose textarea'); t.focus(); document.execCommand('insertText', false, 'Текст письма.');");
    // The format button of the footer switches this very letter to Markdown.
    await d.click(await d.find(".compose footer button[aria-label='Формат письма']"));
    await menuItem("Markdown");
    // The signature stands as a block with its formatting and pictures (#67), not as the
    // text under "-- " a plain letter carries.
    await d.until("markdown signature", async () =>
      d.exec("const b = document.querySelector('.compose .sig-html'); return !!b && b.innerText.includes('Кэрол');"));
    if ((await d.findAll(".compose .sig-plain .sig-text")).length) throw new Error("в Markdown-письме подпись показана текстом");
    await screenshot("5.7-signature-markdown");
    await d.click(await d.find(".compose footer button[aria-label='Удалить черновик']"));
    await d.click(await d.until("confirm", () => d.find(".modal.confirm .btn.primary").catch(() => null), 5000));
    await composeClosed();
  });

  await step("2.9", "зоны броска в Markdown-письме с подписью видны, когда текст прокручен", async () => {
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await d.click(await d.find(".compose footer button[aria-label='Формат письма']"));
    await menuItem("Markdown");
    await d.until("markdown signature", async () => (await d.findAll(".compose .sig-html")).length === 1);
    await zonesStayInView(d, drops);
    await d.click(await d.find(".compose footer button[aria-label='Удалить черновик']"));
    await d.click(await d.until("confirm", () => d.find(".modal.confirm .btn.primary").catch(() => null), 5000));
    await composeClosed();
  });

  section("send");
  let sentAt = 0;
  await step("5.1", "новое письмо уходит через очередь", async () => {
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    const to = (await d.findAll(".compose .box input"))[0];
    await d.type(to, "carol@local.test");
    await setInput(".compose .subject", subject);
    // WebDriver always types at the end of a field; a user types above the signature.
    await d.exec(
      "const t = document.querySelector('.compose textarea'); t.focus(); t.setSelectionRange(0, 0); document.execCommand('insertText', false, arguments[0]);",
      "Тестовое письмо из Депеши.\nВторая строка.",
    );
    await screenshot("compose");
    await d.button("Отправить");
    sentAt = Date.now();
    await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0);
    await d.until("sent toast", async () => (await d.bodyText()).includes(`Отправлено: ${subject}`), 30000);
  });

  await step("5.1", "Ctrl+Enter, нажатый дважды, отправляет письмо один раз", async () => {
    const subj = `Дважды ${stamp}`;
    await newMessage("carol@local.test", subj, "Одно письмо.");
    // Both presses land before the first send is through the checks.
    await d.exec(`const t = document.querySelector('.compose textarea');
      for (let i = 0; i < 2; i++) t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));`);
    await composeClosed();
    await d.until("delivered", async () => helper("count", "INBOX", subj) !== "0", 60000, 1000);
    await new Promise((r) => setTimeout(r, 3000));
    const n = helper("count", "INBOX", subj);
    if (n !== "1") throw new Error(`писем пришло: ${n}`);
  });

  await step("3.5", "новое письмо появляется само (IDLE), меньше чем за 60 с", async () => {
    await d.button("Входящие");
    await rowBySubject(subject, 60000);
    console.log(`    пришло через ${((Date.now() - sentAt) / 1000).toFixed(1)} с после отправки`);
  });

  await step("5.3", "копия в «Отправленных» ровно одна", async () => {
    await d.until("copy in Sent", async () => helper("count", "Sent", subject) === "1", 15000);
    await new Promise((r) => setTimeout(r, 2000));
    const n = helper("count", "Sent", subject);
    if (n !== "1") throw new Error(`копий: ${n}`);
  });

  await step("5.12", "сервер отвергает копию в «Отправленные»: после 3 отказов пауза, задача с тремя кнопками и значок у ящика; «Повторить» кладёт копию (#88)", async () => {
    const subj = `Копия отвергнута ${stamp}`;
    // The copy of the letter sent by the step before is filed in the next round (up to 15 s): it
    // must be in «Sent» before the folder goes, or it would be held with ours.
    await d.until("earlier copy filed", async () => helper("count", "Sent", `Дважды ${stamp}`) === "1", 60000, 1000);
    // Without «Sent» on the server the APPEND is refused for good; the letter itself goes.
    helper("rename-folder", "Sent", "SentAway");
    try {
      await newMessage("carol@local.test", subj, "Копию сервер не примет.");
      await d.button("Отправить");
      await composeClosed();
      await d.until("letter delivered", async () => helper("count", "INBOX", subj) !== "0", 60000, 1000);
      await d.until("copy on hold", async () => (await invoke("stuck_copies")).some((c) => c.subject === subj), 150000, 1000);
      await d.until("badge at the mailbox", async () => (await d.findAll("button.stuck-badge")).length > 0, 10000);
      await d.click(await d.find("button[aria-label='Фоновые задачи']"));
      await d.until("task", async () => (await textOf(".modal.tasks")).includes(`Копия не сохранена: «${subj}»`), 10000);
      const text = await textOf(".modal.tasks");
      for (const part of ["Письмо адресату ушло", "Повторить", "Сохранить .eml", "Не сохранять копию"]) {
        if (!text.includes(part)) throw new Error(`в задаче нет «${part}»: ${text}`);
      }
      await screenshot("stuck-copy-task");
      // On hold nothing is tried again by itself: the copy stays, still refused 3 times, and nothing is uploaded.
      await new Promise((r) => setTimeout(r, 20000));
      const stuck = await invoke("stuck_copies");
      const held = stuck.find((c) => c.subject === subj);
      if (stuck.length !== 1 || !held || held.refusals !== 3) throw new Error(`копия на паузе: ${JSON.stringify(held)}`);
      if (helper("count", "SentAway", subj) !== "0") throw new Error("копия загружена, хотя папки «Отправленные» нет");
      // «Save .eml»: the file is the letter, and the copy stays until the user lets it go. (The button
      // opens the system dialog, which WebDriver cannot answer; the command is the same.)
      const file = join(profile, "stuck-copy.eml");
      await invoke("sent_copy_save", { id: held.id, path: file });
      // The subject is MIME-encoded in the file (Cyrillic), the recipient is not.
      const eml = readFileSync(file, "utf-8");
      if (!/^Subject:/m.test(eml) || !eml.includes("carol@local.test")) throw new Error(`в .eml нет письма: ${eml.slice(0, 200)}`);
      if ((await invoke("stuck_copies")).length !== 1) throw new Error("копия пропала после сохранения в файл");
    } finally {
      helper("rename-folder", "SentAway", "Sent");
    }
    // The folder is back: «Retry» files the copy, the task and the badge go, the letter is not sent again.
    await d.button("Повторить");
    await d.until("copy filed", async () => helper("count", "Sent", subj) === "1", 30000, 1000);
    await d.until("task gone", async () => !(await textOf(".modal.tasks")).includes("Копия не сохранена"), 10000);
    if ((await d.findAll("button.stuck-badge")).length) throw new Error("значок остался после «Повторить»");
    if (helper("count", "INBOX", subj) !== "1") throw new Error("письмо ушло не один раз");
    await d.button("Закрыть");
    await d.until("tasks closed", async () => (await d.findAll(".modal.tasks")).length === 0);
  });

  await step("5.1", "ответ: тема, цитата, цепочка", async () => {
    await openBySubject(subject);
    await d.button("Ответить");
    await d.until("reply compose", async () => (await d.findAll(".compose")).length === 1);
    const subj = await d.exec("return document.querySelector('.compose .subject').value");
    if (subj !== `Re: ${subject}`) throw new Error(`тема: ${subj}`);
    // The quote is folded under the field, which shows only what is typed; the signature stands apart.
    const body = await d.exec("return document.querySelector('.compose textarea').value");
    if (body.includes("> Тестовое письмо")) throw new Error(`цитата в поле ввода: ${body}`);
    // The quote is a chip in the line of state (#103, 3.1 А): «Цитата ›», whose hint says who wrote.
    if (!(await textOf(".compose .state .quote-chip")).includes("Цитата")) throw new Error("нет свёрнутой цитаты");
    if (!(await d.exec("return document.querySelector('.compose .quote-chip').title")).includes("пишет:")) throw new Error("в подсказке цитаты нет «пишет:»");
    if ((await d.findAll(".compose .quote-text")).length) throw new Error("цитата раскрыта сама");
    await d.click(await d.find(".compose .quote-chip"));
    const quote = await d.exec("return document.querySelector('.compose .quote-text')?.value ?? ''");
    if (!quote.includes("> Тестовое письмо")) throw new Error(`цитата: ${quote}`);
    // Alt+Q folds it again from the keyboard.
    await altKey("q", "KeyQ");
    await d.until("quote folded", async () => (await d.findAll(".compose .quote-text")).length === 0);
    await d.exec("const t = document.querySelector('.compose textarea'); t.focus(); t.setSelectionRange(0, 0);");
    await d.type(await d.find(".compose textarea"), "Ответ получен.");
    await d.button("Отправить");
    await rowBySubject(`Re: ${subject}`, 60000);
    const irt = helper("header", "INBOX", `Re: ${subject}`, "In-Reply-To");
    if (!irt.includes("@")) throw new Error(`In-Reply-To: ${irt}`);
    // The letter carries both the answer and the quote.
    await openBySubject(`Re: ${subject}`);
    const sent = await textOf(".reader .body");
    if (!sent.includes("Ответ получен.") || !sent.includes("> Тестовое письмо")) throw new Error(`ушло: ${sent}`);
  });

  await step("6.1", "удаление переносит в корзину", async () => {
    await openBySubject(`Re: ${subject}`);
    await d.click(await d.find(".reader button[title^='Удалить']"));
    await d.until("in Trash", async () => helper("count", "Trash", `Re: ${subject}`) === "1", 15000);
    if (helper("count", "INBOX", `Re: ${subject}`) !== "0") throw new Error("осталось во входящих");
  });

  await step("6.4", "поиск по тексту открытых писем, по-русски", async () => {
    const box = await d.find(".list .search input");
    await d.clear(box);
    await d.click(box);
    await d.type(box, "пятниц");
    injectFailure("6.4");
    await d.until("search results", async () => {
      const t = await textOf(".list");
      return t.includes("Счёт за октябрь") && t.includes("Счёт на оплату");
    }, 10000);
    await screenshot("search");
    await d.type(box, "");
  }, { retry: true });

  await step("3.7", "флаг, поставленный другим клиентом, виден", async () => {
    await d.button("Входящие");
    helper("flag", "INBOX", "Счёт за октябрь");
    const flagged = async () =>
      d.exec(`return [...document.querySelectorAll('.row')].some(r => r.innerText.includes('Счёт за октябрь') && r.querySelector('.flag'))`);
    try {
      await d.until("flag via IDLE", flagged, 10000);
    } catch {
      console.log("    IDLE не сообщил о флаге — обновляю вручную");
      await d.click(await d.find(".menu-btn"));
      await d.button("Обновить");
      await d.until("flag after refresh", flagged, 15000);
    }
  });

  await step("5.5", "закрытие окна написания сохраняет черновик на сервере", async () => {
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await setInput(".compose .subject", `Черновик ${stamp}`);
    await d.type(await d.find(".compose textarea"), "Недописанное письмо");
    await d.click(await d.find(".compose header > button:last-child"));
    await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0, 15000);
    await d.until("draft on server", async () => helper("count", "Drafts", `Черновик ${stamp}`) === "1", 15000);
    const flags = helper("flags", "Drafts", `Черновик ${stamp}`);
    if (!flags.includes("\\Draft")) throw new Error(`флаги черновика: ${flags}`);
    // Drafts count all of them, read ones too.
    await d.until("drafts counter", async () =>
      Number(await d.exec("return [...document.querySelectorAll('nav.side .item')].find((b) => b.querySelector('.name')?.innerText.trim() === 'Черновики')?.querySelector('.count')?.innerText ?? 0")) >= 1);
  });

  await step("8", "цепочка: три письма — одна строка, в письме видна вся переписка", async () => {
    await d.button("Входящие");
    const threadRow = () =>
      d.exec(`return [...document.querySelectorAll('.row')].filter(r => r.innerText.includes('Бюджет на ноябрь')).map(r => r.querySelector('.count')?.innerText.trim() ?? '1')`);
    await d.until("one row with 3", async () => JSON.stringify(await threadRow()) === '["3"]', 15000);
    await openBySubject("Бюджет на ноябрь");
    // The newest letter is opened; the two before it fold into cards above.
    await d.until("conversation cards", async () => (await d.findAll(".thread .card")).length === 2);
    const t = await textOf(".thread");
    if (!t.includes("Мария Соколова")) throw new Error(`цепочка: ${t}`);
    await screenshot("conversation");
  }, { retry: true });

  await step("8", "письмо, открытое из карточки беседы, не закрывается, когда список обновляется", async () => {
    // The first letter of the conversation: not a row of the grouped list.
    await d.click((await d.findAll(".thread .card"))[0]);
    await d.until("older letter open", async () => (await textOf(".reader .body")).includes("Предлагаю обсудить"));
    // Any change reloads the list: a flag set and taken off on another letter.
    const other = await idOf("Скидки недели");
    await invoke("set_flag", { ids: [other], change: { flag: "flagged", value: true } });
    await invoke("set_flag", { ids: [other], change: { flag: "flagged", value: false } });
    await new Promise((r) => setTimeout(r, 1500));
    if (!(await textOf(".reader .body")).includes("Предлагаю обсудить")) throw new Error("письмо закрылось после обновления списка");
  });

  await step("13.1, 13.2", "люди и рассылки отдельно, у каждого списка свой выбор; отписка письмом", async () => {
    await viewOption("Рассылки");
    await rowBySubject("Скидки недели");
    if ((await textOf(".list .viewport")).includes("Счёт за октябрь")) throw new Error("письмо от человека среди рассылок");
    await viewOption("Люди");
    await d.until("people only", async () => {
      const t = await textOf(".list .viewport");
      return t.includes("Счёт за октябрь") && !t.includes("Скидки недели");
    });
    // The hidden mail is named on the button, and the choice belongs to this list only.
    const trigger = () => d.exec("const b = document.querySelector('.list .view .trigger'); return b ? [b.innerText.trim(), b.classList.contains('filtered')] : null");
    const [label, filtered] = await trigger();
    if (!filtered || !label.startsWith("Люди")) throw new Error(`кнопка «Вид»: ${label}`);
    await openFolder("Корзина");
    await d.until("trash unfiltered", async () => (await trigger())?.[1] === false);
    await d.button("Входящие");
    await d.until("inbox keeps People", async () => (await trigger())?.[1] === true);
    await viewOption("Все");
    await d.until("filter off", async () => (await trigger())?.[1] === false);
    await openBySubject("Скидки недели");
    await d.click(await d.find(".reader .chip"));
    // The letter is shown as it will go, and nothing goes before the user agrees.
    await d.until("unsubscribe letter shown", async () => {
      const t = await textOf(".reader .banner");
      return t.includes("carol@local.test") && t.includes("unsubscribe-weekly") && t.includes("Текст");
    });
    await new Promise((r) => setTimeout(r, 1500));
    if (helper("count", "INBOX", "unsubscribe-weekly") !== "0") throw new Error("письмо-отписка ушло до подтверждения");
    await d.click(await d.find(".reader .banner .btn.primary"));
    await d.until("unsubscribe request delivered", async () => helper("count", "INBOX", "unsubscribe-weekly") === "1", 40000);
  });

  await step("13.3", "сортировка: важное наверху не прыгает под рукой; по отправителю, как в кэше; свой порядок списка", async () => {
    const subjects = () => d.exec("return [...document.querySelectorAll('.list .row .subject')].map((e) => e.innerText)");
    const top = () => d.exec("const r = [...document.querySelectorAll('.list .row')].sort((a, b) => a.offsetTop - b.offsetTop)[0]; return r ? [r.querySelector('.subject').innerText, r.classList.contains('unread')] : null");
    try {
      // At least one unread letter to put on top.
      await openBySubject("Счёт за октябрь");
      await press("u");
      await viewOption("Важное наверху");
      // The order is applied by a reload of the list: wait for the top the cache gives for
      // it, not for the order the previous sort left (whose top may also be unread).
      const carol = (await invoke("accounts")).find((a) => a.email === "carol@local.test");
      const important = [
        { by: "unread", desc: true },
        { by: "people", desc: true },
        { by: "flagged", desc: true },
        { by: "date", desc: true },
      ];
      const cachedTop = async () =>
        (await invoke("messages", { query: { account_id: carol.id, folder: "INBOX", threads: true, sort: important, limit: 1 } }))[0]?.subject;
      await d.until(
        "unread on top",
        async () => {
          const t = await top();
          return t !== null && t[1] === true && t[0] === (await cachedTop());
        },
        15000,
      );
      // Read: the letter keeps its place until the list changes.
      const [first] = await top();
      await openBySubject(first);
      // The flag reaches the server and the list reloads meanwhile.
      await new Promise((r) => setTimeout(r, 2500));
      const [still] = await top();
      if (still !== first) throw new Error(`прочитанное уехало: наверху «${still}», было «${first}»`);

      // The list shows the order the cache gives for the same keys.
      await viewOption("По отправителю");
      const rows = await invoke("messages", { query: { role: "inbox", limit: 2000 } });
      const acc = rows[0].account_id;
      const want = await invoke("messages", {
        query: { account_id: acc, folder: "INBOX", threads: true, sort: [{ by: "sender", desc: false }, { by: "date", desc: true }], limit: 30 },
      });
      await d.until("sorted by sender", async () => {
        const shown = (await subjects()).slice(0, 10);
        return JSON.stringify(shown) === JSON.stringify(want.slice(0, 10).map((m) => m.subject || "(без темы)"));
      });
      const label = await textOf(".list .view .trigger");
      if (!label.includes("По отправителю")) throw new Error(`кнопка «Вид»: ${label}`);

      // An order of its own: other lists keep the common one. The scope tick is one click that
      // a redraw swallows; until it is checked, "По теме" would become the common order and
      // the trash would never say "По отправителю".
      await d.until("own order ticked", async () => {
        if (!(await d.exec("return !!document.querySelector('.pop')"))) {
          await d.click(await d.find(".list .view .trigger")).catch(() => {});
        }
        if (!(await d.exec("return !!document.querySelector('.pop .scope input:checked')"))) {
          const box = await d.find(".pop .scope input").catch(() => null);
          if (box) await d.click(box).catch(() => {});
          return null;
        }
        return true;
      });
      await viewOption("По теме");
      await d.until("inbox keeps subject, the common order stays sender", async () => {
        const s = await invoke("settings_get");
        const own = Object.values(s.view_sorts ?? {}).some((x) => x[0]?.by === "subject");
        return s.list_sort?.[0]?.by === "sender" && own ? true : null;
      });
      // A click on a folder can miss while the tree redraws: repeat it until the list
      // really is the trash, then wait until its order matches the common one.
      await d.until(
        "trash by sender",
        async () => {
          const title = (await textOf(".list .title h2")).trim();
          if (!title.startsWith("Корзина")) {
            await openFolder("Корзина").catch(() => {});
            return null;
          }
          return (await textOf(".list .view .trigger")).includes("По отправителю") ? true : null;
        },
        20000,
      );
      await d.button("Входящие");
      await d.until("inbox by subject", async () => (await textOf(".list .view .trigger")).includes("По теме"));
      const settings = await invoke("settings_get");
      if (!Object.values(settings.view_sorts).some((s) => s[0]?.by === "subject")) throw new Error(`настройки: ${JSON.stringify(settings.view_sorts)}`);
      await screenshot("sort");
    } finally {
      // Back to the defaults for the steps that follow, whatever failed above.
      await press("Escape");
      await d.button("Входящие");
      await d.click(await d.find(".list .view .trigger"));
      // Unticked, the list takes the common order again; then the common order is newest first.
      if (await d.exec("return !!document.querySelector('.pop .scope input:checked')")) await d.click(await d.find(".pop .scope input"));
      await viewOption("По дате");
    }
  });

  section("triage");
  await step("1.4", "«Готово» подряд: убранные письма не возвращаются в список, пока сервер их переносит", async () => {
    const subjects = ["Массовое письмо 605", "Массовое письмо 604", "Массовое письмо 603"];
    await openBySubject(subjects[0]);
    // Every change of the list is recorded: a letter must not come back once gone.
    await d.exec(`
      window.__rows = [];
      const list = document.querySelector('.rows') ?? document.querySelector('.list');
      const snap = () => window.__rows.push([...document.querySelectorAll('.row .subject')].map((s) => s.innerText.trim()));
      snap();
      window.__rowsObserver = new MutationObserver(snap);
      window.__rowsObserver.observe(list, { childList: true, subtree: true, characterData: true });`);
    for (const subj of subjects) {
      await d.until(`${subj} open`, async () => (await textOf(".reader h1")).includes(subj), 10000);
      await press("e");
    }
    for (const subj of subjects) {
      await d.until(`${subj} archived`, async () => helper("count", "Архив", subj) === "1", 30000);
    }
    // Syncs after the moves reload the list too.
    await new Promise((r) => setTimeout(r, 2000));
    const snaps = await d.exec("window.__rowsObserver.disconnect(); return window.__rows;");
    for (const subj of subjects) {
      const seen = snaps.map((rows) => rows.includes(subj));
      const gone = seen.indexOf(false);
      if (gone < 0) throw new Error(`«${subj}» не ушло из списка`);
      const back = seen.indexOf(true, gone);
      if (back >= 0) throw new Error(`«${subj}» вернулось в список после ухода (снимок ${back} из ${snaps.length})`);
    }
  });

  await step("1.4", "«Готово»: отметка «прочитано» у следующего письма не мигает, счётчик не растёт", async () => {
    const [done, next] = ["Массовое письмо 602", "Массовое письмо 601"];
    await invoke("set_flag", { ids: [await idOf(next)], change: { flag: "seen", value: false } });
    await d.until("unread on server", async () => !helper("flags", "INBOX", next).includes("\\Seen"), 15000);
    await openBySubject(done);
    // The counter has caught up with the mark above before recording starts.
    const unread = (await invoke("messages", { query: { role: "inbox", unread_only: true, limit: 50 } })).length;
    await d.until("inbox counter", async () =>
      Number(await d.exec("return [...document.querySelectorAll('nav.side .item')].find((b) => b.querySelector('.name')?.innerText.trim() === 'Входящие')?.querySelector('.count')?.innerText ?? 0")) === unread);
    // Every change of the next row and of the Inbox counter is recorded.
    await d.exec(`
      window.__flags = [];
      const snap = () => {
        const row = [...document.querySelectorAll('.list .row')].find((r) => r.querySelector('.subject')?.innerText.includes(arguments[0]));
        const inbox = [...document.querySelectorAll('nav.side .item')].find((b) => b.querySelector('.name')?.innerText.trim() === 'Входящие');
        window.__flags.push({ unread: row ? row.classList.contains('unread') : null, count: Number(inbox?.querySelector('.count')?.innerText ?? 0) });
      };
      snap();
      window.__flagsObserver = new MutationObserver(snap);
      window.__flagsObserver.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });`, next);
    await press("e");
    await d.until(`${next} open`, async () => (await textOf(".reader h1")).includes(next), 10000);
    await d.until(`${done} archived`, async () => helper("count", "Архив", done) === "1", 30000);
    await d.until(`${next} read on server`, async () => helper("flags", "INBOX", next).includes("\\Seen"), 15000);
    await new Promise((r) => setTimeout(r, 2000));
    const snaps = await d.exec("window.__flagsObserver.disconnect(); return window.__flags;");
    const states = snaps.map((s) => s.unread).filter((u) => u !== null);
    const read = states.indexOf(false);
    if (read < 0) throw new Error("следующее письмо не стало прочитанным");
    if (states.indexOf(true, read) >= 0) throw new Error(`отметка вернулась в «не прочитано»: ${states.join(" ")}`);
    const counts = snaps.map((s) => s.count);
    if (counts.some((c, i) => i > 0 && c > counts[i - 1])) throw new Error(`счётчик «Входящих» рос: ${counts.join(" ")}`);
  });

  await step("1", "«Готово» (e) убирает в архив, z возвращает", async () => {
    await openBySubject("Счёт на оплату");
    await press("e");
    await d.until("archived on server", async () => helper("count", "Архив", "Счёт на оплату") === "1", 20000);
    if (helper("count", "INBOX", "Счёт на оплату") !== "0") throw new Error("осталось во входящих");
    await d.until("archive folder created", async () => (await sidebarText()).includes("Архив"));
    // Right away, while the action may still be finishing: "z" must wait for it.
    await press("z");
    try {
      await d.until("back in inbox", async () => helper("count", "INBOX", "Счёт на оплату") === "1" && helper("count", "Архив", "Счёт на оплату") === "0", 20000);
    } catch (e) {
      throw new Error(`${e.message}; уведомления: ${await textOf(".toasts")}`);
    }
  });

  await step("2", "«Отложить»: письмо ждёт в «Отложенных» и возвращается непрочитанным", async () => {
    await d.button("Входящие");
    await openBySubject("Скидки недели");
    await press("h");
    await d.until("snooze menu", async () => (await textOf(".snooze .pop")).includes("Завтра"));
    await screenshot("snooze-menu");
    await press("Escape");
    // The offered times are hours away; the same command with a time 5 seconds ahead.
    await invoke("snooze", { ids: [await idOf("Скидки недели")], until: Math.floor(Date.now() / 1000) + 5 });
    await d.until("in Snoozed on server", async () => helper("count", "Отложенные", "Скидки недели") === "1", 20000);
    await d.until("back unread", async () =>
      helper("count", "INBOX", "Скидки недели") === "1" && !helper("flags", "INBOX", "Скидки недели").includes("\\Seen"), 45000, 1000);
  });

  await step("2.3", "«Отложить» цепочку: в «Отложенных» одна строка и единица в счётчике", async () => {
    const subj = `Цепочка ${stamp}`;
    helper("deliver", subj);
    helper("reply", "INBOX", subj);
    await d.button("Входящие");
    await d.until("thread of two", async () =>
      (await d.exec(`return [...document.querySelectorAll('.row')].find(r => r.innerText.includes(arguments[0]))?.querySelector('.count')?.innerText.trim() ?? ''`, subj)) === "2", 30000);
    await openBySubject(subj);
    await press("h");
    await d.click(await d.until("snooze preset", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Завтра')]")));
    await d.until("both in Snoozed on server", async () => helper("count", "Отложенные", subj) === "2", 20000);
    await d.button("Отложенные");
    await rowBySubject(subj, 10000);
    const rows = await d.exec(`return [...document.querySelectorAll('.row')].filter(r => r.innerText.includes(arguments[0])).length`, subj);
    if (rows !== 1) throw new Error(`строк цепочки в «Отложенных»: ${rows}`);
    // The folder counter follows scheduleFolders: it is absent until that pass, so wait
    // for it instead of reading once.
    await d.until("snoozed counter is 1", async () => {
      const badge = await d.exec(`return [...document.querySelectorAll('nav.side .item')].find(b => (b.querySelector('.name') ?? b).innerText.trim() === 'Отложенные')?.querySelector('.count')?.innerText.trim() ?? ''`);
      return badge === "1" ? true : null;
    });
  });

  await step("2.5", "«Отложить» по клавише: меню у строки, подменю рядом, день цифрой, тост и «Отменить» (#95, #96)", async () => {
    const subj = `Меню ${stamp}`;
    helper("deliver", subj);
    await d.button("Входящие");
    await rowBySubject(subj, 30000);
    await openBySubject(subj);
    const box = (css) => d.exec(`const r = document.querySelector(arguments[0])?.getBoundingClientRect(); return r ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null`, css);
    // «h» on the selected row: the menu hangs on that row, under it or over it, never on top of it.
    await press("h", { code: "KeyH" });
    await d.until("menu open", async () => (await d.findAll(".snooze .pop.main")).length === 1);
    const row = await box(".row.selected, .row.cursor");
    const menu = await box(".snooze .pop.main");
    if (!(menu.t >= row.b - 1 || menu.b <= row.t + 1)) throw new Error(`меню закрывает строку: строка ${JSON.stringify(row)}, меню ${JSON.stringify(menu)}`);
    if (menu.l < row.l - 1 || menu.l > row.r) throw new Error(`меню не у строки: строка ${JSON.stringify(row)}, меню ${JSON.stringify(menu)}`);
    // «Д» (the key of «Рабочие дни») lights the item, → opens the submenu beside it.
    await press("д", { code: "KeyL" });
    await press("ArrowRight", { code: "ArrowRight" });
    await d.until("submenu", async () => (await d.findAll(".snooze .pop.subm")).length === 1);
    const sub = await box(".snooze .pop.subm");
    const parent = await box(".snooze .pop.main");
    if (!(sub.l >= parent.r - 1 || sub.r <= parent.l + 1)) throw new Error(`подменю закрывает меню: ${JSON.stringify({ parent, sub })}`);
    if (sub.l < 0 || sub.r > (await d.exec("return window.innerWidth")) || sub.t < 0 || sub.b > (await d.exec("return window.innerHeight"))) {
      throw new Error(`подменю вышло за окно: ${JSON.stringify(sub)}`);
    }
    if ((await d.findAll(".snooze .mi.parent")).length !== 1) throw new Error("родитель подменю не подсвечен");
    await screenshot("snooze-submenu");
    // «1» is Monday, ISO: lights it in the submenu; Enter snoozes.
    await press("1", { code: "Digit1" });
    await press("Enter", { code: "Enter" });
    await d.until("in Snoozed on server", async () => helper("count", "Отложенные", subj) === "1", 20000);
    await d.until("toast", async () => /Отложено до пн, \d+ [а-я]+, 9:00/.test(await textOf(".toasts")));
    await d.click(await d.xpath("//div[contains(@class,'toasts')]//button[contains(., 'Отменить')]"));
    await d.until("undone on server", async () => helper("count", "INBOX", subj) === "1" && helper("count", "Отложенные", subj) === "0", 20000);
  });

  await step("2.4", "«Вернуть сейчас»: «w» возвращает отложенное письмо в «Входящие», «z» откладывает обратно", async () => {
    const subj = `Вернуть ${stamp}`;
    helper("deliver", subj);
    await d.button("Входящие");
    await rowBySubject(subj, 30000);
    await invoke("snooze", { ids: [await idOf(subj)], until: Math.floor(Date.now() / 1000) + 86400 });
    await d.until("in Snoozed on server", async () => helper("count", "Отложенные", subj) === "1", 20000);
    await d.button("Отложенные");
    await openBySubject(subj);
    await d.until("banner button", async () => (await textOf(".reader")).includes("Вернуть сейчас"));
    await press("w");
    // The toast first: it does not wait for the server and goes away in a few seconds.
    await d.until("toast", async () => (await textOf(".toasts")).includes(`Возвращено во «Входящие»: ${subj}`), 5000, 200);
    await d.until("back in inbox on server", async () => helper("count", "INBOX", subj) === "1" && helper("count", "Отложенные", subj) === "0", 20000);
    // The undo snoozes it again, for the same time.
    await press("z");
    await d.until("snoozed again", async () => helper("count", "Отложенные", subj) === "1" && helper("count", "INBOX", subj) === "0", 20000);
    // Put things in order: back to the inbox for the steps that follow.
    await d.button("Отложенные");
    await openBySubject(subj);
    await press("w");
    await d.until("inbox again", async () => helper("count", "INBOX", subj) === "1", 20000);
  });

  // The window read afresh; the click that follows must not land in the page being left.
  const reloadWindow = async () => {
    await d.exec("window.__before = true; location.reload()");
    await d.until("window reloaded", async () => (await d.exec("return document.readyState === 'complete' && !window.__before && !!document.querySelector('button')")));
  };

  await step("4.12", "письмо с Markdown-частью: переключатель «HTML · Markdown · Текст», задачи галочками, настройка «Показывать письма»", async () => {
    const subj = `Заметки ${stamp}`;
    helper("deliver-markdown", subj);
    await d.button("Входящие");
    await openBySubject(subj);
    const modes = async () =>
      (await d.exec("return [...document.querySelectorAll('.reader .letter-view [role=radio]')].map((b) => b.textContent.trim() + (b.getAttribute('aria-checked') === 'true' ? '*' : ''))")).join(" ");
    // As the sender sent it: the HTML, which Depesha puts last.
    await d.until("switch", async () => (await modes()) === "HTML* Markdown Текст");
    // The Markdown part is the letter's text, not an attachment.
    if ((await d.findAll(".reader .files")).length) throw new Error("Markdown-часть показана вложением");
    await d.click(await d.xpath("//div[contains(@class,'letter-view')]//button[normalize-space(.)='Markdown']"));
    const md = await d.until("markdown drawn", () =>
      d.exec(`const doc = document.querySelector('.reader iframe')?.contentDocument;
        if (!doc?.querySelector('h1')) return null;
        return { boxes: doc.querySelectorAll('input[type=checkbox][disabled]').length, done: doc.querySelectorAll('input[type=checkbox][checked]').length,
                 table: !!doc.querySelector('table') };`),
    );
    if (md.boxes !== 2 || md.done !== 1 || !md.table) throw new Error(`Markdown нарисован не так: ${JSON.stringify(md)}`);
    await screenshot("markdown-message");
    await d.click(await d.xpath("//div[contains(@class,'letter-view')]//button[normalize-space(.)='Текст']"));
    await d.until("plain text", async () => (await textOf(".reader .plain")).includes("- [x] договор подписан"));
    // The choice in a letter holds while it is open; the setting decides for the next one.
    const settings = await invoke("settings_get");
    await invoke("settings_set", { settings: { ...settings, letter_view: "markdown" } });
    await openBySubject("Счёт за октябрь");
    if ((await d.findAll(".reader .letter-view")).length) throw new Error("переключатель у письма без Markdown");
    await openBySubject(subj);
    await d.until("markdown preferred", async () => (await modes()) === "HTML Markdown* Текст");
    // The mailbox's own form comes before the setting (#105); the setting stays "markdown" here.
    const [mailbox] = await invoke("accounts");
    await invoke("account_save", { account: { ...mailbox, letter_view: "text" }, password: null, grant: null });
    await invoke("settings_set", { settings: { ...settings, letter_view: "sender" } });
    // The window reads the mailboxes once: a reload shows the saved one.
    await reloadWindow();
    await d.button("Входящие");
    await openBySubject(subj);
    await d.until("mailbox view applied", async () => (await modes()) === "HTML Markdown Текст*");
    await invoke("account_save", { account: { ...mailbox, letter_view: null }, password: null, grant: null });
    await reloadWindow();
    await d.button("Входящие");
  });

  await step("4.15", "печать письма (#70): Ctrl+P, палитра, «Ещё», меню строки и окно письма печатают отдельный лист — шапку и тело в виде на экране, не интерфейс", async () => {
    // The system's print dialog cannot be driven: the frame's print() is replaced, and what the
    // frame holds at that moment is what would be printed. The sheets are kept for the pictures.
    const intercept = () =>
      d.exec(`if (window.__prints) return;
        window.__prints = [];
        const get = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow').get;
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', { configurable: true, get() {
          const w = get.call(this);
          if (w && this.classList.contains('print-frame') && !w.__hooked) {
            w.__hooked = true;
            const frame = this;
            w.print = () => window.__prints.push({ html: frame.contentDocument.documentElement.outerHTML, text: frame.contentDocument.body.innerText,
              main: frame.contentDocument.querySelector('main')?.innerHTML ?? '',
              // How many boxes of the body sit over the header: a letter's own placing must not reach it.
              overHeader: (() => { const d = frame.contentDocument, h = d.querySelector('header').getBoundingClientRect();
                return [...d.querySelectorAll('main *')].filter((el) => { const r = el.getBoundingClientRect();
                  return r.width > 0 && r.height > 0 && r.top < h.bottom && r.bottom > h.top && r.left < h.right && r.right > h.left; }).length; })(), width: frame.getBoundingClientRect().width, hidden: getComputedStyle(frame).display === 'none' });
          }
          return w;
        } });`);
    const count = () => d.exec("return window.__prints.length");
    const lastPrint = () => d.exec("return window.__prints.at(-1)");
    const sheet = async (n, name) => {
      await d.until(`print ${n}`, async () => (await count()) === n, 20000);
      const p = await lastPrint();
      writeFileSync(join(screens, `print-${name}.html`), p.html);
      return p;
    };
    // The key as the window gets it; true when the browser's own Ctrl+P was stopped.
    const ctrlP = (target = "window") =>
      d.exec(`const e = new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true, cancelable: true });
        (arguments[0] === 'window' ? window : document.querySelector(arguments[0])).dispatchEvent(e); return e.defaultPrevented;`, target);
    const expectIn = (what, text, ...parts) => {
      for (const part of parts) if (!text.includes(part)) throw new Error(`${what}: нет «${part}»`);
    };
    const expectNot = (what, text, ...parts) => {
      for (const part of parts) if (text.includes(part)) throw new Error(`${what}: есть «${part}»`);
    };

    // 1. An HTML letter with a file: Ctrl+P on the open letter.
    await d.button("Входящие");
    await openBySubject("HTML-письмо с картинками");
    await intercept();
    if (!(await ctrlP())) throw new Error("Ctrl+P не отнят у браузера: он напечатал бы весь интерфейс");
    let p = await sheet(1, "html");
    expectIn("лист HTML-письма", p.html, "<h1>HTML-письмо с картинками</h1>", "<dt>От</dt><dd>Рассылка &lt;news@example.org&gt;</dd>", "<dt>Кому</dt>", "<dt>Дата</dt>", "<dt>Вложения</dt><dd>report.pdf</dd>", "Новости", "data:image/png");
    expectNot("лист HTML-письма", p.html, "<script>", "onclick", "class=\"reader\"", "<nav");
    // Remote pictures print as the screen shows them: this sender may be trusted by now (4.4).
    const onScreen = await d.exec("return /img-src data: https: http:/.test(document.querySelector('.reader iframe').srcdoc)");
    if (p.html.includes("img-src data: https: http:") !== onScreen) throw new Error(`внешние картинки: на экране ${onScreen}, в листе ${!onScreen}`);
    if (!onScreen) expectNot("лист HTML-письма", p.html, "tracker.example");
    if (p.html.split("</header>")[0].includes("<img")) throw new Error("в шапке листа картинка (логотип)");
    if (p.overHeader) throw new Error(`тело письма лежит поверх шапки листа: ${p.overHeader}`);
    if (p.hidden || p.width < 700) throw new Error(`кадр печати не уложен на лист: ${JSON.stringify({ hidden: p.hidden, width: p.width })}`);
    if ((await d.findAll("iframe.print-frame")).length !== 1) throw new Error("кадров печати не один");

    // 2. The form on screen: Markdown, then text. A letter in the thread prints alone.
    const subj = `Заметки ${stamp}`;
    await openBySubject(subj).catch(async (e) => {
      throw new Error(`${e.message}; список: ${JSON.stringify(await d.exec("return [document.querySelector('.list h2')?.innerText, ...[...document.querySelectorAll('.row .subject')].slice(0, 12).map((x) => x.innerText)]"))}`);
    });
    await d.click(await d.xpath("//div[contains(@class,'letter-view')]//button[normalize-space(.)='Markdown']"));
    await d.until("markdown drawn", () => d.exec("return !!document.querySelector('.reader iframe')?.contentDocument?.querySelector('h1')"));
    await ctrlP();
    p = await sheet(2, "markdown");
    expectIn("лист Markdown", p.html, `<h1>${subj}</h1>`, "<table", "type=\"checkbox\"", "border-collapse:collapse");
    if (!p.main.includes("<h1")) throw new Error("в теле листа нет заголовка Markdown");
    await d.click(await d.xpath("//div[contains(@class,'letter-view')]//button[normalize-space(.)='Текст']"));
    await d.until("text drawn", async () => (await d.findAll(".reader .plain")).length === 1);
    await ctrlP();
    p = await sheet(3, "text");
    expectIn("лист текста", p.main, "class=\"plain\"");
    expectNot("лист текста", p.main, "<h1", "<table");

    // 3. «More», the palette.
    await d.click(await d.find(".reader .toolbar [aria-label='Ещё']"));
    await d.click(await d.until("print item", () => d.xpath("//div[contains(@class,'pop')]//button[contains(@class,'mi')][contains(., 'Печать')]")));
    p = await sheet(4, "more-menu");
    expectIn("лист из меню «Ещё»", p.html, `<h1>${subj}</h1>`);
    await press("k", { ctrlKey: true });
    await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
    await d.type(await d.find(".palette .q"), "печать");
    await d.until("palette lists print", async () => (await textOf(".palette")).includes("Печать"));
    await d.type(await d.find(".palette .q"), "");
    p = await sheet(5, "palette");
    expectIn("лист из палитры", p.html, `<h1>${subj}</h1>`);

    // 4. The context menu of a row prints that letter.
    const other = "Счёт за октябрь";
    await rowBySubject(other);
    await d.exec(
      `const row = [...document.querySelectorAll('.row')].find(r => r.innerText.includes(arguments[0]));
       const r = row.getBoundingClientRect();
       row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 }));`,
      other,
    );
    await d.until("row menu", async () => (await textOf(".pop")).includes("Печать"));
    await d.click(await d.xpath("//div[contains(@class,'pop')]//button[contains(@class,'mi')][contains(., 'Печать')]"));
    p = await sheet(6, "row-menu");
    expectIn("лист из меню строки", p.html, `<h1>${other}</h1>`);
    // The right click selects the row, as it always did, so the reader shows it by now; the sheet is its own.
    if ((await d.findAll("iframe.print-frame")).length !== 1) throw new Error("кадров печати не один");

    // 5. In a composition the key is still the app's, and prints nothing.
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    if (!(await ctrlP(".compose textarea"))) throw new Error("в письме, которое пишут, Ctrl+P достался браузеру");
    await new Promise((r) => setTimeout(r, 400));
    if ((await count()) !== 6) throw new Error("Ctrl+P в написании письма напечатал лист");
    await d.click(await d.find(".compose header button:last-child"));
    await composeClosed();

    // 6. The letter's own window: the same function.
    const title = "Документы на проверку";
    const main = await d.req("GET", d.s("/window"));
    await openFolder("Работа");
    await rowBySubject(title);
    await d.exec(
      `const row = [...document.querySelectorAll('.row')].find(r => r.innerText.includes(arguments[0]));
       row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));`,
      title,
    );
    const handles = () => d.req("GET", d.s("/window/handles"));
    await d.until("second window", async () => (await handles()).length === 2, 15000);
    const own = (await handles()).find((h) => h !== main);
    await d.req("POST", d.s("/window"), { handle: own });
    try {
      await d.until("letter in its window", async () => (await textOf(".reader h1")).includes(title), 20000);
      await intercept();
      if (!(await ctrlP())) throw new Error("в окне письма Ctrl+P достался браузеру");
      p = await sheet(1, "window");
      expectIn("лист из окна письма", p.html, `<h1>${title}</h1>`, "<dt>Вложения</dt>", "contract.pdf");
      await press("Escape");
      await d.until("window closed", async () => (await handles()).length === 1, 20000);
    } finally {
      await d.req("POST", d.s("/window"), { handle: main });
    }
    await d.button("Входящие");

    // 7. The letter's own frame: its links, hover and keys reach the app, and nothing in it runs.
    await openBySubject("HTML-письмо с картинками");
    const frameDoc = "document.querySelector('.reader iframe').contentDocument";
    const inFrame = async () => {
      const frame = await d.find(".reader iframe");
      const r = await d.exec("const b = document.querySelector('.reader iframe').getBoundingClientRect(); return [b.width, b.height]");
      // The lower right corner: the letter's text and links are up and to the left.
      await d.clickAt(frame, Math.round(r[0] / 2) - 12, Math.round(r[1] / 2) - 12);
      if ((await d.exec("return document.activeElement?.tagName")) !== "IFRAME") throw new Error("фокус не в кадре письма");
    };
    // The frame's handlers are attached: a link's hover shows its address, and a click asks before
    // opening it instead of the frame following it.
    await d.exec(`${frameDoc}.querySelector('a').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
    await d.until("link hover reaches the app", async () => (await textOf(".reader .status")).includes("example.com/news"));
    const clickLink = (selector) =>
      d.exec(`${frameDoc}.querySelector(arguments[0]).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`, selector);
    const dismissQuestion = async () => {
      await press("Escape");
      await d.until("question closed", async () => (await d.findAll(".confirm")).length === 0);
    };
    await clickLink("a");
    await d.until("link asks first", async () => (await textOf(".confirm")).includes("example.com"));
    await dismissQuestion();

    // 7a. The keys as the driver sends them, with the focus on the page and then inside the frame:
    // the frame replays them to the window (MailFrame.svelte), so the palette opens and the letter prints.
    const paletteOpen = async () => (await d.findAll(".palette")).length === 1;
    const closePalette = async () => {
      await d.pressKey("");
      await d.until("palette closed", async () => !(await paletteOpen()));
    };
    await d.exec("document.activeElement?.blur()");
    await d.chord([""], "k");
    await d.until("palette by a key on the page", paletteOpen);
    await closePalette();
    await inFrame();
    await d.chord([""], "k");
    await d.until("palette by a key in the letter's frame", paletteOpen);
    await closePalette();
    const before = await count();
    await inFrame();
    await d.chord([""], "p");
    p = await sheet(before + 1, "frame-key");
    expectIn("лист по Ctrl+P из кадра письма", p.html, "<h1>HTML-письмо с картинками</h1>");
    // 7b. The same key as an event of the frame's own document: the window takes it, so the frame's default is cancelled.
    const prevented = await d.exec(
      `const e = new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true, cancelable: true });
       ${frameDoc}.body.dispatchEvent(e); return e.defaultPrevented;`,
    );
    if (!prevented) throw new Error("Ctrl+P в кадре письма достался браузеру");
    await sheet(before + 2, "frame-key-event");

    // 7c. Nothing a letter writes runs in its frame: an image with a handler, a javascript: link and a
    // data: image with a script do not reach the page (`parent.__pwned`), and the frame stays where it is.
    await d.exec(`window.__pwned = undefined;
      ${frameDoc}.body.innerHTML = '<img src="x" onerror="parent.__pwned=1">' +
        '<a id="js" href="javascript:parent.__pwned=1">j</a>' +
        '<a id="svg" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27%3E%3Cscript%3Eparent.__pwned=1%3C/script%3E%3C/svg%3E">s</a>';`);
    await new Promise((r) => setTimeout(r, 800));
    for (const id of ["#js", "#svg"]) {
      await clickLink(id);
      // The app asks before it opens any address, and is answered «no».
      await d.until(`${id} asks first`, async () => (await d.findAll(".confirm")).length === 1);
      await dismissQuestion();
    }
    await new Promise((r) => setTimeout(r, 500));
    const pwned = await d.exec(`return { pwned: window.__pwned ?? null, url: document.querySelector('.reader iframe').contentWindow.location.href, kept: !!${frameDoc}.getElementById('js') }`);
    if (pwned.pwned !== null) throw new Error("critical: в кадре письма выполнился код письма (parent.__pwned)");
    if (pwned.url !== "about:srcdoc" || !pwned.kept) throw new Error(`кадр письма перешёл по ссылке: ${JSON.stringify(pwned)}`);

    // 8. A letter that places its text at the top of the page does not cover the header of the sheet.
    const forged = `Подделка шапки ${stamp}`;
    helper("deliver-overlay", forged);
    await d.button("Входящие");
    await openBySubject(forged);
    await ctrlP();
    p = await sheet(before + 3, "overlay");
    expectIn("лист письма-подделки", p.main, "ПОДДЕЛЬНАЯ ШАПКА", "position:absolute");
    expectIn("лист письма-подделки", p.html, `<h1>${forged}</h1>`, "<dd>Mallory &lt;mallory@example.org&gt;</dd>");
    if (p.overHeader) throw new Error(`письмо легло поверх шапки листа: ${p.overHeader} блоков`);
  });

  await step("9.2", "карточка человека: щелчок по имени открывает её, «Все письма» в фокусе, Enter ищет отправителя (#66, #44)", async () => {
    const subj = `Карточка ${stamp}`;
    helper("deliver", subj);
    await d.button("Входящие");
    await d.until("delivered", async () => helper("count", "INBOX", subj) === "1", 60000, 1000);
    await openBySubject(subj);
    // The click on the sender's name opens their card, not the search it used to run.
    await d.click(await d.find(".reader .sender"));
    await d.until("person card", async () => (await d.findAll(".pcard")).length === 1);
    // The card holds the rules of #44: the format to write in and the form to show.
    const card = await textOf(".pcard");
    if (!card.includes("Формат писем") || !card.includes("Все письма")) throw new Error(`карточка: ${card.slice(0, 200)}`);
    // The first button is «All mail» and stands in focus; Enter runs what a click used to.
    const focused = await d.exec("return document.activeElement?.innerText?.trim() ?? ''");
    if (focused !== "Все письма") throw new Error(`в фокусе «${focused}», а не «Все письма»`);
    await screenshot("person-card");
    // A real Enter on the focused button: what the keyboard does, not a synthetic event.
    await d.pressKey("\uE007");
    await d.until("search by sender", async () => (await d.exec("return document.querySelector('.list .search input')?.value ?? ''")).includes("from:petr@example.org"));
    await rowBySubject(subj, 10000);
  });
  await step("9.3", "адресная книга (#104): открыть с клавиатуры, найти человека, изменить настройку, объединить и вернуть; ссылка «Своё у …» из настроек; карточка письма клавишей, имя в карточке", async () => {
    const people = () => invoke("people", { query: "" });
    const byEmail = async (email) => (await people()).find((p) => p.emails.some((a) => a.email.toLowerCase() === email));
    const night = (on) => d.exec("document.documentElement.dataset.theme = arguments[0]", on ? "night" : "paper");
    const was = await d.exec("return document.documentElement.dataset.theme ?? ''");
    const focusList = () => d.exec("document.querySelector('.people [role=listbox]').focus()");
    const rowMark = (mark) => d.exec(`document.querySelector('.people [data-r="${mark}"]').focus()`);
    // Two records that may be one person: the same words of a name in another order.
    for (const [email, name] of [["olga.e2e@example.org", "Ольга Смирнова"], ["smirnova.e2e@example.net", "Смирнова Ольга"]]) {
      await invoke("person_save", { person: { email, name, manual: true } });
    }
    await reloadWindow();
    await d.button("Входящие");

    // The book opens from the keyboard: the palette, «go to people».
    await press("k", { ctrlKey: true });
    await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
    await d.type(await d.find(".palette .q"), "перейти люди");
    await d.type(await d.find(".palette .q"), "\uE007");
    await d.until("book", async () => (await d.findAll(".people")).length === 1);
    if (!(await d.findAll("nav.side .item.active")).length) throw new Error("в боковой панели «Люди» не отмечены");
    await screenshot("people-book");
    await night(true);
    await screenshot("people-book-night");
    await night(false);

    // A person is found by a word of the name: «/» in the list goes to the search, ↓ comes back.
    await focusList();
    await d.pressKey("/");
    await d.until("search has the focus", async () => (await d.exec("return document.activeElement?.type")) === "search");
    await d.type(await d.find(".people input[type=search]"), "смирнова");
    await d.until("two found", async () => (await d.findAll(".people .pr")).length === 2);
    await d.pressKey("\uE015");
    await d.until("list has the focus", async () => (await d.exec("return document.activeElement?.getAttribute('role')")) === "listbox");
    // The card on the right is the first person's, and it suggests the second as the same person.
    const cards = await textOf(".people .pd");
    if (!cards.includes("Ольга Смирнова")) throw new Error(`карточка справа: ${cards.slice(0, 200)}`);
    if (!(await textOf(".people .pd .pc-dup")).includes("Смирнова Ольга")) throw new Error(`нет подсказки о дубле в карточке: ${cards.slice(0, 300)}`);

    // Enter goes into the card, on «All mail»; its format is turned by the arrows and saved at once.
    await d.pressKey("\uE007");
    await d.until("card has the focus", async () => (await d.exec("return document.activeElement?.dataset?.r")) === "all");
    await rowMark("fmt");
    await d.pressKey("\uE014");
    await d.until("format saved", async () => (await byEmail("olga.e2e@example.org"))?.send_format === "html", 15000);
    await screenshot("people-card");
    await night(true);
    await screenshot("people-card-night");
    await night(false);

    // Esc comes back to the list; M joins the suggested pair, the dialog shows what it offers, Enter takes it.
    await d.pressKey("\uE00C");
    await d.until("list again", async () => (await d.exec("return document.activeElement?.getAttribute('role')")) === "listbox");
    // Space marks the two, the banner counts them, M opens the dialog.
    await d.pressKey(" ");
    await d.pressKey("\uE015");
    await d.pressKey(" ");
    await d.until("two marked", async () => (await textOf(".people .banner")).includes("Отмечено: 2"));
    await d.pressKey("m");
    await d.until("merge dialog", async () => (await d.findAll(".merge")).length === 1);
    await screenshot("people-merge");
    await night(true);
    await screenshot("people-merge-night");
    await night(false);
    await d.pressKey("\uE007");
    await d.until("merged", async () => (await byEmail("olga.e2e@example.org"))?.emails.length === 2, 15000);
    await d.until("undo toast", async () => (await textOf(".toasts")).includes("Объединено"));
    const merged = await byEmail("smirnova.e2e@example.net");
    if (merged.send_format !== "html") throw new Error(`правило не сохранилось при объединении: ${JSON.stringify(merged)}`);
    // Z takes it back: two people again, each with their own address.
    await d.pressKey("z");
    await d.until("split back", async () => (await byEmail("olga.e2e@example.org"))?.emails.length === 1 && (await byEmail("smirnova.e2e@example.net"))?.emails.length === 1, 15000);

    // The way from the settings: «Own at …» on the format's row opens the book, narrowed to the people with a format.
    await press(",", { ctrlKey: true });
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    await d.click(await d.find(".prefs .tab[data-page='writing']"));
    await d.until("writing page", async () => (await textOf(".prefs .pane h2")) === "Написание");
    await d.click(await d.find(".prefs [data-row='layer_format'] .lnk"));
    // Several places differ (a mailbox too): the way is a menu, and the person is picked in it.
    if (await d.exec("return new Promise((r) => setTimeout(() => r(!!document.querySelector('.pop')), 400))")) {
      await d.click(await d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Ольга Смирнова')]"));
    }
    await d.until("book from settings", async () => (await d.findAll(".people")).length === 1 && (await d.findAll(".prefs")).length === 0);
    if (!(await textOf(".people .fchip.on")).includes("С особым форматом")) throw new Error("список не отфильтрован по «С особым форматом»");
    await screenshot("people-from-settings");
    if ((await d.findAll(".prefs .tab[data-page='people']")).length) throw new Error("в настройках остался пункт «Люди»");

    // The test people go away; the letter of 9.2 gets its card by the key, and the name is written in it.
    for (const email of ["olga.e2e@example.org", "smirnova.e2e@example.net"]) await invoke("person_forget", { email });
    await d.button("Входящие");
    const subj = `Карточка ${stamp}`;
    await openBySubject(subj);
    await d.exec("document.activeElement?.blur?.()");
    await d.pressKey("p");
    await d.until("card by the key", async () => (await d.findAll(".pcard")).length === 1);
    await d.until("card focus", async () => (await d.exec("return document.activeElement?.dataset?.r")) === "all");
    await screenshot("people-letter-card");
    await d.pressKey("\uE013");
    await d.pressKey("\uE032");
    await d.until("name line", async () => (await d.findAll(".pcard input[data-own]")).length === 1);
    await d.type(await d.find(".pcard input[data-own]"), " Е2Е\uE007");
    await d.until("name saved", async () => (await byEmail("petr@example.org"))?.name.endsWith("Е2Е"), 15000);
    // Esc leaves the line without closing the card; the name goes back to what the letters say.
    await d.pressKey("\uE032");
    await d.until("name line again", async () => (await d.findAll(".pcard input[data-own]")).length === 1);
    await d.pressKey("\uE00C");
    if ((await d.findAll(".pcard")).length !== 1) throw new Error("Esc в строке имени закрыл карточку");
    await d.pressKey("\uE032");
    await d.until("name line third", async () => (await d.findAll(".pcard input[data-own]")).length === 1);
    // The line opens with the name selected: BackSpace empties it, Enter saves an empty name (the letters' own comes back).
    await d.pressKey("\uE003");
    await d.pressKey("\uE007");
    await d.until("name back", async () => !(await byEmail("petr@example.org"))?.name.endsWith("Е2Е"), 15000);
    await d.pressKey("\uE00C");
    await d.until("card closed", async () => (await d.findAll(".pcard")).length === 0);
    await d.exec("document.documentElement.dataset.theme = arguments[0]", was);
  });
  section("sendlater");
  await step("5.8", "проверка перед отправкой и отмена отправки", async () => {
    const subj = `Отмена ${stamp}`;
    await newMessage("carol@local.test", subj, "Договор во вложении.");
    await d.click(await d.find(".compose .split-btn .main"));
    await d.until("attachment warning", async () => (await textOf(".compose .warnings")).includes("вложение"));
    await screenshot("preflight");
    await d.click(await d.find(".compose .warnings .btn.primary"));
    await composeClosed();
    await d.click(await d.until("undo toast", () => d.xpath("//div[contains(concat(' ', normalize-space(@class), ' '), ' toast ')][contains(., 'Отправляется')]//button[contains(@class,'act')]")));
    await d.until("compose is back", async () => (await d.findAll(".compose")).length === 1);
    const back = await d.exec("return document.querySelector('.compose .subject').value");
    if (back !== subj) throw new Error(`вернулось: ${back}`);
    await new Promise((r) => setTimeout(r, 12000));
    if (helper("count", "INBOX", subj) !== "0") throw new Error("письмо ушло, хотя отправку отменили");
    // Closing keeps it as a draft.
    await d.click(await d.find(".compose header > button:last-child"));
    await composeClosed();
  });

  await step("5.8", "обратный отсчёт в «Отправляется…» идёт, а не стоит (#75)", async () => {
    const subj = `Отсчёт ${stamp}`;
    await newMessage("carol@local.test", subj, "Просто текст.");
    await d.click(await d.find(".compose .split-btn .main"));
    await composeClosed();
    const toast = "//div[contains(concat(' ', normalize-space(@class), ' '), ' toast ')][contains(., 'Отправляется')]";
    const left = async () => {
      const text = await d.exec("return [...document.querySelectorAll('.toasts .toast')].map((t) => t.innerText).find((t) => t.includes('Отправляется')) ?? ''");
      const n = /ещё (\d+)/.exec(text)?.[1];
      if (n === undefined) throw new Error(`в тосте нет числа секунд: ${text}`);
      return Number(n);
    };
    await d.until("sending toast", () => d.xpath(toast));
    const first = await left();
    await new Promise((r) => setTimeout(r, 2500));
    const second = await left();
    if (!(second < first)) throw new Error(`отсчёт стоит: было ${first}, стало ${second}`);
    await d.click(await d.xpath(`${toast}//button[contains(@class,'act')]`));
    await d.until("compose is back", async () => (await d.findAll(".compose")).length === 1);
    await d.click(await d.find(".compose header > button:last-child"));
    await composeClosed();
  });

  await step("5.9", "«Отправить позже»: письмо ждёт в «Исходящих» своего времени", async () => {
    const subj = `Позже ${stamp}`;
    await newMessage("carol@local.test", subj, "Утром.");
    await d.click(await d.find(".compose .split-btn .more"));
    await d.click(await d.until("preset", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Завтра утром')]")));
    await composeClosed();
    await d.button("Исходящие");
    await d.until("scheduled", async () => {
      const t = await textOf(".outbox");
      return t.includes(subj) && t.includes("Запланировано: отправится завтра");
    });
    await screenshot("outbox-scheduled");
    await d.click(await d.xpath(`//div[contains(@class,'item')][contains(., ${JSON.stringify(subj)})]//button[contains(., 'Отправить сейчас')]`));
    await d.until("delivered", async () => helper("count", "INBOX", subj) === "1", 60000, 1000);
  });

  await step("5.9", "«Отправить позже» до получателей: время остаётся, основная кнопка планирует", async () => {
    const subj = `Сначала время ${stamp}`;
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await d.click(await d.find(".compose .split-btn .more"));
    await d.click(await d.until("preset", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Завтра утром')]")));
    await d.until("schedule kept", async () => (await textOf(".compose .scheduled")).includes("Запланировано на"));
    // Not to oneself: a draft without recipients keeps one's own address, and opening it drops that.
    await d.type((await d.findAll(".compose .box input"))[0], "dave@local.test");
    await setInput(".compose .subject", subj);
    // Closed and opened again from Drafts: the time is still there.
    await d.click(await d.find(".compose header > button:last-child"));
    await composeClosed();
    await d.until("draft on server", async () => helper("count", "Drafts", subj) === "1", 15000);
    await openFolder("Черновики");
    await openBySubject(subj);
    await d.button("Продолжить");
    await d.until("draft opened", async () => (await d.findAll(".compose")).length === 1);
    await d.until("schedule restored", async () => (await textOf(".compose .scheduled")).includes("Запланировано на"));
    await d.until("main button schedules", async () => (await textOf(".compose .split-btn .main")).includes("Запланировать"));
    await d.click(await d.find(".compose .split-btn .main"));
    await composeClosed();
    await d.button("Исходящие");
    await d.until("scheduled", async () => {
      const t = await textOf(".outbox");
      return t.includes(subj) && t.includes("Запланировано: отправится завтра");
    });
    // The queue is left empty for the steps that count on it.
    await d.click(await d.xpath(`//div[contains(@class,'item')][contains(., ${JSON.stringify(subj)})]//button[contains(., 'Отправить сейчас')]`));
    await d.until("sent", async () => !(await textOf(".outbox")).includes(subj), 60000, 1000);
  });

  section("reminders");
  await step("5.10", "«Ждут ответа»: напоминание снимается, когда приходит ответ", async () => {
    const subj = `Вопрос ${stamp}`;
    await newMessage("carol@local.test", subj, "Когда будет готово?");
    // The reminder is chosen in the menu of «Snooze»: typed «через 3 дня», Enter; the chip shows the date.
    await remindBy("через 3 дня");
    if ((await textOf(".compose .remind")).includes("Без напоминания")) throw new Error("срок не выбран");
    await d.click(await d.find(".compose .split-btn .main"));
    await composeClosed();
    await d.until("waiting in sidebar", async () => (await sidebarText()).includes("Ждут ответа"), 60000, 1000);
    await d.button("Ждут ответа");
    await rowBySubject(subj, 20000);
    await screenshot("followups");
    helper("reply", "Sent", subj);
    // Answered: out of the active ones, kept among the closed with who replied.
    await d.until("resolved", async () => (await invoke("counters")).followups === 0, 60000, 1000);
    if (!(await sidebarText()).includes("Ждут ответа")) throw new Error("«Ждут ответа» пропал, хотя закрытое ожидание есть");
    await d.button("Закрытые");
    await rowBySubject(subj, 20000);
    await screenshot("followups-closed");
    await d.button("Активные");
  });

  await step("5.10", "ответ с «Без напоминания» и галочкой «Убрать письмо из входящих»: письмо в архиве, «Ждут ответа» пусто (#106)", async () => {
    const subj = `Без ожидания ${stamp}`;
    const acc = (await invoke("accounts"))[0];
    const waiting = (park) => invoke("account_save", { account: { ...acc, waiting: { park, folder: "", stop_to_archive: false } }, password: null, grant: null });
    // The mailbox that takes answered letters out of the inbox; the window reads it at start.
    await waiting(true);
    try {
      await d.exec("location.reload()");
      await d.button("Входящие");
      helper("deliver", subj);
      await d.until("letter in inbox", async () => helper("count", "INBOX", subj) === "1", 30000);
      await openBySubject(subj);
      await d.button("Ответить");
      await d.until("reply compose", async () => (await d.findAll(".compose")).length === 1);
      await d.until("the box", async () => (await d.findAll(".compose .wait-line .queue input")).length === 1);
      const text = await textOf(".compose .wait-line");
      if (!text.includes("Убрать письмо из входящих") || text.includes("до ответа")) throw new Error(`строка: ${text}`);
      if (!(await d.exec("return document.querySelector('.compose .wait-line .queue input').checked"))) throw new Error("галочка не стоит по умолчанию");
      if (!text.includes("Без напоминания")) throw new Error(`напоминание: ${text}`);
      await d.type(await d.find(".compose textarea"), "Принято.");
      await d.button("Отправить");
      await d.until("original in archive", async () => helper("count", "Архив", subj) === "1" && helper("count", "INBOX", subj) === "0", 60000, 1000);
      await d.until("toast", async () => (await textOf(".toasts")).includes("Письмо — в архиве"), 20000);
      if ((await invoke("counters")).followups !== 0) throw new Error("появилось ожидание");
      const folders = await invoke("folders");
      if (folders.some((f) => f.display_name === "Ждут ответа" && f.total > 0)) throw new Error("в «Ждут ответа» есть письма");
    } finally {
      await waiting(false);
    }
  });

  await step("5.10", "ответ с напоминанием и парковкой: «Не ждать» и «Отменить» — письмо остаётся в папке «Ждут ответа» (#98)", async () => {
    const subj = `Парковка ${stamp}`;
    const acc = (await invoke("accounts"))[0];
    const waiting = (park) => invoke("account_save", { account: { ...acc, waiting: { park, folder: "", stop_to_archive: false } }, password: null, grant: null });
    await waiting(true);
    try {
      await d.exec("location.reload()");
      await d.button("Входящие");
      helper("deliver", subj);
      await d.until("letter in inbox", async () => helper("count", "INBOX", subj) === "1", 30000);
      await openBySubject(subj);
      await d.button("Ответить");
      await d.until("reply compose", async () => (await d.findAll(".compose")).length === 1);
      await remindBy("через 3 дня");
      await d.type(await d.find(".compose textarea"), "Жду.");
      await d.button("Отправить");
      // The letter waits in the folder of the mailbox, out of the inbox.
      const folder = "Ждут ответа";
      await d.until("letter parked", async () => helper("count", folder, subj) === "1" && helper("count", "INBOX", subj) === "0", 60000, 1000);
      await d.button("Ждут ответа");
      await openBySubject(subj);
      await d.button("Не ждать");
      await d.until("not waiting", async () => (await invoke("counters")).followups === 0, 20000);
      const toast = "//div[contains(concat(' ', normalize-space(@class), ' '), ' toast ')][contains(., 'Не ждём ответа')]";
      await d.click(await d.until("stop toast", () => d.xpath(`${toast}//button[contains(@class,'act')]`)));
      await d.until("waiting again", async () => (await invoke("counters")).followups > 0, 20000);
      // Past the time the return was held back for: the letter is still in the folder, not in the inbox.
      await new Promise((r) => setTimeout(r, 20000));
      if (helper("count", folder, subj) !== "1" || helper("count", "INBOX", subj) !== "0") throw new Error("после «Отменить» письмо не осталось в папке ожидания");
      await d.until("row in the list", async () => (await textOf(".list")).includes(subj), 20000);
      // Stopped for good: the letters go back to the inbox once the toast is gone.
      await d.button("Не ждать");
      await d.until("back in the inbox", async () => helper("count", "INBOX", subj) === "1" && helper("count", folder, subj) === "0", 90000, 1000);
    } finally {
      await waiting(false);
    }
  });

  await step("5.10", "«Ждут ответа»: свой срок через «Настроить…» запоминается в списке", async () => {
    const subj = `Свой срок ${stamp}`;
    await newMessage("carol@local.test", subj, "Жду ответа.");
    await remindMenu();
    await d.click(await d.find(".snooze [data-row='setup']"));
    await d.until("custom form", async () => (await textOf(".compose .pop")).includes("Через"));
    await setInput(".pop .num", "2");
    await d.exec("const s = document.querySelector('.pop select'); s.value = 'workdays'; s.dispatchEvent(new Event('change', { bubbles: true }));");
    await d.click(await d.find(".pop .keep input"));
    await d.click(await d.find(".pop .btn.primary"));
    await d.until("kept choice shown", async () => (await textOf(".compose .remind")).includes("через 2 рабочих дня"));
    const started = Math.floor(Date.now() / 1000);
    await d.click(await d.find(".compose .split-btn .main"));
    await composeClosed();
    await d.until("waiting", async () => (await invoke("counters")).followups > 0, 60000, 1000);
    // The reminder is listed by the copy in Sent, which comes a moment after sending.
    const due = await d.until("waiting row", async () => {
      const rows = await invoke("messages", { query: { followups_only: true, threads: false, limit: 50 } });
      return rows.find((m) => m.subject === subj)?.followup_due ?? 0;
    }, 30000, 500);
    // Two working days: at least two calendar days, at most four (over a weekend).
    if (due < started + 2 * 86_400 - 60 || due > started + 4 * 86_400 + 600) throw new Error(`срок ${due - started} с`);
    // The choice stays in the list of the next letter.
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    // «Настроить…» keeps the saved choices in its list.
    await remindMenu();
    await d.click(await d.find(".snooze [data-row='setup']"));
    await d.until("kept in the list", async () => !!(await d.exec("return [...document.querySelectorAll('.compose .pop [role=menuitemradio]')].some((o) => o.innerText.includes('через 2 рабочих дня'))")));
    await d.exec("document.querySelector('.compose .pop [role=menuitemradio]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await d.click(await d.find(".compose header > button:last-child"));
    await composeClosed();
    // Not waiting any more: the banner's button.
    await d.button("Ждут ответа");
    await openBySubject(subj);
    await d.button("Не ждать");
    await d.until("not waiting", async () => (await invoke("counters")).followups === 0, 20000);
    // The list of waits is read again after the button of the banner: the row is gone from «Активные».
    await d.until("row left the list", async () => !(await textOf(".list")).includes(subj), 20000);
    // The tab's count is read again with it: no «Активные 1» over an empty list.
    await d.until("count follows the list", async () => !/Активные\s*\d/.test(await textOf(".list")), 20000);
    // The toast says so and takes it back (#98): the wait returns, with its reminder.
    const stopToast = "//div[contains(concat(' ', normalize-space(@class), ' '), ' toast ')][contains(., 'Не ждём ответа')]";
    await d.until("stop toast", () => d.xpath(stopToast));
    await screenshot("followups-stop-toast", { toasts: true });
    await d.click(await d.xpath(`${stopToast}//button[contains(@class,'act')]`));
    await d.until("waiting again", async () => (await invoke("counters")).followups > 0, 20000);
    await d.until("wait banner back", async () => (await textOf(".reader")).includes("Не ждать"), 20000);
    await d.until("row is back", async () => (await textOf(".list")).includes(subj), 20000);
    await d.button("Не ждать");
    await d.until("not waiting again", async () => (await invoke("counters")).followups === 0, 20000);
    // Closed by hand: among the closed, and the banner offers to wait again.
    await d.until("closed banner", async () => (await textOf(".reader")).includes("Снова ждать ответа"), 20000);
    await d.button("Закрытые");
    await rowBySubject(subj, 20000);
    await d.button("Активные");
  });

  await step("5.11", "окно письма (#103): ящик в заголовке, «Копия» и «Скрытая» свёрнуты, Alt-клавиши, вложения одной строкой, 160 px тексту", async () => {
    const subj = `Окно письма ${stamp} — тема заведомо длиннее заголовка окна, и ей положено обрезаться многоточием`;
    await newMessage("carol@local.test", subj, "Текст письма.");
    const geometry = (css) => d.exec("const r = document.querySelector(arguments[0]).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };", css);
    const rows = () => d.exec("return [...document.querySelectorAll('.compose .fields .row .label')].map((l) => l.innerText)");
    const focusedRow = () => d.exec("return document.activeElement?.closest('.row')?.querySelector('.label')?.innerText ?? ''");

    // «From» is the label of the title, never a row; the subject is cut with «…», the label keeps its size.
    if ((await d.findAll(".compose .from-row, .compose .fields .from")).length) throw new Error("«От» осталась строкой");
    const label = await d.exec("const m = document.querySelector('.compose header .mailbox'); return m ? { title: m.title, cut: m.scrollWidth > m.clientWidth } : null");
    if (!label || !label.title.includes("@local.test")) throw new Error(`метка ящика: ${JSON.stringify(label)}`);
    if (label.cut) throw new Error("метка ящика сжата");
    const cut = await d.exec("const t = document.querySelector('.compose header .title'); return { cut: t.scrollWidth > t.clientWidth, title: t.title }");
    if (!cut.cut || cut.title !== subj) throw new Error(`тема в заголовке: ${JSON.stringify(cut)}`);

    // Cc and Bcc are links beside «To» without printed keys; the fields open on Alt+C and Alt+B and fold when empty.
    const links = await d.exec("return [...document.querySelectorAll('.compose .fields .lnk')].map((b) => b.innerText.trim())");
    if (links.join() !== "Копия,Скрытая") throw new Error(`ссылки: ${links}`);
    if ((await d.findAll(".compose .fields kbd")).length) throw new Error("у ссылок напечатаны клавиши");
    if ((await rows()).join() !== "Кому,Тема") throw new Error(`строки: ${await rows()}`);
    await altKey("c", "KeyC");
    await d.until("Cc opened", async () => (await rows()).join() === "Кому,Копия,Тема");
    if ((await focusedRow()) !== "Копия") throw new Error(`курсор в «${await focusedRow()}»`);
    await altKey("c", "KeyC", ".compose .fields .row:nth-child(2) input");
    await d.until("empty Cc folded", async () => (await rows()).join() === "Кому,Тема");
    // The caret does not leave the window: it goes to «To», and the keys of the window still work from there.
    if ((await focusedRow()) !== "Кому") throw new Error(`после сворачивания курсор в «${await focusedRow()}»`);
    await d.exec("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true }))");
    await d.until("saved from the focus", async () => (await textOf(".compose .saved")).includes("Сохранено"), 15000);
    // Alt+C from elsewhere takes the caret to an open empty «Cc» instead of folding it.
    await altKey("c", "KeyC");
    await d.until("Cc opened again", async () => (await focusedRow()) === "Копия");
    await d.exec("document.querySelector('.compose .subject').focus()");
    await altKey("c", "KeyC");
    await d.until("caret in Cc", async () => (await focusedRow()) === "Копия");
    if ((await rows()).join() !== "Кому,Копия,Тема") throw new Error("«Копия» свернулась от Alt+C из другого места");
    await altKey("c", "KeyC", ".compose .fields .row:nth-child(2) input");
    await d.until("folded from inside", async () => (await rows()).join() === "Кому,Тема");
    await altKey("b", "KeyB");
    await d.until("Bcc opened", async () => (await rows()).join() === "Кому,Скрытая,Тема");
    if ((await focusedRow()) !== "Скрытая") throw new Error(`курсор в «${await focusedRow()}»`);
    await altKey("b", "KeyB", ".compose .fields .row:nth-child(2) input");
    await d.until("empty Bcc folded", async () => (await rows()).join() === "Кому,Тема");
    await d.click(await d.find(".compose .fields .lnk"));
    await d.until("Cc by the link", async () => (await rows()).join() === "Кому,Копия,Тема");
    await d.type(await d.find(".compose .fields .row:nth-child(2) input"), "dave@local.test,");
    await altKey("c", "KeyC", ".compose .fields .row:nth-child(2) input");
    if ((await rows()).join() !== "Кому,Копия,Тема") throw new Error("поле с адресом свернулось");
    if ((await geometry(".compose .fields .row:nth-child(2)")).height > 46) throw new Error("«Копия» с одним адресом двойной высоты");

    // One mailbox only: the label tells it and offers no list (the list is checked where there are two, step 4.1).
    if ((await d.findAll(".compose header .mailbox.fixed")).length !== 1) throw new Error("у единственного ящика метка не фиксирована");

    // Eight files by a drop: one line and «+N ещё», the list on Alt+A, Delete takes a file off.
    const dir = join(profile, "att103");
    mkdirSync(dir, { recursive: true });
    const paths = Array.from({ length: 8 }, (_, i) => {
      const file = join(dir, `Договор-${i + 1}.txt`);
      writeFileSync(file, `файл ${i + 1}`);
      return file;
    });
    await d.exec("window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'files-dropped', payload: { paths: arguments[0], position: { x: 0, y: 0 } } })", paths);
    await d.until("8 files", async () => (await d.exec("return document.querySelectorAll('.compose .files .file').length + Number((document.querySelector('.compose .files .more')?.innerText.match(/\\d+/) ?? [0])[0])")) === 8);
    if ((await geometry(".compose .files")).height > 44) throw new Error("полоса вложений выше одной строки");
    const text = await d.exec("return document.querySelector('.compose textarea').getBoundingClientRect().height");
    if (text < 159) throw new Error(`тексту ${text} px`);
    await altKey("a", "KeyA");
    await d.until("list", async () => (await d.findAll(".compose [data-att]")).length === 8);
    await screenshot("compose-103-files-paper");
    await d.exec("document.querySelector('.compose [data-att]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))");
    await d.until("a file less", async () => (await d.findAll(".compose [data-att]")).length === 7);
    await d.exec("document.querySelector('.compose [data-att]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await d.until("list closed", async () => (await d.findAll(".compose [data-att]")).length === 0);

    // At full screen the strip shows every file in up to two rows with its own scroll (2.1 Б).
    await d.click((await d.findAll(".compose header .hb"))[1]);
    await d.until("full screen", async () => (await d.findAll(".compose.max .files.full")).length === 1);
    const full = await d.exec("return { chips: document.querySelectorAll('.compose .files .file').length, more: document.querySelectorAll('.compose .files .more').length, height: document.querySelector('.compose .files').getBoundingClientRect().height }");
    if (full.chips !== 7 || full.more !== 0 || full.height > 72) throw new Error(`полоса на весь экран: ${JSON.stringify(full)}`);
    await screenshot("compose-103-fullscreen-paper");
    await d.click((await d.findAll(".compose header .hb"))[1]);
    await d.until("window again", async () => (await d.findAll(".compose.max")).length === 0);

    // The format is in one place; Markdown adds «Показать разметку» and the note with a cross.
    await altKey("f", "KeyF");
    await d.until("format menu", async () => (await d.findAll(".compose footer [role=menuitemradio]")).length === 3);
    await d.click(await d.until("Markdown", () => d.xpath("//div[contains(@class,'compose')]//footer//button[@role='menuitemradio'][contains(., 'Markdown')]")));
    await d.until("Markdown letter", async () => (await d.findAll(".compose .cm-editor")).length === 1);
    if ((await d.findAll(".compose .md-note, .compose .tb.markup")).length) throw new Error("формат или разметка показаны ещё раз");
    await altKey("f", "KeyF", ".compose .cm-content");
    await d.until("markup row", async () => (await textOf(".compose footer .pop")).includes("Показать разметку"));
    if (!(await textOf(".compose footer .pop .nt")).includes("Уйдёт тремя частями")) throw new Error("нет пояснения про три части");
    await screenshot("compose-103-format-paper");
    await d.click(await d.find(".compose footer .pop .ntx"));
    await d.until("note closed for good", async () => (await invoke("settings_get")).markdown_parts_note === false);
    if ((await d.findAll(".compose footer .pop .nt")).length) throw new Error("пояснение осталось");
    await d.exec("document.querySelector('.compose footer .pop [role=menuitemradio]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    // The way back: Settings → Look and language → Hints.
    await press(",", { ctrlKey: true });
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    await d.click(await d.find(".prefs .tab[data-page='look']"));
    await d.until("look page", async () => (await textOf(".prefs .pane h2")) === "Вид и язык");
    await d.click(await d.find(".prefs [data-row='markdown_parts_note'] .sw"));
    await d.until("note back", async () => (await invoke("settings_get")).markdown_parts_note === true);
    await closeSettings();

    // The same window at night.
    const theme = (await invoke("settings_get")).theme;
    await invoke("settings_patch", { patch: { theme: "night" } });
    await d.until("night", async () => (await d.exec("return document.documentElement.dataset.theme ?? ''")) === "night");
    await screenshot("compose-103-files-night");
    await invoke("settings_patch", { patch: { theme } });

    // The last file taken off the list gives the caret back to the text.
    await altKey("a", "KeyA");
    await d.until("list again", async () => (await d.findAll(".compose [data-att]")).length > 0);
    for (let left = (await d.findAll(".compose [data-att]")).length; left > 0; left--) {
      await d.exec("document.querySelector('.compose [data-att]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))");
      await d.until("one less", async () => (await d.findAll(".compose [data-att]")).length === left - 1);
    }
    await d.until("caret in the text", async () => !!(await d.exec("return document.activeElement?.closest('.compose .body-area') !== null && document.activeElement?.closest('.compose .body-area') !== undefined")));

    // A letter typed in goes away without a draft.
    await d.click(await d.find(".compose footer button[aria-label='Удалить черновик']"));
    await d.click(await d.until("confirm", () => d.find(".modal.confirm .btn.primary").catch(() => null), 5000));
    await composeClosed();
  });

  section("settings");
  await step("7.7", "палитра команд (Ctrl+K) и шаблоны ответов", async () => {
    await press("k", { ctrlKey: true });
    await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
    await d.type(await d.find(".palette .q"), "настройки");
    await d.type(await d.find(".palette .q"), "\uE007");
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    await screenshot("settings-reading");
    await d.click(await d.find(".prefs .tab[data-page='writing']"));
    await d.until("writing page", async () => (await textOf(".prefs .pane h2")) === "Написание");
    await screenshot("settings-writing");
    // The templates are a group of the plugin on the page they belong to, marked «плагин» (#102, 2.4).
    await d.button("Добавить шаблон");
    await setInput(".prefs .tpl input", "Получил");
    await setInput(".prefs .tpl textarea", "Спасибо, получил.");
    // The plugin saves what was typed as the window closes.
    await closeSettings();
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await d.button("Шаблоны");
    await d.click(await d.until("template", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Получил')]")));
    const text = await d.exec("return document.querySelector('.compose textarea').value");
    if (!text.includes("Спасибо, получил.")) throw new Error(JSON.stringify(text));
    await d.click(await d.find(".compose header > button:last-child"));
    await composeClosed();
    await press("k", { ctrlKey: true });
    await d.type(await d.find(".palette .q"), "перейти отлож");
    await d.type(await d.find(".palette .q"), "\uE007");
    await d.until("snoozed view", async () => (await textOf(".list h2")).trim() === "Отложенные");
    await d.button("Входящие");
  });

  await step("7.9", "все настройки в одном окне: Ctrl+, ящики и плагины разделами", async () => {
    if (await d.exec("return !!document.querySelector('nav.side .foot-btn[aria-label=\"Плагины\"]')")) throw new Error("в сайдбаре остался отдельный вход в плагины");
    await press(",", { ctrlKey: true });
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    const tabs = await textOf(".prefs .pages");
    for (const want of ["Чтение и список", "Написание", "Ящики", "Все плагины"]) {
      if (!tabs.includes(want)) throw new Error(`нет раздела «${want}»: ${tabs}`);
    }
    // One entry for the mailboxes; they stand on its page, not in the menu (#102, 2.6 Б).
    if ((await d.findAll(".prefs .tab[data-page^='account:']")).length) throw new Error("ящики снова пунктами меню");
    await d.click(await d.find(".prefs .tab[data-page='accounts']"));
    await d.until("manager", async () => (await d.findAll(".prefs .accounts")).length === 1);
    if (!(await textOf(".prefs .accounts")).includes("carol@local.test")) throw new Error("на странице «Ящики» нет ящика");
    await d.click((await d.findAll(".prefs .accounts .acc > .btn.icon"))[0]);
    await d.until("mailbox page", async () => (await d.findAll(".prefs .account-page")).length === 1);
    await d.click(await d.find(".prefs .tab[data-page='plugins']"));
    await d.until("plugins page", async () => (await d.findAll(".prefs .plugins")).length === 1);
    await screenshot("settings-plugins");
    await closeSettings();
  });

  await step("7.21", "окно настроек: поиск находит настройку и открывает страницу на поле", async () => {
    await press(",", { ctrlKey: true });
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    // The settings window (#68) is wider than the letter since 0.7.1: up to 1280 px, but the
    // test window (1280 px wide) is narrower than that plus the gaps, so it fills the width.
    const box = await d.exec(
      "const r = document.querySelector('.prefs').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), inner: window.innerWidth, sym: Math.abs(r.left - (window.innerWidth - r.right)) < 1 };",
    );
    const want = Math.min(1280, box.inner - 64);
    if (box.w !== want) throw new Error(`ширина окна настроек: ${box.w}, а не ${want}`);
    if (box.top !== 32) throw new Error(`отступ сверху: ${box.top}, а не 32`);
    if (box.h !== (await d.exec("return window.innerHeight")) - 64) throw new Error(`высота окна настроек: ${box.h}`);
    if (!box.sym) throw new Error("окно настроек не по центру по ширине");
    // The search over the settings sits above the menu of pages (#68).
    if (!(await d.findAll(".prefs .psearch .q")).length) throw new Error("нет поля «Найти настройку»");
    await d.clear(await d.find(".prefs .psearch .q"));
    await d.type(await d.find(".prefs .psearch .q"), "markdown");
    injectFailure("7.21");
    await d.until("results", async () => (await d.findAll(".prefs .rlist .hit")).length > 0);
    const found = await textOf(".prefs .content.results");
    if (!found.includes("Формат новых писем")) throw new Error(`по «markdown» не нашёлся «Формат новых писем»: ${found}`);
    // A click opens the page and scrolls to the field (#68, frame 4А).
    await d.click(await d.xpath("//div[contains(@class,'prefs')]//button[contains(@class,'hit')][.//span[contains(@class,'lbl') and contains(., 'Формат новых писем')]]"));
    await d.until("writing page", async () => (await textOf(".prefs .pane h2")) === "Написание");
    // The row is in view and has the focus: found, so the value can be changed from the keyboard (#102, 4.4 А).
    await d
      .until("field in view", async () =>
        await d.exec("const el = document.querySelector('.prefs [data-settings=\"compose_format\"]'); if (!el || document.activeElement !== el) return false; const r = el.getBoundingClientRect(); const c = document.querySelector('.prefs .content').getBoundingClientRect(); return r.top >= c.top - 4 && r.top < c.bottom;"),
      )
      .catch(async (e) => {
        throw new Error(`${e.message}: ${JSON.stringify(await focusInfo())}`);
      });
    await screenshot("settings-search");
    await closeSettings();
  }, { retry: true });

  await step("7.23", "настройки: всё сохраняется сразу, «Отменить» и Ctrl+Z, неверное значение не сохраняется, тема в обеих темах", async () => {
    const saved = () => invoke("settings_get");
    const theme = () => d.exec("return document.documentElement.dataset.theme ?? ''");
    const row = (id) => `.prefs [data-row='${id}']`;
    const tile = (name) =>
      d.xpath(`//div[contains(@class,'prefs')]//div[@data-row='theme']//button[@role='radio'][normalize-space(.)='${name}']`);
    await press(",", { ctrlKey: true });
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    await d.click(await d.find(".prefs .tab[data-page='reading']"));
    await d.until("reading page", async () => (await textOf(".prefs .pane h2")) === "Чтение и список");
    // Nothing waits to be saved: no «Save» and no «Cancel» anywhere in the window.
    if ((await d.findAll(".prefs footer .btn")).length) throw new Error("в окне настроек остались кнопки «Сохранить» и «Отмена»");

    // A switch is saved the moment it is clicked; its row says so, a toast offers to take it back.
    const was = (await saved()).threads;
    await d.click(await d.find(`${row("threads")} .sw`));
    await d.until("threads saved", async () => (await saved()).threads === !was);
    await d.until("saved mark", async () => (await textOf(row("threads"))).includes("✓ Сохранено"));
    await d.until("undo toast", async () => (await textOf(".toasts")).includes("Отменить"));
    // The click left the focus on the switch; the arrows still walk the rows from there (#102, 4.1).
    await d.type(await d.find(`${row("threads")} .sw`), "\uE015");
    await d.until("arrow after a click", async () => (await d.exec("return document.activeElement?.dataset?.row")) === "list_avatars");
    // Ctrl+Z takes the last change back.
    await pressIn(".modal.prefs", "z", { ctrlKey: true });
    await d.until("threads back", async () => (await saved()).threads === was);

    // The keyboard: the menu → the page, the arrows change a value, Ctrl+Z takes it back.
    await d.click(await d.find(".prefs .tab[data-page='writing']"));
    await d.until("writing page", async () => (await textOf(".prefs .pane h2")) === "Написание");
    await d.exec("document.querySelector(\".prefs .tab[data-page='writing']\").focus()");
    await pressIn(".prefs .tab[data-page='writing']", "ArrowRight");
    await d
      .until("first row has the focus", async () => (await d.exec("return document.activeElement?.dataset?.row")) === "compose_format")
      .catch(async (e) => {
        throw new Error(`${e.message}: ${JSON.stringify(await focusInfo())}`);
      });
    const format = (await saved()).compose_format;
    await pressIn(row("compose_format"), format === "markdown" ? "ArrowLeft" : "ArrowRight");
    await d.until("format stepped", async () => (await saved()).compose_format !== format);
    await pressIn(".modal.prefs", "z", { ctrlKey: true });
    await d.until("format back", async () => (await saved()).compose_format === format);

    // A number out of its limits is lit and not saved; Esc puts the saved one back and keeps the window.
    const px = `${row("image_max_px")} input`;
    const width = (await saved()).image_max_px;
    await setInput(px, "99999");
    await d.type(await d.find(px), "\uE007");
    await d.until("field lit", async () => (await d.findAll(`${px}.bad`)).length === 1);
    if ((await saved()).image_max_px !== width) throw new Error("неверное число сохранилось");
    await d.type(await d.find(px), "\uE00C");
    await d.until("saved value back", async () => (await d.exec(`return document.querySelector("${px}").value`)) === String(width));
    if (!(await d.findAll(".prefs")).length) throw new Error("Esc в поле закрыл окно");
    // A right one is saved on Enter.
    await setInput(px, "1200");
    await d.type(await d.find(px), "\uE007");
    await d.until("number saved", async () => (await saved()).image_max_px === 1200);
    await pressIn(".modal.prefs", "z", { ctrlKey: true });
    await d.until("number back", async () => (await saved()).image_max_px === width);

    // Tab goes on inside an open row: the second threshold is reached from the keyboard (#102, 4.1).
    await d.click(await d.find(".prefs .tab[data-page='storage']"));
    await d.until("storage page", async () => (await textOf(".prefs .pane h2")) === "Хранение");
    const levels = (await saved()).quota_levels;
    const second = levels[1] === 98 ? 97 : 98;
    await pressIn(row("quota_levels"), "Enter");
    await d.until("first threshold open", async () => (await d.exec("return document.activeElement?.tagName")) === "INPUT");
    await d.type(await d.find(`${row("quota_levels")} input`), "\uE004");
    await d.until("second threshold has the focus", async () => (await d.exec("return document.activeElement === document.querySelectorAll(\"[data-row='quota_levels'] input\")[1]")) === true);
    const secondField = (await d.findAll(`${row("quota_levels")} input`))[1];
    await d.clear(secondField);
    await d.type(secondField, `${second}\uE007`);
    await d.until("second threshold saved", async () => (await saved()).quota_levels[1] === second);
    await pressIn(".modal.prefs", "z", { ctrlKey: true });
    await d.until("second threshold back", async () => (await saved()).quota_levels[1] === levels[1]);

    // The theme applies the moment its tile is clicked, and the page is photographed in both.
    await d.click(await d.find(".prefs .tab[data-page='look']"));
    await d.until("look page", async () => (await textOf(".prefs .pane h2")) === "Вид и язык");
    const was_theme = (await saved()).theme;
    await d.click(await tile("Бумага"));
    await d.until("light theme", async () => (await theme()) === "paper");
    await screenshot("settings-look-paper");
    await d.click(await tile("Ночь"));
    await d.until("dark theme", async () => (await theme()) === "night");
    await screenshot("settings-look-night");
    const back = { system: "Как в системе", paper: "Бумага", night: "Ночь", snow: "Снег", graphite: "Графит" }[was_theme];
    await d.click(await tile(back));
    await d.until("theme as it was", async () => (await saved()).theme === was_theme);

    // Closing asks nothing.
    await closeSettings();
    if ((await d.findAll(".dialog, .confirm")).length) throw new Error("закрытие окна настроек о чём-то спросило");
  });

  await step("7.24", "страница ящика: формат сохраняется сразу, без кнопки; кнопка «Проверить и сохранить» — только для подключения", async () => {
    const me = (await invoke("accounts"))[0];
    await openMailboxPage(me.id);
    await d.click(await d.find(".account-page .toc a[data-toc='letters']"));
    const was = me.compose_format ?? "";
    const pick = was === "markdown" ? "html" : "markdown";
    // The format does not reach the server: it is saved as it is picked, with the row's «Saved» and the toast.
    await setSelect(".account-page .compose-format", pick);
    await d.until("format saved", async () => ((await invoke("accounts"))[0].compose_format ?? "") === pick, 20000);
    await d.until("saved mark", async () => (await textOf(".account-page footer")).includes("Сохранено"));
    await d.until("undo toast", async () => (await textOf(".toasts")).includes("Отменить"));
    await screenshot("settings-account-autosave", { toasts: true });
    // The button waits for the connection: it is dim until a server, a port or a login changes.
    if ((await d.findAll(".account-page footer .btn.primary:not([disabled])")).length) throw new Error("кнопка подключения горит без изменений подключения");
    // The key is pressed on the control the pick left the focus on, not on the window.
    await pressIn(".account-page .compose-format .trigger", "z", { ctrlKey: true });
    await d.until("format back", async () => ((await invoke("accounts"))[0].compose_format ?? "") === was, 20000);
    // Closing asks nothing: nothing of the connection is waiting.
    await closeSettings();
    if ((await d.findAll(".dialog, .confirm")).length) throw new Error("закрытие страницы ящика о чём-то спросило");
  });

  await step("7.26", "страница ящика: название, набранное во время проверки подключения, сохраняется; уход с несохранённым подключением спрашивает", async () => {
    const me = (await invoke("accounts"))[0];
    await openMailboxPage(me.id);
    await d.click(await d.find(".account-page button.head"));
    // A server nobody answers at: the check takes a while or fails at once, the end is the same.
    const imapHost = ".account-page #account-connection fieldset:nth-of-type(1) .host input";
    await setInput(imapHost, "192.0.2.1");
    await d.until("button lit", async () => (await d.findAll(".account-page footer .btn.primary:not([disabled])")).length === 1);
    await d.click(await d.find(".account-page footer .btn.primary"));
    const name = ".account-page .grid input";
    await setInput(name, "Проверка 7.26");
    await d.type(await d.find(name), "\uE007");
    // The name waits for the check: while it is under way (the button says «Проверяем…») nothing is written.
    const checking = async () => (await textOf(".account-page footer .btn.primary")).includes("Проверяем");
    // The check takes 3 s in the test build (DEPESHA_E2E_CHECK_DELAY_MS): it must still be under way here, or the step proves nothing.
    if (!(await checking())) throw new Error("проверка подключения уже закончилась: шаг ничего не доказывает");
    const written = (await invoke("accounts"))[0].label ?? "";
    if (written === "Проверка 7.26") throw new Error("название записано во время проверки");
    if (!(await checking())) throw new Error("проверка закончилась до чтения записанного названия");
    // The check ends with its error: the connection is not saved, the name is.
    await d.until("name saved", async () => (await invoke("accounts"))[0].label === "Проверка 7.26", 90000);
    await d.until("check failed", async () => (await d.findAll(".account-page .outcome")).length === 1, 90000);
    if ((await invoke("accounts"))[0].imap.host !== me.imap.host) throw new Error("подключение сохранилось без проверки");
    // The connection is still changed and not saved: leaving asks, and «Вернуться» stays.
    await d.click(await d.find(".prefs .tab[data-page='plugins']"));
    await d.until("question", async () => (await d.findAll(".modal.confirm")).length === 1);
    await d.click(await d.xpath("//div[contains(@class,'confirm')]//button[normalize-space(.)='Вернуться']"));
    await d.until("question gone", async () => (await d.findAll(".modal.confirm")).length === 0);
    if (!(await d.findAll(".prefs .account-page")).length) throw new Error("страница ящика закрылась после «Вернуться»");
    // Back as it was, for the steps after this one.
    await d.click(await d.xpath("//div[contains(@class,'account-page')]//footer//button[normalize-space(.)='Отмена']"));
    // Enter saves the text, as it does for the user: the focus stays in the field.
    if (me.label) await setInput(name, me.label);
    else await d.exec("const i = document.querySelector('.account-page .grid input'); i.focus(); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));");
    await d.type(await d.find(name), "\uE007");
    await d.until("name back", async () => ((await invoke("accounts"))[0].label ?? "") === (me.label ?? ""), 20000);
    await closeSettings();
  });

  await step("7.27", "страница ящика: текст, набранный без ухода фокуса, не теряется при скрытии окна (#120)", async () => {
    const me = (await invoke("accounts"))[0];
    await openMailboxPage(me.id);
    const name = ".account-page .grid input";
    const typed = "Скрытие 7.27";
    // The text is typed and the focus stays in the field: neither Enter nor a click elsewhere.
    await setInput(name, typed);
    const rect = await d.rect();
    await invoke("window_hide");
    await d.until("typed text saved on hide", async () => (await invoke("accounts"))[0].label === typed, 20000);
    // The window is shown again by the driver (the page has no `show`; a focus alone does not show it): the steps after this one need it on screen, at its size.
    await d.req("POST", d.s("/window/maximize"), {});
    await d.setRect(rect.width, rect.height);
    await d.until("window back", async () => (await d.exec("return document.visibilityState")) === "visible");
    // Back as it was, for the steps after this one.
    if (me.label) await setInput(name, me.label);
    else await d.exec("const i = document.querySelector('.account-page .grid input'); i.focus(); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));");
    await d.type(await d.find(name), "\uE007");
    await d.until("name back", async () => ((await invoke("accounts"))[0].label ?? "") === (me.label ?? ""), 20000);
    await closeSettings();
  });

  await step("7.29", "картинка в тексте выделена и прокручена за край: рамка и плашка не выходят из поля текста, в обычном и «Во весь экран»; Delete и Backspace не стирают невидимую картинку", async () => {
    await d.button("Написать");
    try {
      await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
      // The mailbox's own format decides what opens: the letter is switched to HTML by the footer's menu.
      if ((await d.findAll(".compose .rich")).length === 0) {
        await d.click(await d.find(".compose footer button[aria-label='Формат письма']"));
        await d.click(await d.until("HTML", () => d.xpath("//div[contains(@class,'pop')]//*[@role='menuitemradio'][contains(., 'HTML')]")));
      }
      await d.until("rich", async () => (await d.findAll(".compose .rich")).length === 1);
      await pictureFrameInSight("normal");
      await d.click(await d.find(".compose [aria-label='Во весь экран']"));
      await d.until("maximized", async () => (await d.findAll(".compose [aria-label='Обычный размер']")).length === 1);
      await pictureFrameInSight("max");
    } finally {
      if ((await d.findAll(".compose")).length) {
        await d.click(await d.find(".compose header > button:last-child"));
        if ((await d.findAll(".confirm")).length) await d.click(await d.xpath("//div[contains(@class,'confirm')]//button[contains(@class,'primary')]"));
        await composeClosed();
      }
    }
  });

  await step("7.25", "фон без значка: согласие даётся действием строки, а не выбором", async () => {
    const before = await invoke("settings_get");
    await press(",", { ctrlKey: true });
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    await d.click(await d.find(".prefs .tab[data-page='start']"));
    await d.until("start page", async () => (await textOf(".prefs .pane h2")) === "Запуск и обновления");
    const tray = await d.until("tray known", async () => {
      const t = (await invoke("background_status")).tray;
      return t === "checking" ? null : t;
    }, 15000);
    await setSelect(".prefs [data-row='close_action']", "background");
    await d.until("background chosen", async () => (await invoke("settings_get")).close_action === "background");
    // Choosing the background agrees to nothing.
    if ((await invoke("settings_get")).background_without_tray !== before.background_without_tray) throw new Error("выбор «в фоне» молча дал согласие");
    if (tray === "absent") {
      await d.until("consent row", async () => (await d.findAll(".prefs [data-row='tray_consent']")).length === 1);
      await screenshot("settings-tray-consent");
      await pressIn(".prefs [data-row='tray_consent']", "Enter");
      await d.until("consent saved", async () => (await invoke("settings_get")).background_without_tray === true);
      await d.until("consent row gone", async () => (await d.findAll(".prefs [data-row='tray_consent']")).length === 0);
    } else if ((await d.findAll(".prefs [data-row='tray_consent']")).length) {
      throw new Error("строка согласия при значке в трее");
    }
    // As it was, for the steps after this one.
    await invoke("settings_patch", { patch: { close_action: before.close_action, background_without_tray: before.background_without_tray } });
    await closeSettings();
  });

  await step("11.1", "«Сервер»: возможности по данным входа, группы, технические подробности, «Проверить снова»", async () => {
    await openMailboxPage((await invoke("accounts"))[0].id);
    await d.click(await d.find(".account-page .toc a[data-toc='server']"));
    // What the login found is in the cache: the table shows without asking the server.
    await d.until("features", async () => (await d.findAll(".account-page tr[data-feature='idle']")).length === 1, 15000);
    const idle = await textOf(".account-page tr[data-feature='idle']");
    if (!idle.includes("IDLE") || !idle.includes("используется")) throw new Error(`IDLE: ${idle}`);
    const head = await textOf(".account-page section[data-section='server']");
    if (!head.includes("127.0.0.1:3143") || !head.includes("Определено")) throw new Error(`шапка раздела: ${head.slice(0, 300)}`);
    // GreenMail has IDLE and MOVE: nothing to look at in the contents.
    if ((await d.findAll(".account-page .toc a[data-toc='server'] .look")).length) throw new Error("точка у «Сервер» при IDLE и MOVE");
    await d.click(await d.find(".account-page details.tech summary"));
    const tech = await textOf(".account-page details.tech");
    if (!tech.includes("* CAPABILITY IMAP4rev1")) throw new Error(`технические подробности: ${tech.slice(0, 300)}`);
    if (/secret|carol:secret/i.test(tech)) throw new Error("в подробностях пароль");
    const before = (await invoke("server_info", { accountId: (await invoke("accounts"))[0].id })).caps.detected;
    await new Promise((r) => setTimeout(r, 1100));
    await d.click(await d.find(".account-page [data-action='server-check']"));
    await d.until(
      "checked again",
      async () => (await invoke("server_info", { accountId: (await invoke("accounts"))[0].id })).caps.detected > before,
      20000,
    );
    await screenshot("account-server");
    await closeSettings();
  });

  await step("11.2", "«Хранилище»: квота или «не сообщает», локальный кэш отдельно, размер папок фоном, строка в сайдбаре", async () => {
    const id = (await invoke("accounts"))[0].id;
    await openMailboxPage(id);
    await d.click(await d.find(".account-page .toc a[data-toc='storage']"));
    const storage = await textOf(".account-page section[data-section='storage']");
    if (!/Занято|Сервер не сообщает квоту/.test(storage)) throw new Error(`ни квоты, ни «не сообщает»: ${storage.slice(0, 300)}`);
    if (!storage.includes("Кэш Депеши") || !storage.includes("не входит в квоту")) throw new Error("локальный кэш не подписан как локальный");
    // Counting is a background task with its progress in the tasks window; the result stays in the cache.
    await d.click(await d.find(".account-page [data-action='sizes-count']"));
    await d.until("counted", async () => !!(await invoke("server_info", { accountId: id })).sizes, 60000);
    await d.until("table", async () => (await d.findAll(".account-page table.sizes tr")).length > 1, 10000);
    const sizes = await textOf(".account-page table.sizes");
    if (!sizes.includes("Входящие") && !sizes.includes("INBOX")) throw new Error(`нет «Входящих» в размерах: ${sizes}`);
    if (!sizes.includes("Итого")) throw new Error("нет итога");
    // An own limit makes the folder sizes an estimate to compare with: the sidebar shows it.
    await setInput(".account-page input.own", "0,001");
    // A text is saved when its field is left or Enter is pressed (#102, 1.7 Б).
    await d.type(await d.find(".account-page input.own"), "\uE007");
    await d.until("limit saved", async () => (await invoke("accounts"))[0].quota_limit_mb === 1, 20000);
    await closeSettings();
    await d.until("quota line", async () => (await d.findAll(`nav.side .quota[data-account='${id}']`)).length === 1, 10000);
    const line = await textOf(`nav.side .quota[data-account='${id}']`);
    if (!line.includes("1 МБ")) throw new Error(`строка квоты: ${line}`);
    await screenshot("sidebar-quota");
    // A click opens the mailbox's «Storage».
    await d.click(await d.find(`nav.side .quota[data-account='${id}']`));
    await d.until("storage opened", async () => (await d.findAll(".prefs .account-page section[data-section='storage']")).length === 1);
    await setInput(".account-page input.own", "");
    await d.exec("const i = document.querySelector('.account-page input.own'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur();");
    await d.until("limit cleared", async () => !(await invoke("accounts"))[0].quota_limit_mb, 20000);
    await closeSettings();
    // Messages from the toasts this left (a full mailbox) go before the next steps.
    for (const t of await d.findAll(".toast .close")) await d.click(t).catch(() => {});
  });

  await step("7.8", "язык: английский включается в настройках сразу, без перезапуска", async () => {
    const setLanguage = async (search, value) => {
      await press("k", { ctrlKey: true });
      await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
      await d.type(await d.find(".palette .q"), search);
      await d.type(await d.find(".palette .q"), "\uE007");
      await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
      await d.click(await d.find(".prefs .tab[data-page='look']"));
      // The language is a few short options, so segments (#102, 1.1 А); saved the moment one is clicked.
      await d.click(await d.xpath(`//div[contains(@class,'prefs')]//div[@data-row='language']//button[@role='radio'][normalize-space(.)='${value === "en" ? "English" : "Русский"}']`));
      await d.until("language saved", async () => (await invoke("settings_get")).language === value);
      await closeSettings();
    };
    await d.button("Входящие");
    await setLanguage("настройк", "en");
    await d.until("English sidebar", async () => (await sidebarText()).includes("Inbox"), 10000);
    if (!(await textOf(".list h2")).includes("Inbox")) throw new Error(`заголовок: ${await textOf(".list h2")}`);
    if (!(await textOf(".list .search input") || (await d.exec("return document.querySelector('.list .search input').placeholder"))).includes("Search")) {
      throw new Error("поле поиска не переведено");
    }
    await screenshot("english");
    await setLanguage("settings", "ru");
    await d.until("Russian again", async () => (await sidebarText()).includes("Входящие"), 10000);
  });

  const openModules = async () => {
    await press("k", { ctrlKey: true });
    await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
    await d.type(await d.find(".palette .q"), "плагины");
    await d.type(await d.find(".palette .q"), "\uE007");
    await d.until("plugins", async () => (await d.findAll(".prefs .plugins")).length === 1);
  };
  const closeModules = closeSettings;
  // Straight to the backend, agreeing to exactly what the manifest asks for.
  const install = (name, dir = "plugins/community") => {
    const path = join(root, dir, name);
    const m = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
    return invoke("extension_install", { path, permissions: m.permissions ?? [], hooks: m.hooks ?? [] });
  };
  const extensionsDir = join(profile, "data", "ru.depesha.mail", "extensions");
  const installFromUi = async (name) => {
    await pickFolder(join(root, "e2e/fixtures/extensions", name));
    await d.click(await d.find(".prefs .plugins .head .btn"));
  };
  const consentDialog = () => d.until("consent dialog", async () => (await d.findAll(".consent[data-consent='test.consent']")).length === 1);
  const answerConsent = async (ok) => {
    await d.click(await d.find(`.consent .buttons .btn${ok ? ".primary" : ":not(.primary)"}`));
    await d.until("consent closed", async () => (await d.findAll(".consent")).length === 0);
  };

  await step("10.1", "плагины: выключенный плагин уносит свои кнопки, клавиши и разделы", async () => {
    await d.button("Входящие");
    await openModules();
    await screenshot("plugins");
    await d.click(await d.find(".prefs .plugins input[data-plugin=snooze]"));
    await closeModules();
    await openBySubject("Счёт за октябрь");
    await d.until("no snooze button", async () => !(await textOf(".reader .toolbar")).includes("Отложить"));
    await press("h");
    await new Promise((r) => setTimeout(r, 300));
    if ((await d.findAll(".reader .pop")).length) throw new Error("клавиша h работает при выключенном плагине");
    await openModules();
    await d.click(await d.find(".prefs .plugins input[data-plugin=snooze]"));
    await closeModules();
    await d.until("snooze back", async () => (await textOf(".reader .toolbar")).includes("Отложить"));
  });

  await step("10.2", "расширения: плашка над письмом и команда для письма", async () => {
    await install("external-sender");
    await install("reading-time");
    await openBySubject("Бюджет на ноябрь");
    await openBySubject("Счёт за октябрь");
    await d.until("external banner", async () => (await textOf(".reader .ext-banner")).includes("извне"), 10000);
    await screenshot("extension-banner");
    await d.click(await d.find(".reader button[aria-label='Ещё']"));
    await d.click(await d.until("ext command", () => d.find(".reader .mi.ext-cmd")));
    await d.until("reading time toast", async () => (await textOf(".toasts")).includes("слов"), 10000);
  });

  await step("10.3", "расширение-правило раскладывает новую почту", async () => {
    await install("mail-rules");
    const subj = `Задача [в работу] ${stamp}`;
    helper("deliver", subj);
    await d.until("moved by the rule", async () => helper("count", "Работа", subj) === "1", 60000, 1000);
    if (helper("count", "INBOX", subj) !== "0") throw new Error("осталось во входящих");
    await press("k", { ctrlKey: true });
    await d.type(await d.find(".palette .q"), "правила стат");
    await d.type(await d.find(".palette .q"), "\uE007");
    await d.until("stats from storage", async () => (await textOf(".toasts")).includes("правила обработали писем: 1"), 10000);
  });

  await step("10.4", "песочница: расширение без прав не достаёт ни до приложения, ни до сети", async () => {
    await install("probe", "e2e/fixtures/extensions");
    await press("k", { ctrlKey: true });
    await d.type(await d.find(".palette .q"), "проверка песоч");
    await d.type(await d.find(".palette .q"), "\uE007");
    const result = await d.until("probe result", async () => {
      const t = await textOf(".toasts");
      return t.includes("sandbox holds") || t.includes("LEAK") ? t : null;
    }, 20000);
    if (!result.includes("sandbox holds 6/6")) throw new Error(result);
  });

  await step("10.5", "зависшее расширение не тормозит окно и снимается по таймауту", async () => {
    await install("hang", "e2e/fixtures/extensions");
    await openBySubject("Счёт за октябрь");
    const before = await textOf(".reader h1");
    const started = Date.now();
    await press("j");
    await d.until("next message while the extension loops", async () => (await textOf(".reader h1")) !== before, 5000);
    console.log(`    следующее письмо открылось через ${Date.now() - started} мс, пока расширение крутит цикл`);
    await new Promise((r) => setTimeout(r, 2500));
    await openModules();
    await d.until("timeout recorded", async () => /таймаутов: [1-9]/.test(await textOf(".prefs .plugins [data-ext='test.hang']")), 10000);
    await closeModules();
    for (const id of ["test.hang", "test.probe", "examples.mail-rules", "examples.reading-time", "examples.external-sender"]) {
      await invoke("extension_remove", { id });
    }
  });

  await step("10.6", "согласие: до установки видны автор, версия и права словами; отказ ничего не ставит", async () => {
    await openModules();
    await installFromUi("consent-v1");
    await consentDialog();
    const text = await textOf(".consent");
    for (const want of ["Consent check", "1.0.0", "Depesha tests", "Читать почту", "каждом открытом письме"]) {
      if (!text.includes(want)) throw new Error(`в окне согласия нет «${want}»: ${text}`);
    }
    if ((await d.findAll(".consent .leak")).length) throw new Error("предупреждение о выгрузке без права на сеть");
    await screenshot("extension-consent");
    await answerConsent(false);
    if ((await d.findAll(".prefs .plugins [data-ext='test.consent']")).length) throw new Error("плагин в списке после отказа");
    if (existsSync(join(extensionsDir, "test.consent"))) throw new Error("плагин на диске после отказа");
    await installFromUi("consent-v1");
    await consentDialog();
    await answerConsent(true);
    await d.until("installed and on", async () => d.exec("return document.querySelector(\".prefs .plugins [data-ext='test.consent'] input[type=checkbox]\")?.checked === true"));
  });

  await step("10.7", "согласие: обновление с новым правом спрашивает снова и выделяет новое", async () => {
    await installFromUi("consent-v2");
    await consentDialog();
    const added = await textOf(".consent li.added");
    if (!added.includes("api.example.com")) throw new Error(`новое право не выделено: ${added}`);
    if (!(await textOf(".consent .leak")).includes("api.example.com")) throw new Error("нет предупреждения о выгрузке писем");
    await screenshot("extension-consent-update");
    await answerConsent(false);
    if (!(await textOf(".prefs .plugins [data-ext='test.consent']")).includes("1.0.0")) throw new Error("после отказа сменилась версия");
    // The backend holds to consent too: a set other than the manifest's is refused.
    const refused = await invoke("extension_install", {
      path: join(root, "e2e/fixtures/extensions/consent-v2"),
      permissions: ["messages.read"],
      hooks: ["messageOpen"],
    }).then(() => null, (e) => e.message);
    if (!refused) throw new Error("установка в обход согласия прошла");
    // The same rights again: no dialog, only a note.
    await installFromUi("consent-v1");
    await d.until("updated without asking", async () => (await textOf(".toasts")).includes("Обновлено"), 10000);
    if ((await d.findAll(".consent")).length) throw new Error("согласие спрошено без новых прав");
  });

  await step("10.8", "плагин с локальным адресом в network: не запускается, причина видна", async () => {
    cpSync(join(root, "e2e/fixtures/extensions/local"), join(extensionsDir, "test.local"), { recursive: true });
    // Removing one plugin reloads the list.
    await invoke("extension_remove", { id: "test.consent" });
    const row = await d.until("refused plugin shown", async () => {
      const t = await textOf(".prefs .plugins [data-ext='test.local'] [data-problem]");
      return t.includes("127.0.0.1") ? t : null;
    }, 10000);
    console.log(`    ${row}`);
    if (await d.exec("return document.querySelector(\".prefs .plugins [data-ext='test.local'] input[type=checkbox]\").checked")) {
      throw new Error("плагин с локальным адресом включён");
    }
    if ((await d.findAll("iframe[src*='test.local']")).length) throw new Error("плагин с локальным адресом запущен");
    await invoke("extension_remove", { id: "test.local" });
    await closeModules();
  });

  section("second");
  await step("1.4, 2.2", "второй ящик по TLS: недоверенный сертификат принимается по отпечатку в мастере", async () => {
    // With one account, adding another lives in its menu.
    await d.click(await d.find(".menu-btn"));
    await d.button("Добавить ящик");
    await d.until("wizard", async () => (await d.findAll(".wizard")).length === 1);
    await setInput(".wizard input[placeholder='Иван Петров']", "Боб");
    await setInput(".wizard input[type=email]", "bob@local.test");
    await setInput(".wizard input[type=password]", "secret");
    await d.button("Далее");
    await d.until("settings step", async () => (await d.bodyText()).includes("Входящая почта (IMAP)"), 30000);
    await setInput(".wizard input[placeholder^='адрес или']", "bob");
    await setSelect(".wizard fieldset:nth-of-type(1) .select", "tls");
    await setSelect(".wizard fieldset:nth-of-type(2) .select", "tls");
    const hosts = await d.findAll(".wizard fieldset .host input");
    const ports = await d.findAll(".wizard fieldset .port input");
    for (const [i, port] of [3993, 3465].entries()) {
      await d.clear(hosts[i]);
      await d.type(hosts[i], "localhost");
      await d.clear(ports[i]);
      await d.type(ports[i], String(port));
    }
    await d.button("Проверить и сохранить");
    await d.until("IMAP certificate question", async () => (await d.bodyText()).includes("SHA-256"), 20000);
    await screenshot("wizard-certificate");
    await d.button("Доверять этому сертификату");
    // The same self-signed certificate is then met on SMTPS.
    await d.until("SMTP certificate or done", async () => {
      if ((await d.findAll(".wizard")).length === 0) return true;
      return (await textOf(".wizard .error")).startsWith("SMTP") ? "smtp" : null;
    }, 20000).then(async (r) => {
      if (r === "smtp") await d.button("Доверять этому сертификату");
    });
    await d.until("wizard closed", async () => (await d.findAll(".wizard")).length === 0, 20000);
    await closeSettings();
    await d.until("second account in sidebar", async () => (await sidebarText()).includes("bob@local.test"), 20000);
  });

  await step("4.1", "общий входящий собирает письма обоих ящиков", async () => {
    const bobSubject = `Для Боба ${stamp}`;
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await d.type((await d.findAll(".compose .box input"))[0], "bob@local.test");
    await setInput(".compose .subject", bobSubject);
    await d.type(await d.find(".compose textarea"), "Проверка общего входящего");
    await d.button("Отправить");
    await d.button("Все входящие");
    await rowBySubject(bobSubject, 60000);
    await rowBySubject("Счёт за октябрь", 5000);
    await screenshot("unified-two-accounts");
  });

  await step("7.22", "зажатый e: серия архивирований не морозит другой ящик", async () => {
    // Both mailboxes are up here (bob goes away only at 8.2). A series to triage in Carol's
    // inbox, then a held "e": a press every ~35 ms, as the keyboard's auto-repeat does.
    const carol = (await invoke("accounts")).find((a) => a.email === "carol@local.test");
    helper("many", "INBOX", "60");
    await invoke("sync_now", { accountId: carol.id });
    // The mailbox's own inbox, by the account's name (not the first "Входящие" in the tree).
    const openInbox = async (email) => {
      await d.exec(
        `const name = [...document.querySelectorAll('nav.side .account-name')].find((n) => n.title === arguments[0]);
         const group = name.closest('.group');
         if (group.classList.contains('collapsed')) name.click();
         const row = [...group.querySelectorAll('.item')].find((x) => (x.querySelector('.name') ?? x).innerText.trim() === 'Входящие');
         row.click();`,
        email,
      );
    };
    await openInbox("carol@local.test");
    // The list draws only the rows in view; the cache is what says how many arrived.
    await d.until("carol inbox filled", async () => {
      const rows = await invoke("messages", { query: { account_id: carol.id, folder: "INBOX", limit: 200 } });
      return rows.length >= 50;
    }, 60000).catch(async (e) => {
      const all = await invoke("messages", { query: { account_id: carol.id, folder: "INBOX", limit: 2000 } });
      throw new Error(`${e.message} (в кэше входящих ${all.length}, на сервере ${helper("count", "INBOX", "Массовое письмо")})`);
    });
    await d.until("a row to select", async () => (await d.exec("return document.querySelectorAll('.list .row').length")) > 0, 15000);
    await d.click(await d.find(".list .row"));
    const inboxQuery = { account_id: carol.id, folder: "INBOX", limit: 200 };
    const beforeIds = (await invoke("messages", { query: inboxQuery })).map((m) => m.id);
    // Held e, as the keyboard repeats it: do not wait for the next letter to open.
    // Waiting for each open made 50 presses take ~46 s.
    const burst = Date.now();
    for (let i = 0; i < 50; i++) {
      await press("e");
      await new Promise((r) => setTimeout(r, 35));
    }
    const burstMs = Date.now() - burst;
    console.log(`    серия e: ${burstMs} мс на 50 нажатий`);
    if (burstMs > 8000) throw new Error(`серия e заняла ${burstMs} мс, интерфейс ждал открытия`);
    // Ids, not the length of a capped page: archiving the top still returns 200 rows.
    let archived = 0;
    await d.until("50 letters archived", async () => {
      const now = new Set((await invoke("messages", { query: inboxQuery })).map((m) => m.id));
      archived = beforeIds.filter((id) => !now.has(id)).length;
      return archived >= 50;
    }, 20000);
    console.log(`    заархивировано ${archived}`);
    // The interface did not freeze: the list still answers after the burst.
    await d.until("the list answers after the burst", async () =>
      (await d.exec("return document.querySelectorAll('.list .row').length")) > 0, 5000);
    await screenshot("move-burst");
    // And the letters really went to the archive, not only out of sight.
    await d.until("letters in the archive", () => helper("count", "Архив", "Разбор") !== "0", 30000);
    // The time the user feels: opening a letter in the other mailbox right after.
    await openInbox("bob@local.test");
    const row = await rowBySubject(`Для Боба ${stamp}`, 60000);
    const t = Date.now();
    await d.click(row);
    await d.until("body of the other mailbox", async () => (await textOf(".reader .body")).trim().length > 0, 10000);
    const open = Date.now() - t;
    console.log(`    серия e: ${Date.now() - burst} мс; открытие письма в другом ящике: ${open} мс`);
    // The seeded series is not part of the scenario: take it out again, and back to the
    // unified inbox, so the steps after see the state they expect.
    helper("delete", "INBOX", "Разбор");
    helper("delete", "Архив", "Разбор");
    await d.button("Все входящие");
    if (open > 2000) throw new Error(`открытие письма в другом ящике заняло ${open} мс`);
  });

  await step("4.1", "«Все черновики»: черновики обоих ящиков, каждый открывается от своего отправителя", async () => {
    const subj = `Черновик Боба ${stamp}`;
    const accounts = await invoke("accounts");
    const bob = accounts.find((a) => a.email === "bob@local.test");
    // The draft of step 5.5 is written by another part when the sections run apart: write it here if the server has none.
    if (helper("count", "Drafts", `Черновик ${stamp}`) !== "1") {
      await d.button("Написать");
      await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
      await setInput(".compose .subject", `Черновик ${stamp}`);
      await d.type(await d.find(".compose textarea"), "Недописанное письмо");
      await d.click(await d.find(".compose header > button:last-child"));
      await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0, 15000);
      await d.until("draft on server", async () => helper("count", "Drafts", `Черновик ${stamp}`) === "1", 15000);
    }
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    // Alt+M opens the mailboxes of the title; Esc closes it; a click on the label opens it again and one is chosen.
    await altKey("m", "KeyM");
    await d.until("mailboxes", async () => (await d.findAll(".compose header [role=menuitemradio]")).length === accounts.length);
    // The list opens on the mailbox the letter is from; the arrows and Enter choose another.
    const current = () => d.exec("return { checked: document.activeElement?.getAttribute('aria-checked'), value: document.activeElement?.dataset?.value }");
    const here = await current();
    if (here.checked !== "true") throw new Error(`в списке ящиков курсор не на текущем: ${JSON.stringify(here)}`);
    await screenshot("compose-103-mailbox-paper");
    await d.pressKey("\uE015");
    await d.until("on the other one", async () => (await current()).value !== here.value);
    await d.pressKey("\uE007");
    await d.until("mailboxes closed", async () => (await d.findAll(".compose header [role=menuitemradio]")).length === 0);
    if (!(await d.exec("return document.querySelector('.compose header .mailbox')?.title ?? ''")).includes("bob@local.test")) throw new Error("ящик не сменился на Боба");
    // The plugin of the mailbox colour tints the title bar with the mailbox's colour; without it the bar is as it was (#103, 1.1 Б).
    const bar = () => d.exec("const h = document.querySelector('.compose header'); return { tint: h.style.getPropertyValue('--row-tint'), bg: getComputedStyle(h).backgroundColor }");
    const plain = await bar();
    if (plain.tint) throw new Error(`заголовок окрашен без плагина: ${plain.tint}`);
    const settings = await invoke("settings_get");
    await invoke("settings_patch", { patch: { enabled_plugins: [...(settings.enabled_plugins ?? []), "account-color"] } });
    const tinted = await d.until("title tinted", async () => {
      const b = await bar();
      return b.tint ? b : null;
    }, 10000);
    if (tinted.bg === plain.bg) throw new Error("заголовок не изменил цвет");
    await screenshot("compose-103-tint-paper");
    await invoke("settings_patch", { patch: { theme: "night" } });
    await d.until("night", async () => (await d.exec("return document.documentElement.dataset.theme ?? ''")) === "night");
    await screenshot("compose-103-tint-night");
    await invoke("settings_patch", { patch: { theme: settings.theme, enabled_plugins: settings.enabled_plugins ?? [] } });
    await d.until("bar as it was", async () => !(await bar()).tint);
    await setInput(".compose .subject", subj);
    await d.click(await d.find(".compose header > button:last-child"));
    await composeClosed();
    await d.button("Все черновики");
    // Carol's drafts from the steps before, and Bob's new one.
    await rowBySubject(`Черновик ${stamp}`, 20000);
    await rowBySubject(subj, 20000);
    await openBySubject(subj);
    await d.button("Продолжить");
    await d.until("draft opened", async () => (await d.findAll(".compose")).length === 1);
    const from = await d.exec("return document.querySelector('.compose header .mailbox')?.title ?? ''");
    if (!from.includes("bob@local.test")) throw new Error(`отправитель: ${from}`);
    await d.click(await d.find(".compose header > button:last-child"));
    await composeClosed();
    if (helper("count", "Drafts", subj) !== "0") throw new Error("черновик Боба попал в ящик Кэрол");
  });

  await step("4.2", "менеджер ящиков: порядок, название и цвет; свёрнутый ящик без лишнего отступа", async () => {
    const names = () => d.exec("return [...document.querySelectorAll('nav.side .account-name .name')].map(n => n.innerText.trim())");
    const before = await names();
    await d.exec("document.querySelector('nav.side .account .menu-btn').click()");
    await d.click(await d.until("manage item", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Ящики…')]")));
    await d.until("manager", async () => (await d.findAll(".prefs .accounts")).length === 1);
    await d.click((await d.findAll(".prefs .accounts .order .btn"))[1]);
    await d.until("order changed", async () => (await names())[0] === before[1]);
    // The colour of the mailbox now first, on its own page, and its name.
    await d.click((await d.findAll(".prefs .accounts .acc > .btn.icon"))[0]);
    await d.until("mailbox page", async () => (await d.findAll(".prefs .account-page")).length === 1);
    await d.click(await d.find(".account-page .colors label[title='#d0658f']"));
    // The colour is no part of the connection: saved as it is picked, no button (#102, 1.7 Б).
    await d.until("dot coloured", async () =>
      (await d.exec("return getComputedStyle(document.querySelector('nav.side .account .dot')).backgroundColor")) === "rgb(208, 101, 143)", 20000);
    await d.click(await d.find(".prefs .tab[data-page='accounts']"));
    await d.until("back to the manager", async () => (await d.findAll(".prefs .accounts")).length === 1, 20000);
    if ((await d.findAll(".dialog, .confirm")).length) throw new Error("уход со страницы ящика о чём-то спросил");
    const input = (await d.findAll(".prefs .accounts .name"))[0];
    const label = await d.exec("return document.querySelector('.prefs .accounts .name').value");
    await d.clear(input);
    await d.type(input, "Тестовый\uE007");
    await d.until("renamed", async () => (await names())[0] === "Тестовый");
    await screenshot("accounts");
    // Back as it was, for the steps after this one.
    await d.exec(
      "const i = document.querySelector('.prefs .accounts .name'); i.focus(); i.value = arguments[0]; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur();",
      label,
    );
    await d.until("name back", async () => (await names())[0] === before[1]);
    await d.click((await d.findAll(".prefs .accounts .order .btn"))[2]);
    await d.until("order back", async () => JSON.stringify(await names()) === JSON.stringify(before));
    await closeSettings();
    // Folded: the next mailbox's name follows right under it.
    await d.exec("document.querySelector('nav.side .account-name').click()");
    const gap = await d.exec(`const g = document.querySelectorAll('nav.side .group');
      const a = g[g.length - 2].querySelector('.account').getBoundingClientRect(), b = g[g.length - 1].querySelector('.account').getBoundingClientRect();
      return Math.round(b.top - a.bottom);`);
    await d.exec("document.querySelector('nav.side .account-name').click()");
    if (gap > 8) throw new Error(`отступ под свёрнутым ящиком ${gap}px`);
  });

  await step("7.10", "узкое окно: сайдбар в полосу, папки ящика сбоку, список и письмо по очереди", async () => {
    const rect = await d.rect();
    const shown = (css) => d.exec("const e = document.querySelector(arguments[0]); return !!e && getComputedStyle(e).visibility === 'visible'", css);
    try {
      await openFolder("Входящие");
      await d.setRect(960, rect.height);
      await d.until("strip", async () => (await d.findAll("nav.side.strip")).length === 1);
      // A mailbox's folders open beside the strip by a click and close with the choice.
      await d.click((await d.findAll("nav.side .circle"))[0]);
      const inbox = await d.until("flyout", () =>
        d.xpath("//div[contains(@class,'pop')]//button[contains(@class,'item')][.//span[contains(@class,'name') and normalize-space(.)='Входящие']]"),
      );
      await d.click(inbox);
      await d.until("flyout closed", async () => (await d.findAll(".pop")).length === 0);
      await screenshot("narrow-strip");

      await d.setRect(640, rect.height);
      await d.until("one column", async () => (await d.findAll(".layout.single")).length === 1);
      await openBySubject("Счёт за октябрь");
      if (await shown(".list")) throw new Error("список виден рядом с письмом");
      const first = await textOf(".reader h1");
      await press("j");
      await d.until("next letter, still the letter", async () => (await textOf(".reader h1")) !== first && !(await shown(".list")));
      await screenshot("narrow-letter");
      await press("Escape");
      await d.until("back to the list", async () => (await shown(".list")) && !(await shown(".reader")));
      if ((await d.findAll(".row.cursor")).length !== 1) throw new Error("открытое письмо потеряло отметку при возврате к списку");
      await press("Enter");
      await d.until("the letter again", async () => await shown(".reader"));
      await d.click(await d.find(".reader .back"));
      await d.until("back by the button", async () => await shown(".list"));
    } finally {
      await d.setRect(rect.width, rect.height);
      await d.until("full sidebar again", async () => (await d.findAll("nav.side.strip")).length === 0).catch(() => {});
    }
  });

  await step("3.9", "не больше 3 IMAP-соединений на ящик", async () => {
    // Only connections to the published ports: docker-proxy's own leg to the container also has dport 3143.
    const out = execFileSync("ss", ["-tnH", "state", "established", "( dport = :3143 or dport = :3993 )"], { encoding: "utf-8" });
    const peers = out.split("\n").map((l) => l.trim().split(/\s+/).pop() ?? "");
    const plain = peers.filter((p) => p === "127.0.0.1:3143").length;
    const tls = peers.filter((p) => p === "127.0.0.1:3993" || p === "[::1]:3993").length;
    if (plain > 3 || tls > 3) throw new Error(`соединений: carol ${plain}, bob ${tls}\n${out}`);
    console.log(`    соединений: carol ${plain}, bob ${tls}`);
  });

  const offlineSubject = `Без сети ${stamp}`;
  await step("4.7, 5.5", "без сети: открытые письма читаются, отправка ждёт в «Исходящих»", async () => {
    execFileSync("docker", ["compose", "-f", join(root, "compose.test.yaml"), "stop"], { stdio: "ignore" });
    await d.button("Все входящие");
    await openBySubject("Счёт за октябрь");
    if (!(await textOf(".reader")).includes("Оплатить до пятницы")) throw new Error("кэш письма недоступен");
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await d.type((await d.findAll(".compose .box input"))[0], "carol@local.test");
    await setInput(".compose .subject", offlineSubject);
    await d.type(await d.find(".compose textarea"), "Отправлено, когда сеть вернулась");
    await d.button("Отправить");
    await d.until("outbox in sidebar", async () => (await sidebarText()).includes("Исходящие"), 20000);
    await d.button("Исходящие");
    await d.until("outbox item", async () => (await textOf(".outbox")).includes(offlineSubject), 10000);
    await screenshot("outbox-offline");
  });

  await step("3.6, 3.8, 5.4", "сервер вернулся: переподключение, новый UIDVALIDITY, письмо ушло само", async () => {
    // GreenMail keeps mail in memory: after restart the mailbox is new (UIDVALIDITY changes).
    execFileSync("docker", ["compose", "-f", join(root, "compose.test.yaml"), "up", "-d", "--force-recreate"], { stdio: "ignore" });
    await d.until("greenmail up", async () => {
      try {
        helper("count", "INBOX", "x");
        return true;
      } catch {
        return false;
      }
    }, 30000);
    await d.until("outbox drained", async () => (await sidebarText()).includes("Исходящие") === false, 120000, 1000);
    await d.button("Все входящие");
    await rowBySubject(offlineSubject, 90000);
    // Old cached rows of the reset mailbox must be gone.
    await d.until("stale cache dropped", async () => !(await textOf(".list")).includes("Массовое письмо"), 30000);
  });

  await step("3.10", "неверный пароль не долбит сервер: ящик встаёт на паузу", async () => {
    const invoke = (cmd, args) =>
      d.req("POST", d.s("/execute/async"), {
        script: `const done = arguments[arguments.length - 1];
          window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(r => done({ ok: r }), e => done({ err: e }));`,
        args: [cmd, args],
      });
    const accs = (await invoke("accounts", {})).ok;
    const carol = accs.find((a) => a.email === "carol@local.test");
    const { status: _s, ...account } = carol;
    const logDir = join(profile, "data/ru.depesha.mail/logs");
    const attempts = () => {
      try {
        return Number(execFileSync("sh", ["-c", `cat ${logDir}/* | grep -c 'отклонил вход' || true`], { encoding: "utf-8" }).trim());
      } catch {
        return 0;
      }
    };
    const before = attempts();
    await invoke("account_save", { account, password: "wrong-password" });
    await d.until("paused", async () => (await sidebarText()).includes("Исправить"), 20000);
    await new Promise((r) => setTimeout(r, 20000));
    const tries = attempts() - before;
    console.log(`    неудачных входов за ~20 с: ${tries}`);
    if (tries > 3) throw new Error(`слишком много попыток входа: ${tries}`);
    await screenshot("paused-account");
    await invoke("account_save", { account, password: "secret" });
    await d.until("online again", async () => !(await sidebarText()).includes("Исправить"), 20000);
  });

  await step("1.4, 8.2", "удаление ящика стирает кэш и пароль; пароля нет ни в файлах, ни в логах", async () => {
    const accounts = await d.exec("return window.__TAURI_INTERNALS__.invoke('accounts')").catch(() => null);
    const list = accounts ?? JSON.parse(readFileSync(join(profile, "config/ru.depesha.mail/accounts.json"), "utf-8")).accounts;
    const bob = list.find((a) => a.email === "bob@local.test");
    await d.req("POST", d.s("/execute/async"), {
      script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('account_remove', { id: arguments[0] }).then(() => done(true), (e) => done(String(e?.message ?? e)));",
      args: [bob.id],
    });
    let left = "";
    try {
      left = execFileSync("secret-tool", ["lookup", "service", "ru.depesha.mail", "username", bob.id], { encoding: "utf-8" });
    } catch {}
    if (left) throw new Error("пароль остался в связке ключей");
    let found = "";
    try {
      found = execFileSync("grep", ["-rlaF", "--", "secret", profile], { encoding: "utf-8" });
    } catch {}
    if (found.trim()) throw new Error(`пароль найден в файлах: ${found}`);
    const logs = execFileSync("sh", ["-c", `ls ${join(profile, "data/ru.depesha.mail/logs")} 2>/dev/null || find ${profile} -name '*.log'`], { encoding: "utf-8" });
    console.log(`    логи: ${logs.trim().split("\n").length} файл(ов), пароля в них нет`);
  });

  await step("12.5", "общие папки Dovecot с ACL: группа «Общие», «Только чтение», неактивное удаление и свойства папки из меню (#42)", async () => {
    // The Dovecot stand (compose.test.yaml) carries the ACL plugin and the read-only
    // «shared/ReadOnly» folder the seed makes. Dovecot refuses cleartext, so the account
    // goes over STARTTLS with its self-signed certificate; SMTP is GreenMail's plain port.
    await d.click(await d.find(".menu-btn"));
    await d.button("Добавить ящик");
    await d.until("wizard", async () => (await d.findAll(".wizard")).length === 1);
    await setInput(".wizard input[placeholder='Иван Петров']", "Общий");
    await setInput(".wizard input[type=email]", "shared@local.test");
    await setInput(".wizard input[type=password]", "secret");
    await d.button("Далее");
    await d.until("settings step", async () => (await d.bodyText()).includes("Входящая почта (IMAP)"), 30000);
    // Login «carol»: Dovecot takes any user name, while GreenMail's SMTP wants one of its own.
    await setInput(".wizard input[placeholder^='адрес или']", "carol");
    await setSelect(".wizard fieldset:nth-of-type(1) .select", "starttls");
    await setSelect(".wizard fieldset:nth-of-type(2) .select", "plain");
    const hosts = await d.findAll(".wizard fieldset .host input");
    const ports = await d.findAll(".wizard fieldset .port input");
    for (const [i, [host, port]] of [["127.0.0.1", 31143], ["127.0.0.1", 3025]].entries()) {
      await d.clear(hosts[i]);
      await d.type(hosts[i], host);
      await d.clear(ports[i]);
      await d.type(ports[i], String(port));
    }
    await d.button("Проверить и сохранить");
    await d.until("IMAP certificate question", async () => (await d.bodyText()).includes("SHA-256"), 20000);
    await d.button("Доверять этому сертификату");
    await d.until("wizard closed", async () => (await d.findAll(".wizard")).length === 0, 30000);
    await closeSettings();

    // The public folder stands in the account's tree right away; opening it reads its
    // properties — MYRIGHTS and the server's namespaces — from the Dovecot stand.
    const readOnlyItem = () =>
      d.exec(`const b = [...document.querySelectorAll('nav.side .item')].find((x) => (x.querySelector('.name') ?? x).innerText.trim() === 'ReadOnly'); return b ? true : null;`).catch(() => null);
    await d.until("shared ReadOnly folder", readOnlyItem, 40000);
    await d.exec(`[...document.querySelectorAll('nav.side .item')].find((x) => (x.querySelector('.name') ?? x).innerText.trim() === 'ReadOnly').click();`);
    // The header of the list says the folder is read-only (frame 7А).
    await d.until("read-only header", async () => (await textOf(".list")).includes("только чтение"), 20000);
    await rowBySubject("Реестр платежей на неделю", 30000);
    // A letter's menu turns its delete off with a hint: the folder grants read only.
    await d.exec(
      `const row = [...document.querySelectorAll('.row')].find((r) => r.innerText.includes('Реестр платежей'));
       const r = row.getBoundingClientRect();
       row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 }));`,
    );
    await d.until("row menu", async () => (await textOf(".pop")).includes("Удалить"), 10000);
    const del = await d.exec(
      `const b = [...document.querySelectorAll('.pop .mi')].find((x) => x.innerText.includes('Удалить'));
       return { disabled: b.disabled, title: b.title };`,
    );
    if (!del.disabled) throw new Error("удаление в папке только для чтения активно");
    if (!del.title) throw new Error("у удаления нет подсказки");
    await press("Escape");
    await d.until("menu closed", async () => (await d.findAll(".pop")).length === 0);
    await screenshot("shared-readonly");

    // The folder's card opens from the folder's own menu and says «только чтение».
    await d.exec(
      `const item = [...document.querySelectorAll('nav.side .item')].find((x) => (x.querySelector('.name') ?? x).innerText.trim() === 'ReadOnly');
       const r = item.getBoundingClientRect();
       item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 10 }));`,
    );
    await d.until("folder menu", async () => (await textOf(".pop")).includes("Свойства папки"), 10000);
    await d.click(await d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Свойства папки')]"));
    await d.until("folder props card", async () => {
      const t = await textOf(".fcard");
      return t.includes("только чтение");
    }, 15000);
    await screenshot("shared-folder-props");
    await d.click(await d.find(".fcard .x"));
    await d.until("card closed", async () => (await d.findAll(".fcard")).length === 0);

    // Opening the mailbox page hands the sidebar the namespaces (#42): the folder leaves the
    // account's own tree and moves under the «Общие» heading.
    const sharedId = (await invoke("accounts")).find((a) => a.email === "shared@local.test").id;
    await openMailboxPage(sharedId);
    await closeSettings();
    await d.until("shared group", async () => (await sidebarText()).includes("Общие"), 30000);
    await d.until("folder in the shared group", async () =>
      d.exec(`const h = [...document.querySelectorAll('nav.side .subhead')].find((x) => x.innerText.includes('Общие')); if (!h) return null; let n = h.nextElementSibling; while (n && !n.classList.contains('subhead')) { if ((n.querySelector('.name') ?? n).innerText.trim() === 'ReadOnly') return true; n = n.nextElementSibling; } return null;`).catch(() => null), 15000);
    // The namespace root `shared` is the container of the group, not a folder of the
    // mailbox: no empty `shared` row stays in the account's own tree (#42, кадр 6Б).
    await d.until("no empty shared root", async () =>
      d.exec(`return document.querySelector('nav.side .folder-row[data-folder="shared"]') ? null : true;`).catch(() => null), 15000);
    await screenshot("shared-group");
  });

  await step("12.6", "метки: «Метки…» из меню строки на письме без меток — пустое состояние, создать, ярлык в строке, снять (#42, кадр 10)", async () => {
    // Step 3.6/3.8/5.4 recreated GreenMail and left it empty: put the acceptance seed back,
    // so the letters this step and the one after it work on are there.
    helper("seed");
    await d.button("Входящие");
    const subj = "Счёт за октябрь";
    await rowBySubject(subj, 30000);
    const labelName = `Метка ${stamp}`;

    // Right-click the row and open «Метки» through the menu, not invoke.
    await d.exec(
      `const row = [...document.querySelectorAll('.row')].find((r) => r.innerText.includes(arguments[0]));
       const b = row.getBoundingClientRect();
       row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 40, clientY: b.top + 20 }));`,
      subj,
    );
    await d.until("row menu", async () => (await textOf(".pop")).includes("Метки"), 10000);
    await d.click(await d.xpath("//div[contains(@class,'pop')]//button[contains(@class,'mi') and normalize-space(.)='Метки']"));
    // No labels yet, and the picker still opens: the empty state and the create form.
    await d.until("labels picker empty", async () => (await textOf(".pop")).includes("Меток пока нет"), 10000);
    await d.until("create form", async () => (await d.findAll(".pop input[placeholder='Новая метка…']")).length === 1, 10000);
    await screenshot("labels-empty");

    // Create the first label right here; it goes on the letter at once.
    await d.type(await d.find(".pop input[placeholder='Новая метка…']"), labelName);
    await d.click(await d.xpath("//div[contains(@class,'pop')]//button[contains(@class,'primary') and normalize-space(.)='Создать']"));
    await d.until("label chip in the row", async () => (await textOf(".list")).includes(labelName), 20000);
    await screenshot("labels-chip");

    // The same picker now lists it as checked; take it off.
    await d.click(await d.xpath(`//div[contains(@class,'pop')]//button[contains(@class,'mi') and contains(normalize-space(.), ${JSON.stringify(labelName)})]`));
    await d.until("label chip gone", async () => !(await textOf(".list")).includes(labelName), 20000);
    await screenshot("labels-removed");
    await press("Escape");
    await d.until("picker closed", async () => (await d.findAll(".pop")).length === 0);
  });

  await step("12.7", "метки: раздел «Метки» — переименовать в строке, найти через «метка:», удалить со всех писем (#42, кадры 1А–4Б)", async () => {
    const accounts = await invoke("accounts");
    const rows = await invoke("messages", { query: { role: "inbox", limit: 2000 } });
    const letter = rows.find((m) => m.subject.includes("Счёт за октябрь")) ?? rows[0];
    const subj = letter?.subject ?? "";
    const acc = accounts.find((a) => a.id === letter?.account_id) ?? accounts[0];
    // No spaces and no colons in the name: the operator's value is one token then.
    const tag = stamp.replace(/:/g, "");
    const labelName = `Раздел${tag}`;
    const renamed = `Правка${tag}`;

    // The mailbox's page at «Labels»: the sidebar's account menu opens it.
    const openLabels = async () => {
      await d.exec(
        `const email = arguments[0];
         const groups = [...document.querySelectorAll('nav.side .group')];
         const g = groups.find((x) => x.querySelector('.account-name')?.getAttribute('title') === email) ?? groups[1] ?? groups[0];
         g.querySelector('.menu-btn').click();`,
        acc.email,
      );
      await d.click(await d.until("account menu", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Настройки…')]").catch(() => null)));
      await d.until("account page", async () => (await d.findAll(".prefs .account-page")).length === 1);
      await d.click(await d.xpath("//div[contains(@class,'account-page')]//nav//a[normalize-space(.)='Метки']"));
    };

    // A label with one letter on it.
    await invoke("label_save", { accountId: acc.id, name: labelName, color: "#3f9fd0" });
    if (letter) await invoke("set_label", { ids: [letter.id], name: labelName, value: true });
    await openLabels();
    const rowLink = (name) =>
      d.xpath(`//section[@data-section='labels']//button[contains(@class,'link') and normalize-space(.)=${JSON.stringify(name)}]`).catch(() => null);
    await d.until("label row", () => rowLink(labelName));
    await screenshot("labels-manage");

    // Quiet rename: the name is edited in the row, the keyword on the server is untouched.
    // Set through the DOM: a WebDriver element handle would go stale as the row redraws.
    await d.click(await rowLink(labelName));
    await d.until("rename input", async () => (await d.findAll("section[data-section='labels'] input[aria-label='Переименовать']")).length === 1);
    await d.exec(
      `const i = document.querySelector("section[data-section='labels'] input[aria-label='Переименовать']");
       i.focus(); i.value = arguments[0]; i.dispatchEvent(new Event('input', { bubbles: true }));
       i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`,
      renamed,
    );
    await d.until("renamed in the row", () => rowLink(renamed));
    await screenshot("labels-renamed");
    await closeSettings();

    // The letter still carries the label: the keyword did not change with the name.
    if (letter) {
      const box = await d.find(".list .search input");
      await d.clear(box);
      await d.type(box, `метка:${renamed}\uE007`);
      await rowBySubject(subj, 20000);
      await screenshot("labels-search");
      await d.clear(box);
      await press("Escape");
    }

    // Deleting: a confirmation with the letter count, then the keyword is stripped in the background.
    await openLabels();
    await d.until("label row again", () => rowLink(renamed));
    await d.click(
      await d.xpath(
        `//section[@data-section='labels']//tr[.//button[normalize-space(.)=${JSON.stringify(renamed)}]]//button[@aria-label='Действия']`,
      ),
    );
    await d.until("label menu", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Удалить метку')]").catch(() => null));
    // Clicked through the DOM: the popover closes on its own pointer handling.
    await d.exec(`const b = [...document.querySelectorAll('.pop .mi')].find((x) => x.innerText.includes('Удалить метку')); if (b) b.click();`);
    await d.click(await d.until("delete confirm", () => d.find(".modal.confirm .btn.primary").catch(() => null), 5000));
    // The keyword is taken off folder by folder in the background; the row stays until
    // that debt is paid. Wait for the cache, not for a redraw of the open page.
    await d.until(
      "label left the list",
      async () => {
        const rows = await invoke("labels", { accountId: acc.id }).catch(() => null);
        if (!rows || rows.some((l) => l.name === renamed)) return null;
        return !(await rowLink(renamed));
      },
      60000,
    );
    await closeSettings();
  });

  await step("12.8", "«Очистить» в Корзине и Черновиках: кнопка в шапке, диалог с числом, отмена, задержка с «Отменить», стирание на сервере, черновики в Корзину (#74)", async () => {
    const count = (folder) => Number(helper("count", folder, "Разбор"));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const clearButton = (text) =>
      d.until(`кнопка «${text}»`, async () => ((await textOf(".list .title button.clear")).includes(text) ? d.find(".list .title button.clear") : null), 30000);
    const dialog = () => d.until("диалог", async () => ((await d.findAll(".modal.confirm"))[0] ? true : null), 10000);
    const toast = (text) => d.until(`тост «${text}»`, async () => (await textOf(".toasts")).includes(text) || null, 15000);
    const sync = () => invoke("sync_now", {});

    helper("many", "Trash", "7");
    helper("many", "Drafts", "3");
    await sync();
    // Not in the inbox: there is no command there at all.
    await d.button("Входящие");
    if ((await d.findAll(".list .title button.clear")).length) throw new Error("в «Входящих» не должно быть кнопки «Очистить»");

    // Trash: the button with the count, then the question with the number of letters.
    await openFolder("Корзина");
    const button = await clearButton("Очистить корзину (7)");
    await screenshot("clear-button");
    await d.click(button);
    await dialog();
    const text = await textOf(".modal.confirm");
    if (!text.includes("Очистить корзину?") || !text.includes("7") || !text.includes("Отменить это нельзя")) throw new Error(`диалог: «${text}»`);
    const focused = await d.exec("return document.activeElement?.innerText?.trim() ?? ''");
    if (focused !== "Отмена") throw new Error(`фокус на «${focused}», а не на «Отмена»`);
    await screenshot("clear-confirm");
    await press("Escape");
    await d.until("диалог закрыт", async () => (await d.findAll(".modal.confirm")).length === 0, 10000);
    await wait(6500);
    if (count("Trash") !== 7) throw new Error(`после отказа в Корзине ${count("Trash")} писем`);

    // Confirmed, then cancelled during the delay: nothing is touched.
    await d.click(await clearButton("Очистить корзину (7)"));
    await dialog();
    await d.click(await d.xpath("//div[contains(@class,'modal') and contains(@class,'confirm')]//button[contains(@class,'primary')]"));
    await toast("Очищаю корзину через");
    await screenshot("clear-countdown", { toasts: true });
    await d.click(await d.find(".toasts .toast .act"));
    await wait(6500);
    if (count("Trash") !== 7) throw new Error(`после отмены в задержке в Корзине ${count("Trash")} писем`);

    // Confirmed and left alone: erased on the server, the list and the counter drop to zero.
    await d.click(await clearButton("Очистить корзину (7)"));
    await dialog();
    await d.click(await d.xpath("//div[contains(@class,'modal') and contains(@class,'confirm')]//button[contains(@class,'primary')]"));
    await toast("Корзина очищена: 7");
    await screenshot("clear-done", { toasts: true });
    if (count("Trash") !== 0) throw new Error(`в Корзине осталось ${count("Trash")} писем`);
    await d.until("кнопка отключена в пустой папке", async () => (await d.exec("return document.querySelector('.list .title button.clear')?.disabled ?? false")) || null, 20000);

    // A reply being written in a letter's window: the main window does not know of it, the backend does.
    const subj = "Счёт за октябрь";
    const main = await d.req("GET", d.s("/window"));
    const handles = () => d.req("GET", d.s("/window/handles"));
    await openFolder("Входящие");
    await rowBySubject(subj);
    await d.exec(
      `const row = [...document.querySelectorAll('.row')].find(r => r.innerText.includes(arguments[0]));
       row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));`,
      subj,
    );
    await d.until("окно письма", async () => (await handles()).length === 2, 15000);
    const other = (await handles()).find((h) => h !== main);
    await d.req("POST", d.s("/window"), { handle: other });
    try {
      await d.until("письмо в окне", async () => (await textOf(".reader h1")).includes(subj), 20000);
      await d.click(await d.until("ответить", () => d.xpath("//div[contains(@class,'acts')]//button[contains(., 'Ответить')]")));
      await d.until("ответ в окне", async () => (await d.findAll(".compose")).length === 1);
      await d.type(await d.find(".compose textarea"), "Набрано в окне письма");
      await d.until("черновик окна письма на сервере", async () => helper("count", "Drafts", `Re: ${subj}`) === "1", 30000);
    } finally {
      await d.req("POST", d.s("/window"), { handle: main });
    }
    await sync();

    // Drafts: from the keyboard; they go to the Trash and can be got back from there. The one
    // open in the letter's window stays, and the question says so.
    await openFolder("Черновики");
    await clearButton("Очистить черновики (4)");
    await press("Delete", { ctrlKey: true, shiftKey: true });
    await dialog();
    const ask = await textOf(".modal.confirm");
    if (!ask.includes("Очистить черновики?") || !ask.includes("Корзину")) throw new Error(`диалог черновиков: «${ask}»`);
    if (!ask.includes("открыт в окне")) throw new Error(`диалог не говорит об открытом в окне черновике: «${ask}»`);
    await screenshot("clear-drafts-confirm");
    await d.click(await d.xpath("//div[contains(@class,'modal') and contains(@class,'confirm')]//button[contains(@class,'primary')]"));
    await toast("перенесены в Корзину: 3");
    if (count("Drafts") !== 0) throw new Error(`в Черновиках осталось ${count("Drafts")}`);
    if (count("Trash") !== 3) throw new Error(`в Корзине ${count("Trash")} вместо 3 перенесённых черновиков`);
    if (helper("count", "Drafts", `Re: ${subj}`) !== "1") throw new Error("черновик из окна письма ушёл из Черновиков");
    if (helper("count", "Trash", `Re: ${subj}`) !== "0") throw new Error("черновик из окна письма оказался в Корзине");
    await screenshot("clear-drafts-done", { toasts: true });
    // The window still holds it: its next save replaces the same draft, and discarding removes it.
    await d.req("POST", d.s("/window"), { handle: other });
    try {
      await d.click(await d.until("удалить черновик", () => d.find(".compose [aria-label='Удалить черновик']")));
      if ((await d.findAll(".confirm")).length) await d.click(await d.xpath("//div[contains(@class,'confirm')]//button[contains(@class,'primary')]"));
      await d.until("черновик окна письма удалён", async () => helper("count", "Drafts", `Re: ${subj}`) === "0", 30000);
    } finally {
      await d.req("POST", d.s("/window"), { handle: main });
    }
  });

  await screenshot("final");

  // The last step: the quit ends the app, so the answer is read from the config on disk.
  await step("7.28", "выход по Ctrl+Q с текстом в поле «Название» записывает его (#120)", async () => {
    const me = (await invoke("accounts"))[0];
    // A letter due within a day makes the quit ask first (quit-asked) and the answer is not the text's: the outbox must be empty. Earlier steps send; give them a minute, then drop what is left, since this step ends the run.
    await d.until("outbox empty", async () => (await invoke("outbox")).length === 0, 60000).catch(async () => {
      for (const item of await invoke("outbox")) await invoke("outbox_cancel", { id: item.id });
    });
    await openMailboxPage(me.id);
    const typed = "Выход 7.28";
    await setInput(".account-page .grid input", typed);
    await press("q", { ctrlKey: true });
    const file = join(profile, "config/ru.depesha.mail/accounts.json");
    await d.until("typed text saved on quit", async () => JSON.parse(readFileSync(file, "utf-8")).accounts[0].label === typed, 30000);
  });
} catch (e) {
  if (e instanceof Abort) console.error(`\nПрогон остановлен: ${e.message}.`);
  else console.error("Прогон прерван:", e);
  results.push({ criteria: "-", name: "прогон", ok: false, error: e.message });
} finally {
  await d.quit();
  driverProc.kill();
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
if (retried.length) console.log(`\nПерезапущены и прошли со второй попытки (${retried.length}): ${retried.join("; ")}`);
console.log(`\nИтог: ${results.length - failed.length} из ${results.length} шагов прошли.`);
writeFileSync(join(screens, "results.json"), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
