// README screenshots, reproducible: the real app (debug build) on a virtual display,
// driven over WebDriver, with tidy demo mail seeded by imap_helper.py demo-seed 0.8.0
// (scripts/shots.sh does all of it). The driver, profile and helpers are in shot-kit.mjs; the
// scenes of 0.8 (people, attachments, «Очистить», settings) in scenes-080.mjs, which the
// release's pictures use too.
//
//   docker compose -f compose.test.yaml up -d --force-recreate
//   python3 e2e/imap_helper.py demo-seed 0.8.0
//   npx tauri build --debug --no-bundle --features e2e
//   e2e/keyring.sh node e2e/shots.mjs
//
// The whole set is written to docs/screenshots/. Env: DEPESHA_APP, WEBKIT_DRIVER, E2E_DISPLAY,
// E2E_KEEP=1 (see shot-kit.mjs).

import { join } from "node:path";
import { createKit, root } from "./shot-kit.mjs";
import { clearConfirm, importanceReader, peopleBook, readerAttachments, seed080, settingsPage } from "./scenes-080.mjs";

const kit = createKit({ out: join(root, "docs/screenshots"), tag: "depesha-shots-", v8: true });
const { d, sleep, db, shot, textOf, setInput, setSelect, press, invoke, sidebarText, rowBySubject, openBySubject, palette, closeSettings, discardCompose } = kit;

/** Switches the interface language in Settings and saves. */
async function setLanguage(search, value) {
  await palette(search);
  await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
  await d.click(await d.find(`.prefs input[type=radio][name=language][value="${value}"]`));
  await d.click(await d.find(".prefs footer .btn.primary"));
  await d.until("settings closed", async () => (await d.findAll(".prefs")).length === 0);
}

/** Picks an appearance theme in Settings and saves. */
async function setTheme(search, value) {
  await palette(search);
  await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
  await d.click(await d.xpath(`//div[contains(@class,'themes')]//label[.//input[@value=${JSON.stringify(value)}]]`));
  await d.click(await d.find(".prefs footer .btn.primary"));
  await d.until("settings closed", async () => (await d.findAll(".prefs")).length === 0);
}

