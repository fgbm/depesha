// The pictures of the meeting card (0.8.13): an invitation, its cancellation, its update, the
// same card in a narrow window and in a letter unfolded inside the chain, in the light and the
// dark «Чернила». The letters are delivered as an Exchange invitation comes, and the update is
// compared with the invitation read before it (7.1 А), so the earlier letter is opened first.
//
//   SHOTS_OUT=… DEPESHA_APP=… e2e/keyring.sh node e2e/meeting-shots.mjs
//
// Needs the stand and a debug build with `--features e2e` (e2e/README.md); the driver and the
// profile are the ones of e2e/shot-kit.mjs.

import { ensureStandLock } from "./stand-lock.mjs";
import { createKit } from "./shot-kit.mjs";

ensureStandLock();
const out = process.env.SHOTS_OUT ?? "/tmp/depesha-meeting-shots";
const kit = createKit({ out, tag: "depesha-ics-", v8: true });
const { d, sleep, helper, shot, invoke, openBySubject, rowBySubject } = kit;

// The letters of one run: the subject carries the moment of the run, so a stand that keeps the
// mail of the last run does not mix its letters with these.
const stamp = Date.now().toString(36);
const INVITE = `Планёрка по выпуску ${stamp}`;
const CANCEL = `Отмена планёрки ${stamp}`;
const UPDATE = `Перенос планёрки ${stamp}`;

/** Opens a letter of the inbox by its subject and waits for the card to stand in the pane. */
async function open(subject) {
  await d.button("Входящие");
  await rowBySubject(subject, 30000);
  await openBySubject(subject);
  await d.until(`card of ${subject}`, () => d.exec("return !!document.querySelector('.reader .cal')"), 20000);
  await sleep(400);
}

/** Waits until the list shows the conversation of two letters: the cache has the update by then,
 *  and the row of the conversation stands for its newest letter. */
const twoLetters = (subject) =>
  d.until(`conversation of two, "${subject}"`, async () => {
    const badge = await d.exec(
      `const row = [...document.querySelectorAll(".list .row")].find((r) => r.innerText.includes(arguments[0]));
       return row?.querySelector(".count")?.innerText.trim() ?? "";`,
      subject,
    );
    return badge === "2" ? true : null;
  }, 30000);

/** Opens the later letter of the conversation — the update, whose card says «Изменено». */
async function openLater(subject) {
  await d.button("Входящие");
  await rowBySubject(subject, 30000);
  await twoLetters(subject);
  await openBySubject(subject);
  await d.until("the card of the update", async () =>
    (await d.exec("return document.querySelector('.reader .cal-h')?.innerText ?? ''")).toLowerCase().includes("изменено"),
  20000);
  await sleep(500);
}

async function theme(scheme) {
  await invoke("settings_set", { settings: { ...(await invoke("settings_get")), theme: scheme, look: "ink" } });
  await d.exec("document.documentElement.dataset.theme = arguments[0]", `ink-${scheme}`);
  await sleep(500);
}

try {
  await kit.boot({
    prepare: async () => {
      helper("deliver-invite", INVITE);
      helper("deliver-invite-cancel", CANCEL);
      helper("deliver-invite", UPDATE);
      await invoke("settings_set", { settings: { ...(await invoke("settings_get")), theme: "light", look: "ink", language: "ru" } });
    },
  });

  await d.setRect(1280, 860);
  await sleep(600);
  await theme("light");

  // The invitation: the card on the place of the file's chip, the chip itself gone (1.1 А).
  await open(INVITE);
  await shot("01-invitation-light");
  await theme("dark");
  await shot("02-invitation-dark");

  // The cancellation: a red frame, the time struck through (6.1 А).
  await theme("light");
  await open(CANCEL);
  await shot("03-cancelled-light");
  await theme("dark");
  await shot("04-cancelled-dark");

  // The update: the invitation read first, so that the card has something to compare with.
  await theme("light");
  await open(UPDATE);
  helper("deliver-invite-update", UPDATE);
  await d.until("update arrives", async () => helper("count", "INBOX", UPDATE) === "2", 30000);
  await openLater(UPDATE);
  await shot("05-updated-light");
  await theme("dark");
  await shot("06-updated-dark");

  // A narrow window: the title and the time wrap, the button of the calendar takes the row.
  await theme("light");
  await d.setRect(480, 860);
  await sleep(800);
  await shot("07-narrow-light");
  await theme("dark");
  await shot("08-narrow-dark");
  await d.setRect(1280, 860);

  // A letter of the chain, unfolded: the same card stands in it, and its `.ics` is no chip (1.1 А).
  await theme("light");
  await sleep(600);
  await d.click(await d.find(".thread article.letter .head"));
  await d.until("the card of the earlier letter", () => d.exec("return !!document.querySelector('.thread article.letter .cal')"), 20000);
  await sleep(500);
  await shot("09-thread-light");
  await theme("dark");
  await shot("10-thread-dark");
} finally {
  await kit.finish();
}
