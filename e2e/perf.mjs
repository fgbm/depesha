// Performance scenario on a cache of real size: 50 «e» (archive) presses in the first
// mailbox while a 60 000-message cache sits in another, and the response of the interface
// and of the other mailbox is measured. For comparing 0.7.0 with the current build:
//
//   docker compose -f compose.test.yaml up -d --force-recreate && python3 e2e/imap_helper.py seed
//   npx tauri build --debug --no-bundle --features e2e
//   DEPESHA_APP=… e2e/keyring.sh node e2e/perf.mjs
//
// Env: DEPESHA_APP (binary), WEBKIT_DRIVER, E2E_DISPLAY (default :99), PERF_RUNS (default 3),
// PERF_SCALE (mailboxes × N, to find where a full scan bites), PERF_OUT (result file),
// PERF_KEEP=1 keeps the profile, PERF_SIZES=1 only seeds and prints the sizes.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { Driver } from "./webdriver.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = process.env.DEPESHA_APP ?? join(root, "target/debug/depesha");
const nativeDriver = process.env.WEBKIT_DRIVER ?? join(process.env.HOME, ".local/depesha-testenv/root/usr/bin/WebKitWebDriver");
const runs = Number(process.env.PERF_RUNS ?? 3);

const profile = mkdtempSync(join(tmpdir(), "depesha-perf-"));
const dbPath = join(profile, "data/ru.depesha.mail/mail.sqlite");
const sqlFile = join(profile, "seed.sql");
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
  DEPESHA_E2E_ROOT: [profile, root].join(delimiter),
  LANGUAGE: "ru",
};

const CAROL = "carol@local.test";
const ACC2 = { email: "big1@perf.example.org", label: "Большой ящик" };
const ACC3 = { email: "big2@perf.example.org", label: "Средний ящик" };
// The cache of account 2: 60 000 letters in 30 folders, 5 000 in the inbox and 30 000 in the archive.
// PERF_SCALE multiplies the mail, to see where a full scan starts to be felt.
const SCALE = Number(process.env.PERF_SCALE ?? 1);
const BIG_INBOX = 5_000 * SCALE;
const BIG_ARCHIVE = 30_000 * SCALE;
const BIG_FOLDERS = 30;
const SMALL_INBOX = 2_000 * SCALE;
const SMALL_ARCHIVE = 500 * SCALE;
const SENDERS = 8_000;
const BODIES = 300;
const BODY_MARK = "ТЕЛО ПЕРФ ПРОВЕРКА";

const d = new Driver();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function invoke(cmd, args = {}) {
  const r = await d.req("POST", d.s("/execute/async"), {
    script:
      "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then((v) => done({ ok: v ?? null }), (e) => done({ err: String(e?.message ?? e) }));",
    args: [cmd, args],
  });
  if (r.err) throw new Error(`${cmd}: ${r.err}`);
  return r.ok;
}

async function textOf(css) {
  return d.exec("return document.querySelector(arguments[0])?.innerText ?? ''", css);
}

async function press(key, mods = {}) {
  await d.exec("window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: arguments[0], bubbles: true }, arguments[1])))", key, mods);
}

async function setInput(css, value) {
  const el = await d.find(css);
  await d.clear(el);
  await d.type(el, String(value));
}

async function setSelect(css, value) {
  await d.click(await d.find(`${css} .trigger`));
  await d.click(await d.until(`option ${value}`, () => d.find(`${css} [role=option][data-value="${value}"]`).catch(() => null)));
}

/** The first mailbox of the wizard: a real GreenMail one, with the password in the keyring. */
async function addAccount() {
  await d.until("wizard", async () => (await d.bodyText()).includes("Добавить почтовый ящик"), 30000);
  await setInput(".wizard input[placeholder='Иван Петров']", "Кэрол Тестова");
  await setInput(".wizard input[type=email]", CAROL);
  await setInput(".wizard input[type=password]", "secret");
  await d.button("Далее");
  await d.until("settings step", async () => (await d.bodyText()).includes("Входящая почта (IMAP)"), 30000);
  await setInput(".wizard input[placeholder^='адрес или']", "carol");
  await setSelect(".wizard fieldset:nth-of-type(1) .select", "plain");
  await setSelect(".wizard fieldset:nth-of-type(2) .select", "plain");
  const hosts = await d.findAll(".wizard fieldset .host input");
  const ports = await d.findAll(".wizard fieldset .port input");
  for (const [i, [host, port]] of [["127.0.0.1", 3143], ["127.0.0.1", 3025]].entries()) {
    await d.clear(hosts[i]);
    await d.type(hosts[i], host);
    await d.clear(ports[i]);
    await d.type(ports[i], String(port));
  }
  await d.button("Проверить и сохранить");
  await d.until("wizard closed", async () => (await d.findAll(".wizard")).length === 0, 30000);
}

