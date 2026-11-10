// Section "typography" of the run (see e2e/shard.mjs for the split into parts).
//
// One letter throughout: the plugin is off for the first text, switched on from the settings over
// the same letter, typed into all three editors, undone once in the plain field, and switched off
// again over the same letter.
import { d, helper, screenshot, step, invoke, setInput, textOf, composeClosed, closeSettings, section, stamp } from "../kit.mjs";

export async function run() {
  section("typography");
  const subj = `Типографика ${stamp}`;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  // The switch of the built-in plugin in the one list of settings (10.1), and what the settings say of it.
  const sw = ".prefs .plugins [data-plugin='typography'] .sw";
  const saved = async () => ((await invoke("settings_get")).enabled_plugins ?? []).includes("typography");
  const checked = () => d.exec("return document.querySelector(arguments[0])?.getAttribute('aria-checked') ?? null", sw);

  /** Settings → «Плагины» from the palette over the open letter, as a person opens it. */
  const openPlugins = async () => {
    await d.chord(["\uE009"], "k");
    await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
    await d.type(await d.find(".palette .q"), "плагины");
    // A row carries its key and the pencil as spans of their own: the title is the first one.
    const top = () => d.exec("return document.querySelector('.palette .item.active > span')?.textContent.trim() ?? ''");
    await d.until("«Плагины» наверху", async () => (await top()) === "Плагины");
    await d.type(await d.find(".palette .q"), "\uE007");
    await d.until("plugins page", async () => (await d.findAll(".prefs .plugins")).length === 1);
    await d.until("row of typography", async () => (await d.findAll(sw)).length === 1);
  };

  /** Toasts stand over the footer and its menu: they go before the menu is opened. */
  const dismissToasts = async () => {
    if ((await d.findAll(".toasts .toast")).length === 0) return;
    await d.exec("document.querySelectorAll('.toasts .toast .close').forEach((b) => b.click())");
    await d.until("toasts gone", async () => (await d.findAll(".toasts .toast")).length === 0, 5000);
  };

  /** The letter's format by the footer's menu (5.9): «Обычный текст», «HTML» or «Markdown». */
  const format = async (label) => {
    await dismissToasts();
    await d.click(await d.find(".compose footer button[aria-label='Формат письма']"));
    await d.click(await d.until(`${label} in the menu`, () => d.xpath(`//div[contains(@class,'compose')]//footer//button[@role='menuitemradio'][contains(., '${label}')]`)));
  };

  const plain = () => d.exec("return document.querySelector('.compose textarea')?.value ?? ''");
  const plainCaret = () => d.exec("const t = document.querySelector('.compose textarea'); return { start: t.selectionStart, end: t.selectionEnd };");
  const markdown = async () => textOf(".compose .cm-content");
  /** Where the caret is, and the text of the node it is in: the visual editor keeps its own selection. */
  const caret = () =>
    d.exec(`
      const s = window.getSelection();
      if (!s || s.rangeCount === 0) return { collapsed: false, node: 0, text: "", offset: -1 };
      const n = s.anchorNode;
      return { collapsed: s.isCollapsed, node: n ? n.nodeType : 0, text: n ? n.textContent : "", offset: s.anchorOffset };
    `);
  /** The caret at the end of a field: a click into it, then the field's own Ctrl+End. */
  const toEnd = async (css) => {
    await d.click(await d.find(css));
    await d.chord(["\uE009"], "\uE010");
  };
  /** The plain field emptied by its own keys. */
  const clearPlain = async () => {
    await d.click(await d.find(".compose textarea"));
    await d.chord(["\uE009"], "a");
    await d.pressKey("\uE017");
    await d.until("поле пусто", async () => (await plain()) === "");
  };
  /** The letter under the settings window is the same one: one window, same subject. */
  const sameLetter = async () => {
    await d.until("letter still here", async () => (await d.findAll(".compose")).length === 1);
    const text = await d.exec("return document.querySelector('.compose .subject').value");
    if (text !== subj) throw new Error(`письмо сменилось, пока были открыты настройки: тема ${JSON.stringify(text)}`);
  };

  await step("10.9", "типографика выключена по умолчанию: набранные «--» и «...» остаются как есть", async () => {
    if (await saved()) throw new Error("плагин типографики включён на свежем профиле");
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    // New letters are plain after the setup: the field below is the whole of the letter's text.
    await d.until("plain field", async () => (await d.findAll(".compose textarea")).length === 1);
    await setInput(".compose .subject", subj);
    await d.type(await d.find(".compose textarea"), "плоский--текст...");
    await d.until("typed as is", async () => (await plain()) === "плоский--текст...");
  });

  await step("10.9.2", "типографика включается в настройках на уже открытом письме и не заменяет его", async () => {
    await openPlugins();
    if ((await checked()) !== "false") throw new Error(`переключатель типографики до нажатия: ${await checked()}`);
    await d.click(await d.find(sw));
    await d.until("switch on", async () => (await checked()) === "true");
    await d.until("saved on", saved);
    await closeSettings();
    // The letter waited under the settings window and keeps what was typed into it.
    await sameLetter();
    const value = await plain();
    if (value !== "плоский--текст...") throw new Error(`письмо изменилось при включении плагина: ${JSON.stringify(value)}`);
  });

  await step("10.9.3", "простое письмо: «--» становится тире под кареткой, а Ctrl+Z снимает тире", async () => {
    await clearPlain();
    // The clear is a step of the field's own undo: a pause keeps the replacement out of it.
    await pause(300);
    await d.type(await d.find(".compose textarea"), "--");
    await d.until("em dash", async () => (await plain()) === "\u2014");
    const at = await plainCaret();
    if (at.start !== 1 || at.end !== 1) throw new Error(`каретка после тире: ${JSON.stringify(at)}`);
    await d.chord(["\uE009"], "z");
    // WebKitWebDriver's Ctrl+Z never reaches GTK's undo binding (plain typing stays as well);
    // the field's own undo command works the same undo stack the key runs.
    if ((await plain()).includes("\u2014")) await d.exec("const t = document.querySelector('.compose textarea'); t.focus(); document.execCommand('undo')");
    // `d.until` waits on a truthy value, and an empty field is the common result of the undo here.
    const undone = await d.until("undo", async () => {
      const v = await plain();
      return v.includes("\u2014") ? null : { v };
    });
    // The field undoes one typing as it saw it: the dash, the dash with a letter, or both letters.
    if (!["", "-", "--"].includes(undone.v)) throw new Error(`после Ctrl+Z: ${JSON.stringify(undone.v)}`);
    await clearPlain();
    await d.type(await d.find(".compose textarea"), "плоский--текст...");
    await d.until("both replaced", async () => (await plain()) === "плоский\u2014текст\u2026");
  });

  await step("10.9.4", "визуальное письмо: замена на месте каретки, а каретка в конце замены", async () => {
    await format("HTML");
    await d.until("visual editor", async () => (await d.findAll(".compose .rich[contenteditable='true']")).length === 1);
    // Ctrl+End would run into or past the locked signature: Home, then End, stops at the end of the
    // letter's own line, above the signature.
    await d.click(await d.find(".compose .rich"));
    await d.chord(["\uE009"], "\uE011");
    await d.pressKey("\uE010");
    await d.type(await d.find(".compose .rich"), "визуальный--текст...");
    const seen = await d.until("both replaced", async () => {
      const v = await textOf(".compose .rich");
      return v.includes("визуальный\u2014текст\u2026") ? v : null;
    });
    if (seen.includes("--")) throw new Error(`в визуальном письме осталось «--»: ${JSON.stringify(seen)}`);
    const sel = await caret();
    if (!sel.collapsed || sel.node !== 3 || sel.text !== "плоский\u2014текст\u2026визуальный\u2014текст\u2026") throw new Error(`каретка не в текстовом узле письма: ${JSON.stringify(sel)}`);
    if (sel.offset !== sel.text.length) throw new Error(`каретка не в конце узла: ${sel.offset} из ${sel.text.length}`);
    await screenshot("typography-html");
  });

  await step("10.9.5", "Markdown-письмо: замена в редакторе CodeMirror, а не в поле-подмене", async () => {
    await format("Markdown");
    await d.until("code editor", async () => (await d.findAll(".compose .cm-editor")).length === 1);
    if ((await d.findAll(".compose .md-fallback")).length) throw new Error("Markdown-редактор не загрузился: шаг проверял бы поле-подмену");
    await d.until("editable code editor", async () => (await d.findAll(".compose .cm-content[contenteditable='true']")).length === 1, 20000);
    await toEnd(".compose .cm-content");
    await d.type(await d.find(".compose .cm-content"), "маркдаун--текст...");
    const typed = "плоский\u2014текст\u2026визуальный\u2014текст\u2026маркдаун\u2014текст\u2026";
    const doc = await d.until("both replaced", async () => {
      const v = await markdown();
      return v.includes("маркдаун\u2014текст\u2026") ? v : null;
    });
    if (!doc.includes(typed)) throw new Error(`Markdown не сохранил набранное подряд: ${JSON.stringify(doc)}`);
    if (doc.includes("маркдаун--")) throw new Error(`Markdown оставил набранное как есть: ${JSON.stringify(doc)}`);
    const sel = await caret();
    if (!sel.collapsed || sel.node !== 3 || !sel.text.endsWith("маркдаун\u2014текст\u2026")) throw new Error(`каретка не сразу за набранным: ${JSON.stringify(sel)}`);
    if (sel.offset !== sel.text.length) throw new Error(`каретка не в конце узла: ${sel.offset} из ${sel.text.length}`);
  });

  await step("10.9.6", "выключенная на том же письме типографика оставляет «--» как набрано", async () => {
    // The letter as it stands before the switch: the disabled plugin must not rewrite it.
    const before = await markdown();
    await openPlugins();
    if ((await checked()) !== "true") throw new Error(`переключатель типографики до нажатия: ${await checked()}`);
    await d.click(await d.find(sw));
    await d.until("switch off", async () => (await checked()) === "false");
    await d.until("saved off", async () => !(await saved()));
    await closeSettings();
    await sameLetter();
    await dismissToasts();
    await toEnd(".compose .cm-content");
    await d.type(await d.find(".compose .cm-content"), "выключено--текст...");
    // The code editor's last, empty line ends innerText with its break: the typing goes before it.
    const tail = before.endsWith("\n") ? "\n" : "";
    const expected = `${before.slice(0, before.length - tail.length)}выключено--текст...${tail}`;
    const doc = await d.until("typed as is", async () => {
      const v = await markdown();
      return v === expected ? v : null;
    });
    if (doc.includes("выключено\u2014")) throw new Error(`выключенный плагин заменил набранное: ${JSON.stringify(doc)}`);
    await screenshot("typography-off");
    // The letter goes, and its draft with it: the sections after this one count their own drafts.
    await d.click(await d.find(".compose [aria-label='Удалить черновик']"));
    const asked = await d.until("discard question or closed", async () => {
      if ((await d.findAll(".confirm")).length) return "question";
      return (await d.findAll(".compose")).length === 0 ? "closed" : null;
    });
    if (asked === "question") await d.click(await d.until("confirm", () => d.find(".modal.confirm .btn.primary").catch(() => null)));
    await composeClosed();
    await d.until("draft gone", async () => helper("count", "Drafts", subj) === "0", 20000);
  });
}
