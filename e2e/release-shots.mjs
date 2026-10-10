// Screenshots for a release's description (docs/releases/<version>.md): the real app (debug
// build) on a virtual display, driven over WebDriver, over the tidy demo mail seeded by
// imap_helper.py demo-seed. SHOTS_SET=0.8.0 shoots the set of 0.8 (the scenes are in
// scenes-080.mjs, shared with shots.mjs, over the demo mail seeded with the same SHOTS_SET);
// without it, the set of 0.7 below. For another release adapt the shots and the seeded ids.
//
//   scripts/release-shots.sh                 the whole thing (servers, demo mail, build, shoot)
//   DEPESHA_APP=… scripts/release-shots.sh   an already built binary, no build
//   SHOTS_SET=0.8.0 scripts/release-shots.sh the set of 0.8.0
//
// Writes ${SHOTS_OUT}/NN-*.png (default /tmp/depesha-release-shots). Demo data is tidy
// (example.com), the labels and reply marks are seeded before the shooting session so the
// pictures carry test names only. The driver, profile and helpers are in shot-kit.mjs.

import { createKit } from "./shot-kit.mjs";
import { clearConfirm, composeWithFiles, importanceReader, listAvatars, peopleBook, readerAttachments, seed080, settingsSearch } from "./scenes-080.mjs";

const v8 = (process.env.SHOTS_SET ?? "0.7.0") === "0.8.0";
const kit = createKit({ out: process.env.SHOTS_OUT ?? "/tmp/depesha-release-shots", tag: "depesha-rel-", v8 });
const { d, sleep, db, shot, textOf, setInput, press, invoke, openFolder, openBySubject, menuItem, closeSettings, discardCompose } = kit;