/** An account config for a mailbox with no server: only its cache is used. */
function accountPayload(email, label) {
  return {
    id: "",
    label,
    display_name: label,
    email,
    username: email,
    imap: { host: "127.0.0.1", port: 1, security: "plain" },
    smtp: { host: "127.0.0.1", port: 1, security: "plain" },
    save_sent_copy: false,
    waiting: { park: false, folder: "", stop_to_archive: false },
  };
}

/** The SQL that fills the two synthetic mailboxes. Only columns 0.7.0 and main share. */
function seedSql(a2, a3) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const senderEmail = (n) => `sender${n}@perf.example.org`;
  const senderName = (n) => (n % 2 ? `Отправитель ${n}` : `Sender Number ${n}`);
  const addrJson = (name, email) => JSON.stringify({ name, email });
  const toJson = (email) => JSON.stringify([{ name: "Я", email }]);
  const out = ["BEGIN;", "PRAGMA foreign_keys=OFF;"];
  // [account, name, role, count]
  const folders = [
    [a2, "INBOX", "inbox", BIG_INBOX],
    [a2, "Archive", "archive", BIG_ARCHIVE],
  ];
  const rest2 = 60_000 * SCALE - BIG_INBOX - BIG_ARCHIVE;
  const per2 = Math.floor(rest2 / (BIG_FOLDERS - 2));
  const rem2 = rest2 - per2 * (BIG_FOLDERS - 2);
  for (let i = 0; i < BIG_FOLDERS - 2; i++) folders.push([a2, `Папка ${String(i).padStart(2, "0")}`, null, per2 + (i < rem2 ? 1 : 0)]);
  folders.push([a3, "INBOX", "inbox", SMALL_INBOX]);
  folders.push([a3, "Archive", "archive", SMALL_ARCHIVE]);
  for (let i = 0; i < 8; i++) folders.push([a3, `Отдел ${i}`, null, 500 * SCALE]);

  for (const [acc, name, role] of folders) {
    out.push(
      `INSERT INTO folders (account_id,name,display_name,delimiter,role,selectable,hidden) VALUES (${q(acc)},${q(name)},${q(name)},'/',${role ? q(role) : "NULL"},1,0);`,
    );
  }

  let counter = 0;
  for (const [acc, name, role, count] of folders) {
    const me = acc === a2 ? ACC2.email : ACC3.email;
    for (let k = 0; k < count; k++) {
      counter++;
      const uid = k + 1;
      const n = counter % SENDERS;
      const mid = `<m${counter}@perf.example.org>`;
      const date = 1_700_000_000 + counter;
      const size = 1_024 + ((counter * 37) % 49_000);
      const seen = counter % 3 ? 1 : 0;
      const flagged = counter % 17 === 0 ? 1 : 0;
      const hasAtt = counter % 23 === 0 ? 1 : 0;
      const subj = name === "INBOX" && k === 0 ? "Перф: верхнее письмо" : `Письмо ${counter}`;
      out.push(
        `INSERT INTO messages (account_id,folder,uid,message_id,in_reply_to,refs,subject,from_addr,to_addrs,cc_addrs,reply_to,date,size,seen,answered,flagged,draft,has_attachments,thread,bulk) VALUES (` +
          `${q(acc)},${q(name)},${uid},${q(mid)},NULL,'[]',${q(subj)},${q(addrJson(senderName(n), senderEmail(n)))},${q(toJson(me))},'[]','[]',${date},${size},${seen},0,${flagged},0,${hasAtt},${q(mid)},0);`,
      );
    }
  }

  // The newest letters of the big inbox are readable offline, so «time to body» is a cache read.
  const raw = (subj) =>
    `From: Отправитель <sender1@perf.example.org>\r\nTo: ${ACC2.email}\r\nSubject: ${subj}\r\n` +
    `Date: Thu, 01 Jan 2026 00:00:00 +0000\r\nMessage-ID: <body@perf.example.org>\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n${BODY_MARK}`;
  out.push(
    `INSERT INTO bodies (message_id, raw) SELECT id, CAST(${q(raw("Перф: верхнее письмо"))} AS BLOB) FROM messages WHERE account_id=${q(a2)} AND folder='INBOX' ORDER BY date DESC LIMIT ${BODIES};`,
  );

  out.push(
    `INSERT INTO labels (account_id,name,keyword,color) VALUES (${q(a2)},'Важное','Важное','#c0392b'),(${q(a2)},'Клиент','Клиент','#2980b9'),(${q(a3)},'Работа','Работа','#27ae60');`,
  );
  out.push(`UPDATE messages SET keywords='["Важное"]' WHERE account_id=${q(a2)} AND folder='INBOX' AND uid % 100 = 0;`);
  out.push("COMMIT;");
  return out.join("\n");
}

