// The scenes of 0.8.0 (docs/releases/0.8.0.md), shared by e2e/release-shots.mjs (the release's
// description) and e2e/shots.mjs (the README), over mail seeded with `demo-seed 0.8.0`. Each
// takes the kit (shot-kit.mjs) and the name of the picture it writes.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropOn } from "./drop-steps.mjs";

/** Round logos of two made-up companies, stored as if found by the BIMI lookup (a letter that passed DMARC wears one). */
const LOGOS = {
  "example.org": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1f6f8b"/><path d="M18 46V18h15a9 9 0 0 1 0 18H18m0 0h18a9 9 0 0 1 0 10z" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round"/></svg>`,
  "example.net": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2b2b3a"/><circle cx="32" cy="27" r="13" fill="#f2b632"/><rect x="25" y="42" width="14" height="6" rx="2" fill="#f2b632"/></svg>`,
};

/**
 * Session A of a 0.8.0 run (the `prepare` of `kit.boot`): the mailbox gets a name and a colour;
 * one of the two spellings of a person (both have letters, to be merged on a picture) gets a
 * note; the logos are in the cache as if the lookup had found them.
 */
export async function seed080(kit, account, now) {
  const { invoke, db } = kit;
  await invoke("account_patch_own", { id: account, patch: { label: "Работа", color: "#3d7ea6" } });
  await invoke("person_save", {
    person: { email: "olga.smirnova@example.org", name: "Ольга Смирнова", note: "Согласует графики поставок. Пишет с двух адресов; лучше звонить до обеда." },
  });
  await invoke("person_save", { person: { email: "smirnova.o@example.net", name: "Смирнова Ольга" } });
  for (const [domain, svg] of Object.entries(LOGOS)) {
    db(`INSERT OR REPLACE INTO avatars (key, uri, fetched) VALUES ('bimi:${domain}', 'data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}', ${now});`);
  }
}

/** The list: logos, initials, the cursor on one letter and the «!» of an important one. */
export async function listAvatars(kit, name) {
  const { d, sleep, textOf, shot, openBySubject } = kit;
  // 03. The list: logos, initials, the cursor on one letter and the «!» of an important one.
  await d.until("inbox", async () => (await textOf(".list h2")).trim() === "Входящие");
  await openBySubject("Смета на монтаж");
  await sleep(1200);
  await shot(name);
}

/** The important letter, with the line of the sender's mark in its header. */
export async function importanceReader(kit, name) {
  const { d, sleep, textOf, shot, openBySubject } = kit;
  // 04. The important letter, with the line of the sender's mark in its header.
  await openBySubject("Счёт на оплату");
  await d.until("important line", async () => (await textOf(".reader")).includes("Отправитель отметил как важное"));
  await sleep(600);
  await shot(name);
}

/** Many attachments: two rows and «+N ещё ›», then the list behind it. */
export async function readerAttachments(kit, name) {
  const { d, sleep, shot, press, openBySubject } = kit;
  // 07. Many attachments: two rows and «+N ещё ›», then the list behind it.
  await openBySubject("Пакет документов по поставке");
  await d.until("folded files", async () => (await d.findAll(".reader .files .more")).length === 1, 15000);
  await sleep(500);
  await d.click(await d.find(".reader .files .more"));
  await d.until("list of files", async () => (await d.findAll("[data-att]")).length > 0, 5000);
  await sleep(500);
  await shot(name);
  await press("Escape");
  await sleep(300);
}

/** «Очистить» in the Trash: the question with the number of letters. */
export async function clearConfirm(kit, name) {
  const { d, sleep, textOf, shot, press, openFolder } = kit;
  // 05. «Очистить» in the Trash: the question with the number of letters.
  await openFolder("Корзина");
  const clear = await d.until("clear button", async () => ((await textOf(".list .title button.clear")).includes("(7)") ? d.find(".list .title button.clear") : null), 30000);
  await d.click(clear);
  await d.until("clear dialog", async () => (await d.findAll(".modal.confirm")).length === 1, 10000);
  await sleep(400);
  await shot(name);
  await press("Escape");
  await d.until("dialog closed", async () => (await d.findAll(".modal.confirm")).length === 0, 10000);
}

