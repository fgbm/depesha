// Section "reminders" of the run (see e2e/shard.mjs for the split into parts).
import { d, helper, screenshot, step, rowBySubject, openBySubject, reloadWindow, textOf, remindBy, invoke, newMessage, composeClosed, sidebarText, section, stamp } from "../kit.mjs";

export async function run() {
  section("reminders");
  await step("5.10", "«Ждут ответа»: напоминание снимается, когда приходит ответ", async () => {
    const subj = `Вопрос ${stamp}`;
    await newMessage("carol@local.test", subj, "Когда будет готово?");
    // The reminder is chosen in the menu of «Snooze»: typed «через 3 дня», Enter; the chip shows the date.
    await remindBy("через 3 дня");
    if ((await textOf(".compose .remind")).includes("Без напоминания")) throw new Error("срок не выбран");
    await d.click(await d.find(".compose .split-btn .main"));
    await composeClosed();
    await d.until("waiting in sidebar", async () => (await sidebarText()).includes("Ждут ответа"), 60000, 1000);
    await d.button("Ждут ответа");
    await rowBySubject(subj, 20000);
    await screenshot("followups");
    helper("reply", "Sent", subj);
    // Answered: out of the active ones, kept among the closed with who replied.
    await d.until("resolved", async () => (await invoke("counters")).followups === 0, 60000, 1000);
    if (!(await sidebarText()).includes("Ждут ответа")) throw new Error("«Ждут ответа» пропал, хотя закрытое ожидание есть");
    await d.button("Закрытые");
    await rowBySubject(subj, 20000);
    await screenshot("followups-closed");
    await d.button("Активные");
  });

  await step("5.10.2", "ответ с «Без напоминания» и галочкой «Убрать письмо из входящих»: письмо в архиве, «Ждут ответа» пусто (#106)", async () => {
    const subj = `Без ожидания ${stamp}`;
    const acc = (await invoke("accounts"))[0];
    const waiting = (park) => invoke("account_save", { account: { ...acc, waiting: { park, folder: "", stop_to_archive: false } }, password: null, grant: null });
    // The mailbox that takes answered letters out of the inbox; the window reads it at start.
    await waiting(true);
    try {
      await reloadWindow();
      await d.button("Входящие");
      helper("deliver", subj);
      await d.until("letter in inbox", async () => helper("count", "INBOX", subj) === "1", 30000);
      await openBySubject(subj);
      await d.button("Ответить");
      await d.until("reply compose", async () => (await d.findAll(".compose")).length === 1);
      await d.until("the box", async () => (await d.findAll(".compose .wait-line .queue input")).length === 1);
      const text = await textOf(".compose .wait-line");
      if (!text.includes("Убрать письмо из входящих") || text.includes("до ответа")) throw new Error(`строка: ${text}`);
      if (!(await d.exec("return document.querySelector('.compose .wait-line .queue input').checked"))) throw new Error("галочка не стоит по умолчанию");
      if (!text.includes("Без напоминания")) throw new Error(`напоминание: ${text}`);
      await d.type(await d.find(".compose textarea"), "Принято.");
      await d.button("Отправить");
      await d.until("original in archive", async () => helper("count", "Архив", subj) === "1" && helper("count", "INBOX", subj) === "0", 60000, 1000);
      await d.until("toast", async () => (await textOf(".toasts")).includes("Письмо — в архиве"), 20000);
      // That no wait starts and nothing goes to «Ждут ответа» is a rule of the core
      // (`an_answer_without_a_wait_goes_to_the_archive_and_a_wait_for_its_conversation_waits_for_that`).
    } finally {
      await waiting(false);
    }
  });

}
