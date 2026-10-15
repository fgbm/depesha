// The audit set of pictures (SHOTS_SET=audit in e2e/release-shots.mjs): every main screen of the
// app as it is now, for a review of the interface. Over mail seeded with `demo-seed audit` (the
// demo mail of 0.8.0), window 1440×900, the light theme «Бумага»; a few also in «Ночь». Each
// picture is written as <NN>-<what>.png and described in MANIFEST.md next to them. A screen
// that cannot be shot is skipped with a line in the log, the run goes on. Fit to rerun: it
// leaves the mail as it found it (archived letters are taken back, drafts are thrown away).

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { seed080 } from "./scenes-080.mjs";
import { root } from "./shot-kit.mjs";

const SIGNATURE = {
  id: "sig-work",
  name: "Рабочая",
  html: "<p>С уважением,<br>Анна Крылова<br>Отдел логистики</p>",
  text: "С уважением,\nАнна Крылова\nОтдел логистики",
};

/** Session A: the 0.8.0 seed and a signature, so a reply has the dots to fold it with the quote. */
export async function seedAudit(kit, account, now) {
  await seed080(kit, account, now);
  await kit.invoke("account_patch_own", { id: account, patch: { signatures: [SIGNATURE], default_signature: SIGNATURE.id, reply_signature: SIGNATURE.id } });
}