function seed(a2, a3) {
  const sql = seedSql(a2, a3);
  writeFileSync(sqlFile, sql);
  const t = Date.now();
  execFileSync("sqlite3", [dbPath], { input: sql, maxBuffer: 1 << 30 });
  return Date.now() - t;
}

/** One mailbox's folder in the sidebar: clicks until that folder's list is shown.
 *  `who` is how the mailbox is named in the list heading (its label, or its address). */
async function openAccountFolder(email, name, who) {
  const title = `${name} · ${who}`;
  await d.until(`folder ${name} of ${email}`, async () => {
    if ((await textOf(".list h2")).trim() === title) return true;
    return d.exec(
      `const g=[...document.querySelectorAll('nav.side .group')].find((x)=>x.querySelector('.account-name')?.title===arguments[0]);
       if(!g) return null;
       const it=[...g.querySelectorAll('.item')].find((b)=>(b.querySelector('.name')??b).innerText.trim()===arguments[1]);
       if(!it) return null;
       it.click();
       return true;`,
      email,
      name,
    );
  }, 40000);
}

async function firstRow() {
  const rows = await d.findAll(".list .row");
  return rows[0] ?? null;
}

async function inboxCount(carolId) {
  return (await invoke("messages", { query: { account_id: carolId, role: "inbox", limit: 2000 } })).length;
}

/** 50 «e» presses 35 ms apart; a rAF loop records the longest stall of the main thread.
 *  After each press the driver waits for the next letter to open, so the presses archive
 *  successive letters (a press with nothing selected does nothing). Returns at once after
 *  the last press, so the caller can measure the other mailbox while the work drains. */
async function burst(carolId) {
  const before = await inboxCount(carolId);
  await d.exec(
    `window.__perf={max:0,last:performance.now(),n:0};
     (function loop(t){const g=t-window.__perf.last; if(g>window.__perf.max)window.__perf.max=g; window.__perf.last=t; window.__perf.n++; requestAnimationFrame(loop);})(performance.now());`,
  );
  const started = Date.now();
  const pressMs = [];
  let opens = 0;
  for (let i = 0; i < 50; i++) {
    const t = Date.now();
    await press("e");
    pressMs.push(Date.now() - t);
    await sleep(35);
    for (let w = 0; w < 60; w++) {
      const open = await d.exec("return (document.querySelector('.reader h1')?.innerText ?? '').length > 0");
      if (open) {
        opens++;
        break;
      }
      await sleep(30);
    }
  }
  const total = Date.now() - started;
  const rafMax = await d.exec("return window.__perf ? window.__perf.max : -1");
  pressMs.sort((a, b) => a - b);
  return { total, opens, before, pressMedian: pressMs[Math.floor(pressMs.length / 2)], pressMax: pressMs[pressMs.length - 1], rafMax };
}

async function timeInvoke(cmd, args = {}, times = 5) {
  const ts = [];
  for (let i = 0; i < times; i++) {
    const t = Date.now();
    await invoke(cmd, args);
    ts.push(Date.now() - t);
  }
  ts.sort((a, b) => a - b);
  return { median: ts[Math.floor(ts.length / 2)], max: ts[ts.length - 1] };
}

/** One measured run: the burst, then a switch to the big mailbox and a letter opened there. */
async function runOnce(a2) {
  const carolId = (await invoke("accounts")).find((a) => a.email === CAROL).id;
  await d.until("carol account", () => d.exec("return !![...document.querySelectorAll('nav.side .account-name')].find((x)=>x.title===arguments[0])", CAROL), 40000);
  await openAccountFolder(CAROL, "Входящие", CAROL);
  // A letter is open, so «e» has something to archive.
  const row = await d.until("first row", () => firstRow(), 20000);
  await d.click(row);
  await d.until("letter open", async () => (await textOf(".reader h1")).length > 0, 20000);

  const burstResult = await burst(carolId);

  // Right after the burst: the other mailbox must answer while the work drains.
  const switchStart = Date.now();
  await openAccountFolder(ACC2.email, "Входящие", ACC2.label);
  await d.until("big inbox rows", async () => (await d.findAll(".list .row")).length > 0, 30000);
  const switchMs = Date.now() - switchStart;
  const bodyStart = Date.now();
  await d.click(await firstRow());
  await d.until("body shown", async () => (await textOf(".reader .body")).includes(BODY_MARK), 30000);
  const bodyMs = Date.now() - bodyStart;

  const folders = await timeInvoke("folders", { accountId: null });
  const messages = await timeInvoke("messages", { query: { account_id: a2, folder: "INBOX", limit: 200 } });
  const people = await timeInvoke("people", { query: "" });
  const labels = await timeInvoke("labels", { accountId: a2 });
  const rafMax = Math.max(burstResult.rafMax, await d.exec("return window.__perf ? window.__perf.max : -1"));
  const archived = burstResult.before - (await inboxCount(carolId));
  const { before, ...rest } = burstResult;
  return { ...rest, archived, rafMax, switchMs, bodyMs, folders, messages, people, labels };
}

