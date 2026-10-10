// Section "send" of the run (see e2e/shard.mjs for the split into parts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { profile, d, helper, screenshot, step, injectFailure, rowBySubject, openBySubject, openFolder, viewOption, textOf, setInput, altKey, invoke, idOf, press, newMessage, composeClosed, section, stamp, subject } from "../kit.mjs";

export async function run() {
  section("send");
  let sentAt = 0;
  await step("5.1", "новое письмо уходит через очередь", async () => {
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    const to = (await d.findAll(".compose .box input"))[0];
    await d.type(to, "carol@local.test\uE007");
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

  await step("5.1.2", "Ctrl+Enter, нажатый дважды, отправляет письмо один раз", async () => {
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
      // On hold the copy stays, refused 3 times, and nothing is uploaded. That nothing is tried again by
      // itself is a rule of the core (`a_copy_refused_three_times_is_put_on_hold`), no longer waited for here.
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

  await step("5.1.3", "ответ: тема, цитата, цепочка", async () => {
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

  await step("6.4.2", "поиск по тексту открытых писем, по-русски", async () => {
    const box = await d.find(".list .search input");
    await d.clear(box);
    await d.click(box);
    await d.type(box, "пятниц");
    injectFailure("6.4.2");
    await d.until("search results", async () => {
      const t = await textOf(".list");
      return t.includes("Счёт за октябрь") && t.includes("Счёт на оплату");
    }, 10000);
    await screenshot("search");
    await d.type(box, "\uE00C");
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

  await step("8.2", "письмо, открытое из карточки беседы, не закрывается, когда список обновляется", async () => {
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
}