export async function auditShots(kit, out) {
  const { d, sleep, textOf, shot, press, invoke, openFolder, openBySubject, rowBySubject, palette, setInput, closeSettings } = kit;
  const account = (await invoke("accounts"))[0].id;
  const manifest = [];
  const skipped = [];
  /** Writes the picture and its line for MANIFEST.md. */
  const take = async (name, what, opts = {}) => {
    await shot(name, opts);
    manifest.push(`- ${name}.png — ${what}`);
  };
  /** One scene: a failure skips it with the reason and the run goes on, from a clean state. */
  const scene = async (title, fn) => {
    try {
      await fn();
    } catch (e) {
      const why = String(e?.message ?? e).split("\n")[0];
      console.log(`  ! пропущено «${title}»: ${why}`);
      skipped.push(`- ${title}: ${why}`);
      // What the window looked like at the failure, for the one who fixes the scene (E2E_DEBUG_DIR).
      if (process.env.E2E_DEBUG_DIR) writeFileSync(join(process.env.E2E_DEBUG_DIR, `${title.slice(0, 2)}-failed.png`), await d.screenshot().catch(() => Buffer.alloc(0)));
      await recover();
    }
  };
  const recover = async () => {
    await d.exec("document.activeElement?.blur?.()").catch(() => {});
    if ((await d.findAll(".compose").catch(() => [])).length) await discard().catch(() => {});
    for (let i = 0; i < 3; i++) await d.pressKey("\uE00C").catch(() => {});
    await sleep(300);
  };
  const theme = async (name) => {
    await invoke("settings_patch", { patch: { theme: name } });
    await d.exec("document.documentElement.dataset.theme = arguments[0]", name);
    await sleep(500);
  };
  /** A click with Ctrl held on the list row with this subject, or on a letter of an unfolded thread by its number. */
  const ctrlClick = (subject) =>
    d.exec(
      `const row = typeof arguments[0] === "number"
         ? document.querySelectorAll(".list .row.sub")[arguments[0]]
         : [...document.querySelectorAll(".list .row")].find((r) => r.querySelector(".subject")?.innerText.includes(arguments[0]));
       row.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));`,
      subject,
    );
  const inbox = async () => {
    await openFolder("Входящие");
    await d.until("inbox", async () => (await textOf(".list h2")).trim() === "Входящие");
    await sleep(500);
  };
  const subRows = () => d.findAll(".list .row.sub");
  const foldThreads = () => d.exec("document.querySelectorAll('.list .row .count').forEach((b) => b.closest('.row').getAttribute('aria-expanded') === 'true' && b.click())");
  const discard = async () => {
    await d.click(await d.find(".compose [aria-label='Удалить черновик']"));
    const ok = await d.until("confirm or closed", async () => (await d.find(".modal.confirm .btn.primary").catch(() => null)) || ((await d.findAll(".compose")).length === 0 ? "closed" : null), 5000).catch(() => null);
    if (ok && ok !== "closed") await d.click(ok);
    await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0, 10000);
  };

  await d.setRect(1440, 900);
  await sleep(800);
  await theme("paper");
  await inbox();

  // 01. The main window: the inbox, a letter in the reader.
  await scene("01 главное окно", async () => {
    await openBySubject("Отчёт за сентябрь");
    await sleep(1200);
    await take("01-main-light", "главное окно: список входящих, письмо «Отчёт за сентябрь» открыто в читалке; светлая тема");
    await theme("night");
    await take("01-main-dark", "то же главное окно; тёмная тема «Ночь»");
    await theme("paper");
  });

  // 02. The list with an unfolded thread, the cursor on a letter of it.
  await scene("02 список с раскрытой цепочкой", async () => {
    await d.click(await d.find(".list .viewport .row[aria-expanded] .count"));
    await d.until("thread letters", async () => (await subRows()).length > 0, 10000);
    await sleep(400);
    await d.click((await subRows())[0]);
    await sleep(1000);
    await take("02-list-thread-open", "список: цепочка «Смета на монтаж» раскрыта, курсор на письме цепочки, выбрано одно письмо; светлая тема");
  });

  // 03. Several rows chosen: two rows and a letter of the thread.
  await scene("03 множественный выбор", async () => {
    await d.click(await rowBySubject("Отчёт за сентябрь"));
    await ctrlClick("Счёт на оплату");
    await ctrlClick(1);
    await d.until("three chosen", async () => /3/.test(await textOf(".reader")), 5000);
    await sleep(600);
    await take("03-multi-select", "список с раскрытой цепочкой: выбраны две строки и одно письмо цепочки, в читалке «Выбрано 3 письма»; светлая тема");
    await foldThreads();
    await d.click(await rowBySubject("Отчёт за сентябрь"));
  });

  // 04. The reader with a conversation: one letter open, the rest folded.
  await scene("04 читалка с цепочкой", async () => {
    await foldThreads();
    await openBySubject("Смета на монтаж");
    await d.until("conversation", async () => (await d.findAll(".reader article.letter")).length > 1, 15000);
    await sleep(1200);
    await take("04-reader-thread-light", "читалка: цепочка «Смета на монтаж», одно письмо раскрыто с шапкой, остальные свёрнуты; светлая тема");
    await theme("night");
    await take("04-reader-thread-dark", "то же письмо с цепочкой; тёмная тема");
    await theme("paper");
  });

  // 05. A reply: the dots folded, then unfolded (the signature and the quote). Only a plain or
  // Markdown letter has the dots, so the format is plain for these two; the HTML reply (the
  // default format, the quote and the signature inline) is shot first.
  const reply = async () => {
    await press("r");
    await d.until("reply", async () => (await d.findAll(".compose")).length === 1, 15000);
    await sleep(1500);
    await d.exec("document.activeElement?.blur?.(); window.getSelection()?.removeAllRanges()");
    await sleep(800);
  };
  await scene("05 ответ HTML", async () => {
    await reply();
    await take("05-reply-html", "окно ответа на «Смета на монтаж» в формате HTML (формат по умолчанию): подпись и цитата в самом тексте, без «•••»; светлая тема");
    await discard();
  });
  await scene("05 окно ответа", async () => {
    await reply();
    // The format switch of the window, as the user does it.
    await d.click(await d.find(".compose footer button[aria-label='Формат письма']"));
    await d.click(await kit.menuItem("Обычный текст"));
    const sure = await d.find(".modal.confirm .btn.primary").catch(() => null);
    if (sure) await d.click(sure);
    await d.until("dots", async () => (await d.findAll(".compose .dots")).length === 1, 10000);
    await d.exec("document.activeElement?.blur?.(); window.getSelection()?.removeAllRanges()");
    await sleep(800);
    await take("05-reply-folded", "окно ответа на «Смета на монтаж» в обычном тексте: «•••» свёрнута; светлая тема");
    await d.click(await d.find(".compose .dots"));
    await sleep(800);
    await take("05-reply-unfolded", "то же окно ответа: «•••» раскрыта, видны подпись и цитата; светлая тема");
    await discard();
  });

  // 06. A new letter: empty, then with recipient chips and the open «Копия» and «Скрытая копия».
  await scene("06 новое письмо", async () => {
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await sleep(800);
    await take("06-compose-empty", "новое письмо: пустое окно; светлая тема");
    const to = await d.find(".compose .fields input");
    await d.type(to, "petr@example.com");
    await d.pressKey("");
    await d.type(to, "maria@example.org");
    await d.pressKey("");
    await d.click(await d.xpath("//div[contains(@class,'compose')]//button[contains(@class,'lnk')][normalize-space(.)='Копия']"));
    await d.click(await d.xpath("//div[contains(@class,'compose')]//button[contains(@class,'lnk')][normalize-space(.)='Скрытая копия']"));
    await d.until("cc and bcc", async () => (await d.findAll(".compose .fields input")).length >= 3, 5000);
    const fields = await d.findAll(".compose .fields input");
    await d.type(fields[1], "olga.smirnova@example.org");
    await d.pressKey("");
    await d.type(fields[2], "buy@example.org");
    await d.pressKey("");
    await setInput(".compose .subject", "График поставок на ноябрь");
    await d.exec("document.activeElement?.blur?.(); window.getSelection()?.removeAllRanges()");
    await sleep(700);
    await take("06-compose-recipients", "новое письмо: адресаты плашками в «Кому», открыты «Копия» и «Скрытая копия», заполнена тема; светлая тема");
    await discard();
  });

  // 13a. An empty folder.
  await scene("13 пустая папка", async () => {
    await openFolder("Архив");
    await d.until("archive", async () => (await textOf(".list h2")).includes("Архив"));
    await d.until("empty", async () => (await d.findAll(".list .viewport .empty")).length === 1, 15000);
    await sleep(600);
    await take("13-empty-folder", "пустая папка «Архив»: «писем нет»; светлая тема");
    await inbox();
  });

  // 07. The merged notification: four letters archived in a row.
  await scene("07 склеенное уведомление", async () => {
    await inbox();
    try {
      // Four chosen rows in one archive give the toast the equal archives in a row are joined into:
      // on the stand the archives pressed one after another stood as separate toasts (see MANIFEST.md).
      await d.click(await rowBySubject("Отчёт за сентябрь"));
      for (const subject of ["Счёт на оплату", "Пакет документов по поставке", "Планёрка в четверг"]) await ctrlClick(subject);
      await sleep(500);
      await press("e");
      await d.until("merged toast", async () => (await textOf(".toasts")).includes("В архиве: 4"), 5000);
      await take("07-toast-archived-4", "уведомление «В архиве: 4» с кнопкой «Отменить» после архивации четырёх выбранных писем одним действием (четыре архивации подряд на стенде не склеились в одно, а остались отдельными уведомлениями «В архиве»); светлая тема", { toasts: true });
    } finally {
      // Take the letters back, whatever happened: the next pictures need them in the inbox.
      for (let i = 0; i < 4; i++) {
        const back = await rowBySubject("Отчёт за сентябрь", 3000).catch(() => null);
        if (back) break;
        const undo = await d.xpath("//div[contains(@class,'toast')]//button[contains(@class,'act')]").catch(() => null);
        if (undo) await d.click(undo);
        else await press("z");
        await sleep(2500);
      }
      await d.until("letters back", async () => (await rowBySubject("Планёрка в четверг", 8000).catch(() => null)) !== null, 15000);
    }
  });

  // 08. The command palette.
  await scene("08 палитра команд", async () => {
    await press("k", { ctrlKey: true });
    await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
    await sleep(700);
    await take("08-palette", "палитра команд (Ctrl+K), открыта без запроса; светлая тема");
    await d.pressKey("\uE00C");
    await d.until("palette closed", async () => (await d.findAll(".palette")).length === 0, 5000);
  });

  // 09. The menu of a letter by Shift+F10.
  await scene("09 меню письма", async () => {
    await d.click(await rowBySubject("Отчёт за сентябрь"));
    await sleep(600);
    await press("F10", { shiftKey: true });
    await d.until("menu", async () => (await d.findAll(".pop .mi")).length > 0, 5000);
    await sleep(500);
    await take("09-row-menu", "меню письма (Shift+F10) над строкой «Отчёт за сентябрь»; светлая тема");
    await d.pressKey("\uE00C");
  });

  // 10. The search with the hints of folders.
  await scene("10 поиск", async () => {
    await press("/");
    await d.until("search focused", async () => (await d.exec("return document.activeElement?.closest('.search') ? 1 : 0")) === 1, 5000);
    await sleep(500);
    await take("10-search-ready", "поиск в фокусе, строка пустая: готовые запросы, недавние поиски, операторы; светлая тема");
    await d.type(await d.find(".search .input"), "в:");
    await d.until("suggestions", async () => (await d.findAll(".search .suggest .sg")).length > 0, 5000);
    await sleep(500);
    await take("10-search-folders", "поиск: набрано «в:», подсказки папок; светлая тема");
  });

  // 13b. A search with nothing found (shot here: the box is at hand).
  await scene("13 пустой поиск", async () => {
    await d.type(await d.find(".search .input"), "ззз");
    await d.until("nothing", async () => (await d.findAll(".list .viewport .empty")).length === 1, 15000);
    await sleep(600);
    await take("13-empty-search", "пустой результат поиска «в:ззз»: «ничего не найдено» и подсказки операторов; светлая тема");
    await d.click(await d.find(".search .clear"));
    await recover();
    await inbox();
  });

  // 11. The settings: the first page, «Клавиши», the page of a mailbox.
  await scene("11 настройки", async () => {
    await press(",", { ctrlKey: true });
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    await sleep(800);
    await take("11-settings-main", "настройки: главная страница при открытии; светлая тема");
    await d.click(await d.find(".prefs .tab[data-page='keys']"));
    await d.until("keys", async () => (await d.findAll(".prefs .kr[data-command='core.archive']")).length === 1);
    await sleep(600);
    await take("11-settings-keys", "настройки: страница «Клавиши»; светлая тема");
    await d.click(await d.find(".prefs .tab[data-page='accounts']"));
    await d.until("accounts", async () => (await d.findAll(".prefs .accounts .acc")).length > 0);
    await sleep(400);
    await take("11-settings-accounts", "настройки: страница «Почтовые ящики», список ящиков; светлая тема");
    await d.click(await d.find(".prefs .accounts .acc [aria-label='Настройки…']"));
    await d.until("account page", async () => (await textOf(".prefs")).includes("Название ящика"));
    await sleep(800);
    await take("11-settings-mailbox", "настройки: страница ящика anna@example.org; светлая тема");
    await closeSettings();
  });

  // 12. The book of people.
  await scene("12 контакты", async () => {
    await palette("перейти контакты");
    await d.until("book", async () => (await d.findAll(".people")).length === 1, 15000);
    await d.until("people", async () => (await d.findAll(".people .pr")).length > 3, 10000);
    await d.click((await d.findAll(".people .pr"))[0]);
    await sleep(900);
    await take("12-people", "экран «Контакты»: список людей, открыта карточка первого; светлая тема");
    await press("Escape");
    await inbox();
  });

  // 15. The narrow window.
  await scene("15 узкое окно", async () => {
    await d.setRect(900, 700);
    try {
    await sleep(1200);
    await take("15-narrow-list", "узкое окно 900×700: список входящих; светлая тема");
    await d.click(await rowBySubject("Отчёт за сентябрь"));
    await sleep(1200);
    await take("15-narrow-reader", "узкое окно 900×700: письмо открыто в читалке; светлая тема");
    } finally {
      await d.setRect(1440, 900);
      await sleep(1000);
    }
  });

  // 16. The English interface.
  await scene("16 английский интерфейс", async () => {
    await invoke("settings_patch", { patch: { language: "en" } });
    await sleep(1500);
    await d.click(await d.find(".list .viewport .row"));
    await sleep(1200);
    await take("16-main-en", "главное окно с английским интерфейсом, письмо открыто; светлая тема");
    await invoke("settings_patch", { patch: { language: "ru" } });
    await sleep(1000);
  });

  // 14. Errors: a wrong password in the wizard, then a mailbox that cannot connect.
  await scene("14 ошибка входа", async () => {
    await palette("добавить почтовый ящик");
    await d.until("wizard", async () => (await d.bodyText()).includes("Добавить почтовый ящик"), 15000);
    await setInput(".wizard input[placeholder='Иван Петров']", "Анна Крылова");
    await setInput(".wizard input[type=email]", "anna.second@example.org");
    await setInput(".wizard input[type=password]", "wrong-password");
    await d.button("Далее");
    await d.until("settings step", async () => (await d.bodyText()).includes("Входящая почта (IMAP)"), 30000);
    await setInput(".wizard input[placeholder^='адрес или']", "carol");
    await kit.setSelect(".wizard fieldset:nth-of-type(1) .select", "plain");
    await kit.setSelect(".wizard fieldset:nth-of-type(2) .select", "plain");
    const hosts = await d.findAll(".wizard fieldset .host input");
    const ports = await d.findAll(".wizard fieldset .port input");
    for (const [i, [host, port]] of [["127.0.0.1", 3143], ["127.0.0.1", 3025]].entries()) {
      await d.clear(hosts[i]);
      await d.type(hosts[i], host);
      await d.clear(ports[i]);
      await d.type(ports[i], String(port));
    }
    await d.button("Проверить и сохранить");
    await sleep(6000);
    await d.exec("document.activeElement?.blur?.(); [...document.querySelectorAll('.prefs *')].find((e) => !e.children.length && e.innerText?.includes('отклонил вход'))?.scrollIntoView({ block: 'end' })");
    await sleep(400);
    await take("14-error-login", "мастер добавления ящика: неверный пароль, ошибка входа под полями; светлая тема");
    await d.exec("document.querySelector('.wizard')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await recover();
  });

  await scene("14 ящик без сети", async () => {
    const compose = (...args) => execFileSync("docker", ["compose", "-f", join(root, "compose.test.yaml"), ...args], { stdio: "ignore" });
    compose("stop", "greenmail");
    try {
      // The connection drops, the next fetch fails: ask for it, as «Обновить» does.
      await d.until("problem line", async () => {
        await invoke("sync_now", { accountId: account, folder: null }).catch(() => {});
        const state = (await invoke("accounts"))[0]?.status?.state;
        console.log(`  · состояние ящика: ${state}`);
        return state === "error" || state === "paused";
      }, 90000, 3000);
      await sleep(800);
      await take("14-error-offline", "ящик без сети (сервер остановлен): под именем ящика в боковой панели строка ошибки с «Повторить»; светлая тема");
    } finally {
      compose("start", "greenmail");
    }
  });

  writeFileSync(join(out, "MANIFEST.md"), manifestText(manifest, skipped));
}

