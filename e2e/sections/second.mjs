// Section "second" of the run (see e2e/shard.mjs for the split into parts).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root, profile, d, helper, screenshot, step, rowBySubject, openBySubject, openFolder, textOf, setInput, setSelect, altKey, invoke, press, composeClosed, closeSettings, openMailboxPage, sidebarText, section, stamp } from "../kit.mjs";

export async function run() {
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
    await d.type((await d.findAll(".compose .box input"))[0], "bob@local.test\uE007");
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

  await step("4.1.2", "«Все черновики»: черновики обоих ящиков, каждый открывается от своего отправителя", async () => {
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

  await step("4.2.2", "менеджер ящиков: порядок, название и цвет; свёрнутый ящик без лишнего отступа", async () => {
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
    await d.type((await d.findAll(".compose .box input"))[0], "carol@local.test\uE007");
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

    // The «Метки» heading in the sidebar stands in the folders' icon column, not at the window's edge.
    const edges = () =>
      d.exec(
        `const icon = document.querySelector('nav.side .labels .subhead svg');
         const row = document.querySelector('nav.side .labels .item .icon');
         const folder = document.querySelector('nav.side .group .folder-row:not(.label-row) .item .icon');
         if (!icon || !row || !folder) return null;
         return { head: icon.getBoundingClientRect().left, label: row.getBoundingClientRect().left, folder: folder.getBoundingClientRect().left };`,
      );
    const seen = await d.until("sidebar labels heading", async () => (await edges().catch(() => null)) ?? null, 30000);
    await screenshot("sidebar-subhead");
    if (Math.abs(seen.head - seen.label) > 2 || Math.abs(seen.head - seen.folder) > 2) {
      throw new Error(`заголовок «Метки» сбит: иконка ${seen.head}px, метка ${seen.label}px, папка ${seen.folder}px`);
    }

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
    const button = await clearButton("Очистить Корзину (7)");
    await screenshot("clear-button");
    await d.click(button);
    await dialog();
    const text = await textOf(".modal.confirm");
    if (!text.includes("Очистить Корзину?") || !text.includes("7") || !text.includes("Отменить это нельзя")) throw new Error(`диалог: «${text}»`);
    const focused = await d.exec("return document.activeElement?.innerText?.trim() ?? ''");
    if (focused !== "Отмена") throw new Error(`фокус на «${focused}», а не на «Отмена»`);
    await screenshot("clear-confirm");
    await press("Escape");
    await d.until("диалог закрыт", async () => (await d.findAll(".modal.confirm")).length === 0, 10000);
    await wait(6500);
    if (count("Trash") !== 7) throw new Error(`после отказа в Корзине ${count("Trash")} писем`);

    // Confirmed, then cancelled during the delay: nothing is touched.
    await d.click(await clearButton("Очистить Корзину (7)"));
    await dialog();
    await d.click(await d.xpath("//div[contains(@class,'modal') and contains(@class,'confirm')]//button[contains(@class,'primary')]"));
    await toast("Очищаю Корзину через");
    await screenshot("clear-countdown", { toasts: true });
    await d.click(await d.find(".toasts .toast .act"));
    await wait(6500);
    if (count("Trash") !== 7) throw new Error(`после отмены в задержке в Корзине ${count("Trash")} писем`);

    // Confirmed and left alone: erased on the server, the list and the counter drop to zero.
    await d.click(await clearButton("Очистить Корзину (7)"));
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
}