const driverProc = spawn(join(process.env.HOME, ".cargo/bin/tauri-driver"), ["--native-driver", nativeDriver], {
  env,
  stdio: ["ignore", "inherit", "inherit"],
});

const results = [];
try {
  await d.until("tauri-driver", async () => {
    await fetch("http://127.0.0.1:4444/status");
    return true;
  }, 10000);

  // Setup: the real mailbox, then two synthetic ones.
  await d.start(app);
  await addAccount();
  await d.until("carol synced", async () => {
    const t = await d.exec("return document.querySelector('.list')?.dataset.count ?? ''");
    return String(t) !== "";
  }, 60000);
  console.log(`Профиль: ${profile}`);
  const acc2 = await invoke("account_save", { account: accountPayload(ACC2.email, ACC2.label), password: null, grant: null });
  const acc3 = await invoke("account_save", { account: accountPayload(ACC3.email, ACC3.label), password: null, grant: null });
  console.log(`Синтетические ящики: ${acc2.id} / ${acc3.id}`);
  await sleep(1500);
  await d.quit();
  await sleep(1000);

  const seedMs = seed(acc2.id, acc3.id);
  console.log(`Кэш засеян: ${(seedMs / 1000).toFixed(1)} с`);
  const counts = execFileSync("sqlite3", [dbPath, "SELECT (SELECT COUNT(*) FROM messages), (SELECT COUNT(*) FROM addresses), (SELECT COUNT(*) FROM folders), (SELECT COUNT(*) FROM labels);"], { encoding: "utf-8" }).trim();
  console.log(`Сообщений/адресов/папок/меток: ${counts.replace(/\|/g, " / ")}`);
  if (process.env.PERF_SIZES) process.exit(0);

  for (let run = 0; run < runs; run++) {
    await d.start(app);
    const r = await runOnce(acc2.id);
    results.push(r);
    console.log(
      `прогон ${run + 1}: серия ${r.total} мс (нажатие медиана ${r.pressMedian}/макс ${r.pressMax}, ` +
        `архивировано ${r.archived} на ${r.opens} открытий), замирание ${r.rafMax} мс, ` +
        `переключение ${r.switchMs} мс, тело ${r.bodyMs} мс, folders ${r.folders.median}/${r.folders.max}, ` +
        `messages ${r.messages.median}/${r.messages.max}, people ${r.people.median}/${r.people.max}, labels ${r.labels.median}/${r.labels.max}`,
    );
    await d.quit();
    await sleep(1000);
  }

  const med = (pick) => {
    const xs = results.map(pick).sort((a, b) => a - b);
    return xs[Math.floor(xs.length / 2)];
  };
  const max = (pick) => Math.max(...results.map(pick));
  const summary = {
    app: app,
    runs: results.length,
    archived: { median: med((r) => r.archived), max: max((r) => r.archived) },
    raf_max_ms: { median: med((r) => r.rafMax), max: max((r) => r.rafMax) },
    switch_ms: { median: med((r) => r.switchMs), max: max((r) => r.switchMs) },
    body_ms: { median: med((r) => r.bodyMs), max: max((r) => r.bodyMs) },
    folders_ms: { median: med((r) => r.folders.median), max: max((r) => r.folders.max) },
    messages_ms: { median: med((r) => r.messages.median), max: max((r) => r.messages.max) },
    people_ms: { median: med((r) => r.people.median), max: max((r) => r.people.max) },
    labels_ms: { median: med((r) => r.labels.median), max: max((r) => r.labels.max) },
  };
  const outFile = process.env.PERF_OUT ?? join(root, "e2e/perf-result.json");
  writeFileSync(outFile, JSON.stringify({ summary, runs: results }, null, 2));
  console.log(`ИТОГ ${outFile}`);
  console.log(JSON.stringify(summary));
} catch (e) {
  console.error("Прогон прерван:", e);
  process.exitCode = 1;
} finally {
  await d.quit();
  driverProc.kill();
  try {
    const cfg = JSON.parse(readFileSync(join(profile, "config/ru.depesha.mail/accounts.json"), "utf-8"));
    for (const a of cfg.accounts ?? []) execFileSync("secret-tool", ["clear", "service", "ru.depesha.mail", "username", a.id]);
  } catch {}
  if (!process.env.PERF_KEEP) rmSync(profile, { recursive: true, force: true });
}
