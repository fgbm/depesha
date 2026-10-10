// Section "sendlater" of the run (see e2e/shard.mjs for the split into parts).
import { d, helper, screenshot, step, openBySubject, openFolder, textOf, setInput, newMessage, composeClosed, section, stamp } from "../kit.mjs";

export async function run() {
  section("sendlater");
  await step("5.8", "проверка перед отправкой и отмена отправки", async () => {
    const subj = `Отмена ${stamp}`;
    await newMessage("carol@local.test", subj, "Договор во вложении.");
    await d.click(await d.find(".compose .split-btn .main"));
    await d.until("attachment warning", async () => (await textOf(".compose .warnings")).includes("вложение"));
    await screenshot("preflight");
    await d.click(await d.find(".compose .warnings .btn.primary"));
    await composeClosed();
    await d.click(await d.until("undo toast", () => d.xpath("//div[contains(concat(' ', normalize-space(@class), ' '), ' toast ')][contains(., 'Отправляется')]//button[contains(@class,'act')]")));
    await d.until("compose is back", async () => (await d.findAll(".compose")).length === 1);
    const back = await d.exec("return document.querySelector('.compose .subject').value");
    if (back !== subj) throw new Error(`вернулось: ${back}`);
    await new Promise((r) => setTimeout(r, 12000));
    if (helper("count", "INBOX", subj) !== "0") throw new Error("письмо ушло, хотя отправку отменили");
    // Closing keeps it as a draft.
    await d.click(await d.find(".compose header > button:last-child"));
    await composeClosed();
  });

  await step("5.8.2", "обратный отсчёт в «Отправляется…» идёт, а не стоит (#75)", async () => {
    const subj = `Отсчёт ${stamp}`;
    await newMessage("carol@local.test", subj, "Просто текст.");
    await d.click(await d.find(".compose .split-btn .main"));
    await composeClosed();
    const toast = "//div[contains(concat(' ', normalize-space(@class), ' '), ' toast ')][contains(., 'Отправляется')]";
    const left = async () => {
      const text = await d.exec("return [...document.querySelectorAll('.toasts .toast')].map((t) => t.innerText).find((t) => t.includes('Отправляется')) ?? ''");
      const n = /ещё (\d+)/.exec(text)?.[1];
      if (n === undefined) throw new Error(`в тосте нет числа секунд: ${text}`);
      return Number(n);
    };
    await d.until("sending toast", () => d.xpath(toast));
    const first = await left();
    await new Promise((r) => setTimeout(r, 2500));
    const second = await left();
    if (!(second < first)) throw new Error(`отсчёт стоит: было ${first}, стало ${second}`);
    await d.click(await d.xpath(`${toast}//button[contains(@class,'act')]`));
    await d.until("compose is back", async () => (await d.findAll(".compose")).length === 1);
    await d.click(await d.find(".compose header > button:last-child"));
    await composeClosed();
  });

  await step("5.9.3", "«Отправить позже»: письмо ждёт в «Исходящих» своего времени", async () => {
    const subj = `Позже ${stamp}`;
    await newMessage("carol@local.test", subj, "Утром.");
    await d.click(await d.find(".compose .split-btn .more"));
    await d.click(await d.until("preset", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Завтра утром')]")));
    await composeClosed();
    await d.button("Исходящие");
    await d.until("scheduled", async () => {
      const t = await textOf(".outbox");
      return t.includes(subj) && t.includes("Запланировано: отправится завтра");
    });
    await screenshot("outbox-scheduled");
    await d.click(await d.xpath(`//div[contains(@class,'item')][contains(., ${JSON.stringify(subj)})]//button[contains(., 'Отправить сейчас')]`));
    await d.until("delivered", async () => helper("count", "INBOX", subj) === "1", 60000, 1000);
  });

  await step("5.9.4", "«Отправить позже» до получателей: время остаётся, основная кнопка планирует", async () => {
    const subj = `Сначала время ${stamp}`;
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await d.click(await d.find(".compose .split-btn .more"));
    await d.click(await d.until("preset", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Завтра утром')]")));
    await d.until("schedule kept", async () => (await textOf(".compose .scheduled")).includes("Запланировано на"));
    // Not to oneself: a draft without recipients keeps one's own address, and opening it drops that.
    await d.type((await d.findAll(".compose .box input"))[0], "dave@local.test");
    await setInput(".compose .subject", subj);
    // Closed and opened again from Drafts: the time is still there.
    await d.click(await d.find(".compose header > button:last-child"));
    await composeClosed();
    await d.until("draft on server", async () => helper("count", "Drafts", subj) === "1", 15000);
    await openFolder("Черновики");
    await openBySubject(subj);
    await d.button("Продолжить");
    await d.until("draft opened", async () => (await d.findAll(".compose")).length === 1);
    await d.until("schedule restored", async () => (await textOf(".compose .scheduled")).includes("Запланировано на"));
    await d.until("main button schedules", async () => (await textOf(".compose .split-btn .main")).includes("Запланировать"));
    await d.click(await d.find(".compose .split-btn .main"));
    await composeClosed();
    await d.button("Исходящие");
    await d.until("scheduled", async () => {
      const t = await textOf(".outbox");
      return t.includes(subj) && t.includes("Запланировано: отправится завтра");
    });
    // The queue is left empty for the steps that count on it.
    await d.click(await d.xpath(`//div[contains(@class,'item')][contains(., ${JSON.stringify(subj)})]//button[contains(., 'Отправить сейчас')]`));
    await d.until("sent", async () => !(await textOf(".outbox")).includes(subj), 60000, 1000);
  });
}
