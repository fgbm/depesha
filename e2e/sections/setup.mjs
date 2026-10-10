// The setup: the wizard adds the mailbox, the first sync is through. Every part of the run does it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { profile, d, helper, screenshot, step, rowBySubject, textOf, setInput, setSelect, invoke, composeClosed, sidebarText, stamp } from "../kit.mjs";

export async function run() {
    await step("1.1", "мастер открывается на пустом профиле", async () => {
    await d.until("wizard", async () => (await d.bodyText()).includes("Добавить почтовый ящик"));
    await screenshot("wizard");
  }, { critical: true });

  await step("1.1.2", "автоопределение и ручная правка параметров", async () => {
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

  await step("1.2.2", "проверка входа и сохранение", async () => {
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

  await step("5.9.2", "HTML-письмо с картинкой в тексте уходит с частью multipart/related", async () => {
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
}