/** The letter being written: the mailbox in the title, «Копия»/«Скрытая» by «Кому», several files, the mark of importance by the bottom bar. */
export async function composeWithFiles(kit, name) {
  const { d, sleep, textOf, shot, setInput, menuItem, openFolder, discardCompose } = kit;
  // 06. The letter being written: the mailbox in the title, «Копия»/«Скрытая» by «Кому»,
  // several files, the mark of importance by the bottom bar.
  await openFolder("Входящие");
  await d.button("Написать");
  await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
  const to = await d.find(".compose .fields input");
  await d.type(to, "petr@example.com");
  await d.pressKey("");
  await setInput(".compose .subject", "Смета и схема склада");
  const text = await d.until("body", () => d.find(".compose .body-area [contenteditable], .compose .body-area textarea").catch(() => null), 10000);
  await d.click(text);
  await d.type(text, "Пётр, добрый день! Во вложении смета, схема склада и договор поставки. Посмотрите до пятницы.");
  // Full screen first: the strip then holds every file, and the count below is the whole set.
  await d.click(await d.find(".compose [aria-label='Во весь экран']"));
  await sleep(500);
  const files = mkdtempSync(join(tmpdir(), "depesha-shots-"));
  const names = ["Смета на монтаж.pdf", "Схема склада.png", "Договор поставки.docx", "Прайс-лист.xlsx", "Заметки к встрече.md"];
  for (const name of names) writeFileSync(join(files, name), `${name}\n`);
  await dropOn(d, names.map((n) => join(files, n)), { zone: "attach" });
  await d.until("attachments", async () => (await d.findAll(".compose .files .file")).length === names.length, 15000).catch(async (e) => {
    console.log("compose:", (await textOf(".compose")).slice(0, 600), "| toasts:", await textOf(".toasts"));
    throw e;
  });
  rmSync(files, { recursive: true, force: true });
  await d.click(await d.find(".compose footer button[aria-label='Ещё']"));
  await d.click(await menuItem("Высокая важность"));
  await d.until("importance chip", async () => (await d.findAll(".compose footer .scheduled.important")).length === 1);
  // The text field out of focus, so no caret and no selection stand in the picture.
  await d.exec("document.activeElement?.blur?.(); window.getSelection()?.removeAllRanges()");
  await sleep(600);
  await shot(name);
  await discardCompose();
}

/** The book of people: the two spellings of one person (the dialog of the merge is shot as `names.merge`, or skipped when null), then the merged card as `names.book`. */
export async function peopleBook(kit, names) {
  const { d, sleep, textOf, shot, press, invoke } = kit;
  // 02 and 01. The book of people: the two spellings of one person, then the merged card.
  await press("k", { ctrlKey: true });
  await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
  await d.type(await d.find(".palette .q"), "перейти контакты");
  await d.type(await d.find(".palette .q"), "");
  await d.until("book", async () => (await d.findAll(".people")).length === 1);
  await d.exec("document.querySelector('.people [role=listbox]').focus()");
  await d.pressKey("/");
  await d.type(await d.find(".people input[type=search]"), "смирнова");
  await d.until("two found", async () => (await d.findAll(".people .pr")).length === 2);
  await d.pressKey("");
  await d.until("list has the focus", async () => (await d.exec("return document.activeElement?.getAttribute('role')")) === "listbox");
  await d.pressKey(" ");
  await d.pressKey("");
  await d.pressKey(" ");
  await d.until("two marked", async () => (await textOf(".people .banner")).includes("Отмечено: 2"));
  await d.pressKey("m");
  await d.until("merge dialog", async () => (await d.findAll(".merge")).length === 1);
  await sleep(400);
  if (names.merge) await shot(names.merge);
  await d.pressKey("");
  await d.until("merged", async () => (await invoke("people", { query: "смирнова" })).length === 1, 15000);
  // The whole book again, the merged person chosen: one card, two addresses.
  await d.exec("document.querySelector('.people input[type=search]').focus()");
  for (let i = 0; i < 10; i++) await d.pressKey("\uE003");
  await d.until("all people", async () => (await d.findAll(".people .pr")).length > 3, 10000).catch(async (e) => {
    console.log("people:", (await textOf(".people")).slice(0, 500));
    throw e;
  });
  await d.click(await d.xpath("//div[contains(@class,'people')]//*[contains(@class,'pr')][.//*[contains(@class,'nm')][contains(., 'Ольга')]]"));
  await d.until("card", async () => (await textOf(".people .pd")).includes("Ольга"));
  await sleep(900);
  await shot(names.book);
  await press("Escape");
}

/** The settings, found by the search over the pages. */
export async function settingsSearch(kit, name, query = "аватар") {
  const { d, sleep, shot, press, closeSettings } = kit;
  // 08. The new settings, found by the search over the pages.
  await press(",", { ctrlKey: true });
  await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
  await d.type(await d.find(".prefs .psearch .q"), query);
  await d.until("search results", async () => (await d.findAll(".prefs .rlist .hit")).length > 0);
  await sleep(500);
  await shot(name);
  await closeSettings();
}

/** A page of the settings, as its tab shows it. */
export async function settingsPage(kit, name, page) {
  const { d, sleep, shot, press, textOf, closeSettings } = kit;
  await press(",", { ctrlKey: true });
  await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
  await d.click(await d.find(`.prefs .tab[data-page='${page}']`));
  await d.until("page", async () => (await textOf(".prefs .pane h2")).length > 0);
  await sleep(500);
  await shot(name);
  await closeSettings();
}