try {
  await kit.boot({
    prepare: async (account, now) => {
      if (v8) return seed080(kit, account, now);
      // The labels themselves are read by the labels store at the next start; the keywords
      // (the chips in the rows) are put in later, in the shooting session, so the two list
      // pictures differ.
      await invoke("label_save", { accountId: account, name: "Срочно", color: "#d0658f" });
      await invoke("label_save", { accountId: account, name: "Клиенты", color: "#4a90d9" });
      db(`INSERT OR REPLACE INTO marks (account_id, message_id, reply, reply_all, forward, answer) VALUES
      ('${account}', 'report-9@example.org', ${now - 3600}, NULL, NULL, NULL),
      ('${account}', 'invoice-15@example.org', NULL, NULL, ${now - 7200}, NULL),
      ('${account}', 'weekly-44@example.org', NULL, ${now - 10800}, NULL, NULL);`);
    },
  });
  const account = (await invoke("accounts"))[0].id;

  if (v8) {
    await listAvatars(kit, "03-list-avatars");
    await importanceReader(kit, "04-importance-reader");
    await readerAttachments(kit, "07-reader-attachments");
    await clearConfirm(kit, "05-clear-confirm");
    await composeWithFiles(kit, "06-compose");
    await peopleBook(kit, { merge: "02-people-merge", book: "01-people-book" });
    await settingsSearch(kit, "08-settings");
  } else {
    // 01. Settings: "Фон и запуск".
    await press(",", { ctrlKey: true });
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    await d.click(await d.find(".prefs .tab[data-page='start']"));
    await d.until("background page", async () => (await d.findAll(".prefs [data-settings='close_action']")).length === 1);
    await sleep(300);
    await shot("01-background");

    // 05. Settings: "Клавиши".
    await d.click(await d.find(".prefs .tab[data-page='keys']"));
    await d.until("keys page", async () => (await d.findAll(".prefs .kr[data-command='core.archive']")).length === 1);
    await sleep(300);
    await shot("05-keys");

    // 06. Settings: the search over the pages.
    await d.type(await d.find(".prefs .psearch .q"), "формат");
    await d.until("search results", async () => (await d.findAll(".prefs .rlist .hit")).length > 0);
    await sleep(300);
    await shot("06-settings-search");
    await closeSettings();

    // 02. Compose in Markdown, with a table edited in its cells. Full screen, so the table fits.
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await setInput(".compose .subject", "График работ на складе");
    await d.click(await d.find(".compose footer button[aria-label='Формат письма']"));
    await d.click(await menuItem("Markdown"));
    await d.click(await d.find(".compose [aria-label='Во весь экран']"));
    await d.until("markdown editor", async () => (await d.findAll(".compose .md-editor .cm-content")).length === 1, 15000);
    const body = await d.find(".compose .md-editor .cm-content");
    await d.click(body);
    // Newlines through real Enter presses: a "\n" in the typed text is dropped by the editor.
    for (const line of ["# График работ", "", "Пётр, добрый день!", "Предлагаю такой график на складе.", ""]) {
      if (line) await d.type(body, line);
      await d.pressKey("\uE007");
    }
    await sleep(300);
    // "Таблица" from the "⋯" of the formatting row.
    await d.click(await d.find(".compose [aria-label='Ещё оформление']"));
    await d.click(await menuItem("Таблица"));
    await d.until("table drawn", async () => (await d.findAll(".compose .md-table")).length === 1);
    // Move the caret out of the table's own lines so the widget is drawn, not its source.
    await d.click(await d.find(".compose .md-editor .cm-content .cm-line"));
    await d.until("table widget", async () => (await d.findAll(".compose .md-table-view")).length === 1);
    const cell = (spec) => d.find(`.compose .md-table-cell-text[data-cell='${spec}']`);
    const fill = async (spec, text, tab = true) => {
      await d.click(await cell(spec));
      await d.type(await cell(spec), text);
      if (tab) await d.pressKey("\uE004");
    };
    // Three characters at most per cell: a narrow column wraps a longer cell. Tab at the
    // last cell grows a row, as the editor does.
    await fill("-1:0", "Дни");
    await fill("-1:1", "Кто");
    await fill("-1:2", "Час");
    await fill("0:0", "пн");
    await fill("0:1", "Аня");
    await fill("0:2", "10");
    await sleep(500);
    await fill("1:0", "вт");
    await fill("1:1", "Ира");
    await fill("1:2", "14", false);
    // Escape on the focused cell writes the table back into the letter and rebuilds it, so
    // the columns take their real width; a click elsewhere leaves the cells uncommitted.
    await d.pressKey("\uE001");
    await sleep(500);
    // Blur so the focused cell writes the table back into the letter before the shot; the
    // cells hold their column by the word now, so nothing has to be forced on them.
    await d.exec("document.activeElement?.blur?.()");
    await sleep(300);
    await shot("02-markdown-editor");
    await discardCompose();

    // 03. The list: the reply marks before the date.
    await d.button("Входящие");
    await d.until("inbox", async () => (await textOf(".list h2")).trim() === "Входящие");
    await sleep(600);
    await shot("03-reply-marks");

    // 07. The list: the label chips after the subject. The keywords go into the cache now and
    // the list is re-read, so this picture differs from the one above.
    const kw = (name) => db(`SELECT keyword FROM labels WHERE account_id='${account}' AND name='${name}'`);
    db(`UPDATE messages SET keywords=json_array('${kw("Срочно")}') WHERE account_id='${account}' AND message_id='invoice-15@example.org';`);
    db(`UPDATE messages SET keywords=json_array('${kw("Клиенты")}') WHERE account_id='${account}' AND message_id='report-9@example.org';`);
    await openFolder("Работа");
    await sleep(500);
    await openFolder("Входящие");
    await d.until("inbox again", async () => (await textOf(".list h2")).trim() === "Входящие");
    await sleep(600);
    await shot("07-labels");

    // 04. The person card of the sender.
    await openBySubject("Смета на монтаж");
    await d.click(await d.find(".reader .sender"));
    await d.until("person card", async () => (await d.findAll(".pcard")).length === 1);
    await sleep(300);
    await shot("04-person-card");
    await press("Escape");
  }

  console.log("Готово.");
} catch (e) {
  console.error("Прогон прерван:", e);
  process.exitCode = 1;
} finally {
  await kit.finish();
}