try {
  const me = await kit.boot({
    prepare: async (account, now) => {
      await seed080(kit, account, now);
      // The waits for an answer: their letters are in Sent, the plan is the backend's.
      // The same letters are started here, straight in the cache, because a wait begins
      // only after a real send, and a picture must not depend on the outbox's timing.
      db(`INSERT OR REPLACE INTO followups
          (account_id, message_id, subject, recipients, sent, due, deadline, status, repeat_secs, expect, kind, own_deadline)
          VALUES
          ('${account}', 'f-wait@example.org', 'Заявка на пропуск для подрядчиков', 'petr@example.com',
           ${now - 5400}, ${now + 172800}, ${now + 172800}, 'waiting', 0, '', '3 дня', 0),
          ('${account}', 'f-done@example.org', 'Проверка датчиков на складе', 'maria@example.org',
           ${now - 10 * 86400}, ${now - 2 * 86400}, ${now - 2 * 86400}, 'waiting', 0, '', '3 дня', 0);`);
      await invoke("settings_set", { settings: { ...(await invoke("settings_get")), theme: "paper", language: "ru" } });
    },
  });
  console.log(`  ${await textOf(".list h2")}: ${await d.exec("return document.querySelector('.list').dataset.count")}`);

  // 1. The main window: logos and initials, the «!» of an important letter, and that letter open.
  await d.until("inbox", async () => (await textOf(".list h2")).trim() === "Входящие");
  await importanceReader(kit, "main");

  // 2. The compose editor in HTML: the formatting row over the letter and its signature.
  await d.button("Написать");
  await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
  await d.type((await d.findAll(".compose .box input"))[0], "petr@example.com");
  await setInput(".compose .subject", "Смета на монтаж: правки");
  await d.exec(
    `const r = document.querySelector('.compose .rich'); r.focus();
     document.execCommand('insertHTML', false,
       '<div>Пётр, добрый день!</div><div>По смете три правки:</div>' +
       '<ul><li>доставка — 120 000 вместо 180 000;</li><li>монтаж освещения считаем отдельно;</li>' +
       '<li>срок сдвигаем на неделю.</li></ul><div>Тогда итог — <b>940 000 ₽</b>.</div>');`);
  await shot("compose");

  // 3. Settings: the mailbox's signatures, one of them the default.
  await discardCompose();

  /** Types lines into the signature open in its editor, as its own commands do. */
  async function typeSignature(lines) {
    await d.exec(
      `const el = document.querySelector('.account-page .sig-rich .rich'); el.focus();
       arguments[0].forEach((line, i) => { if (i) document.execCommand('insertParagraph'); document.execCommand('insertText', false, line); });`,
      lines,
    );
  }
  await palette("настр");
  await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
  await d.click(await d.find(".prefs .tab[data-page='accounts']"));
  await d.until("manager", async () => (await d.findAll(".prefs .accounts")).length === 1);
  const at = Math.max(0, (await invoke("accounts")).findIndex((a) => a.id === me));
  await d.click((await d.findAll(".prefs .accounts .acc > .btn.icon"))[at]);
  await d.until("account page", async () => (await d.findAll(".account-page")).length === 1);
  await d.click(await d.xpath("//nav[contains(@class,'toc')]//a[contains(., 'Письма и подписи')]"));
  await d.until("signature section", async () => (await textOf(".account-page .signatures")).includes("Добавить подпись"));
  // The mailbox's signatures: the first becomes the default by itself.
  await d.button("Добавить подпись");
  await setInput(".account-page .signatures input.name", "Рабочая");
  await typeSignature(["С уважением,", "Анна Крылова", "отдел ИТ, +7 495 000-00-00"]);
  await d.click(await d.xpath("//div[contains(@class,'signatures')]//button[contains(., 'Свернуть')]"));
  await d.button("Добавить подпись");
  await setInput(".account-page .signatures input.name", "Короткая");
  await typeSignature(["Анна, отдел ИТ"]);
  await d.click(await d.xpath("//div[contains(@class,'signatures')]//button[contains(., 'Свернуть')]"));
  await d.until("signature list", async () => (await textOf(".account-page .signatures")).includes("Рабочая"));
  await sleep(300);
  await shot("signatures");
  // Saved, so the default signature is there for good.
  await d.until("saved", async () => (await invoke("accounts")).some((a) => a.signatures?.length === 2), 20000);
  await closeSettings();

  // 4. «Ждут ответа»: an active wait near its reminder, an overdue one.
  await d.button("Ждут ответа");
  await d.until("followups", async () => (await textOf(".list h2")).includes("Ждут ответа"));
  await rowBySubject("Заявка на пропуск", 20000);
  await shot("followups");

  // 5. The narrow window (#38): the sidebar becomes a strip, one column at a time —
  //    the list first, the letter after a click.
  await d.button("Входящие");
  await d.setRect(600, 720);
  await sleep(600);
  await d.until("narrow window", async () => !!(await d.exec("return !!document.querySelector('.layout.single')")), 10000);
  await rowBySubject("Re: Смета на монтаж", 20000);
  console.log("  узкое окно: список");
  await shot("narrow-list");
  await d.click(await rowBySubject("Re: Смета на монтаж"));
  await d.until("letter in narrow window", async () => !!(await d.exec("return !!document.querySelector('.reader h1')")), 20000);
  await sleep(2500); // the reader's "opening" placeholder gives way to the letter
  console.log("  узкое окно: письмо —", await textOf(".reader h1"));
  await shot("narrow-message");
  await press("Escape");
  await d.setRect(1280, 820);
  await sleep(600);

  // 6. The snooze menu on a letter.
  await d.button("Входящие");
  await openBySubject("Смета на монтаж");
  await press("h");
  await d.until("snooze menu", async () => (await textOf(".snooze .pop")).includes("Завтра"));
  await shot("snooze");
  await press("Escape");

  // 7. The check before sending: a mentioned but missing attachment.
  await d.button("Написать");
  await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
  await d.type((await d.findAll(".compose .box input"))[0], "petr@example.com");
  await setInput(".compose .subject", "Договор на подпись");
  await d.exec("const r = document.querySelector('.compose .rich'); r.focus(); document.execCommand('insertHTML', false, '<div>Пётр, договор во вложении. Подпишите, пожалуйста, до пятницы.</div>');");
  await d.click(await d.find(".compose .split-btn .main"));
  await d.until("attachment warning", async () => (await textOf(".compose .warnings")).includes("вложение"));
  await shot("preflight");
  await discardCompose();

  // 7a. 0.8: the pictures of the new features, from the scenes the release's pictures use.
  await readerAttachments(kit, "reader-attachments");
  await clearConfirm(kit, "clear");
  await peopleBook(kit, { merge: null, book: "people" });
  await settingsPage(kit, "settings", "reading");

  // 8. Dark theme, a conversation: the whole thread of three letters with its cards.
  await setTheme("настр", "night");
  await d.button("Входящие");
  await openBySubject("Re: Смета на монтаж");
  await d.click(await d.find(".reader .thread"));
  await d.until("conversation", async () => (await d.findAll(".reader .thread .card")).length >= 2, 10000);
  await sleep(300);
  await shot("dark");
  await press("Escape");

  // 9. Trusting a certificate by fingerprint: the wizard meets GreenMail's self-signed one.
  //    The English README's main shot is light: the night theme goes back first.
  await setTheme("настр", "snow");
  await setLanguage("настр", "en");
  await d.until("English sidebar", async () => (await sidebarText()).includes("Inbox"), 10000);
  await d.button("Inbox");
  await openBySubject("Re: Смета на монтаж");
  await shot("english");
  await d.click(await d.find(".menu-btn"));
  await d.button("Add account");
  await d.until("wizard", async () => (await d.findAll(".wizard")).length === 1);
  await setInput(".wizard input[placeholder='Jane Smith']", "Boris Smith");
  await setInput(".wizard input[type=email]", "boris@example.org");
  await setInput(".wizard input[type=password]", "secret");
  await d.button("Next");
  await d.until("settings step", async () => (await d.bodyText()).includes("Incoming mail (IMAP)"), 30000);
  await setInput(".wizard input[placeholder^='address or']", "bob");
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
  await d.button("Check and save");
  await d.until("certificate question", async () => (await d.bodyText()).includes("SHA-256"), 20000);
  await sleep(300);
  await shot("certificate");

  console.log("Готово.");
} catch (e) {
  console.error("Прогон прерван:", e);
  process.exitCode = 1;
} finally {
  await kit.finish();
}
