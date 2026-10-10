// Section "triage" of the run (see e2e/shard.mjs for the split into parts).
import { d, helper, screenshot, step, rowBySubject, openBySubject, textOf, invoke, idOf, press, sidebarText, section, stamp } from "../kit.mjs";

export async function run() {
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

  await step("1.4.2", "«Готово»: отметка «прочитано» у следующего письма не мигает, счётчик не растёт", async () => {
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

  await step("2", "«Отложить»: меню у письма; письмо, отложенное на сейчас, возвращается планировщиком непрочитанным", async () => {
    await d.button("Входящие");
    await openBySubject("Скидки недели");
    await press("h");
    await d.until("snooze menu", async () => (await textOf(".snooze .pop")).includes("Завтра"));
    await screenshot("snooze-menu");
    await press("Escape");
    // The offered times are hours away, and the time is a rule of the core (`return_due`, `due_by_account`),
    // not waited for here: the same command for this very moment. What stays is the chain that nothing else
    // covers: the snooze wakes the scheduler, it brings the letter back through the queue (`return_snoozes`).
    // The letter was read; it is unread only if the move cleared the flag on the server
    // (`a_move_with_unseen_brings_the_letter_back_unread`). Away and back: in the inbox, not in «Отложенные».
    await invoke("snooze", { ids: [await idOf("Скидки недели")], until: Math.floor(Date.now() / 1000) });
    await d.until(
      "back unread",
      async () =>
        helper("count", "INBOX", "Скидки недели") === "1" &&
        helper("count", "Отложенные", "Скидки недели") === "0" &&
        !helper("flags", "INBOX", "Скидки недели").includes("\\Seen"),
      45000,
      500,
    );
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

}