function manifestText(lines, skipped) {
  return [
    "# Кадры приложения для аудита UX/UI",
    "",
    "Снято `SHOTS_SET=audit scripts/release-shots.sh` с `origin/main`. Окно 1440×900, если не сказано иное; светлая тема «Бумага», тёмная — «Ночь». Демо-почта: ящик anna@example.org, 0.8.0.",
    "",
    "## Кадры",
    "",
    ...lines,
    "",
    "## Пропущено",
    "",
    ...(skipped.length ? skipped : ["- ничего из списка не пропущено; экраны «Контакты» и «Люди» — один (12), «Люди» отдельного экрана нет"]),
    "",
    "## Примечания",
    "",
    "- 05: «•••» есть только в письме в обычном тексте и в Markdown; в HTML цитата и подпись стоят в самом тексте (05-reply-html). Строка «Письмо уйдёт только как …» над нижней панелью — подсказка окна о формате, которую приложение показало само.",
    "- 07: четыре архивации подряд на стенде не склеились в одно уведомление (каждая дала своё «В архиве»), хотя тесты это обещают. Кадр снят с архивацией четырёх выбранных писем одним действием; стоит проверить склейку руками.",
    "- 14: два кадра — неверный пароль в мастере добавления ящика и ящик, к которому нет сети (сервер стенда остановлен), с плашкой ошибки и «Повторить» в боковой панели.",
    "- 15 и 16: окно 900×700 даёт узкую раскладку с боковой полосой вместо панели папок; английский интерфейс снят над той же русской демо-почтой.",
    "",
  ].join("\n");
}
