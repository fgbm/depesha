// The line over a letter whose sender is not confirmed, and the mailbox's switch (0.8.13).
//
// The scene opens a letter with pictures whose sender the mailbox's server says nothing about,
// so the line over the letter names the reason; then the page of the mailbox with the switch
// «Доверять по адресу, если проверить нельзя».

import { publishDkimKey, seed080 } from "./scenes-080.mjs";

/** A letter of a trusted sender with pictures: the line over it names the reason. */
export async function seedSenderTrust(kit, account, now) {
  const { db } = kit;
  await seed080(kit, account, now);
  // The sender of the letter is trusted. The stand's server checks nobody: the line over the
  // letter says the mailbox's server did not confirm the sender.
  db(`INSERT OR IGNORE INTO trusted_senders (email) VALUES ('petr@example.com');`);
}

/** The line over a letter whose sender is not confirmed, and the page of the mailbox. */
export async function senderTrustShots(kit, out) {
  const { d, sleep, textOf, shot, openBySubject, press, closeSettings } = kit;
  // The key of the signed letter: the app was restarted after the seed, and the answer lives in
  // the memory of the session that was told it.
  await publishDkimKey(kit);

  // The signed letter: the app's own check confirms it, and the brand logo stands next to it
  // in the reader and in the list (0.8.13, ступень 3). The check answers a moment after the
  // open, and the row of the list takes the verdict of the open at once: no folder change, no
  // restart (0.8.13, 4.1 Б).
  await openBySubject("Договор на подпись");
  await d.until("the check", async () => (await textOf(".reader")).includes("Договор"), 15000);
  const logoIn = (selector, subject) =>
    d.exec(`return [...document.querySelectorAll(${JSON.stringify(selector)})].some(
      (e) => e.textContent.includes(${JSON.stringify(subject)}) && e.querySelector('.avatar img, .pic img'))`);
  await d.until("the logo in the reader", () => logoIn(".reader", "Договор на подпись"), 20000);
  await d.until("the logo in the row of the list", () => logoIn(".list .row", "Договор на подпись"), 20000);
  await sleep(600);
  await shot("00-signed-letter");

  // The line over the letter: the mailbox's server did not confirm the sender.
  await openBySubject("Смета на монтаж с картинками");
  try {
    await d.until("the line", async () => (await textOf(".reader .remote")).includes("не подтвердил"), 15000);
  } catch (e) {
    console.log("  ? читалка:", JSON.stringify((await textOf(".reader")).slice(0, 600)));
    throw e;
  }
  await sleep(600);
  await shot("01-sender-line");

  // The page of the mailbox with the switch.
  await press(",", { ctrlKey: true });
  await d.until("settings", async () => (await d.findAll(".prefs")).length === 1, 15000);
  await sleep(400);
  // The page of the mailbox: «Ящики» in the menu, then the mailbox itself.
  await d.click(await d.find(".prefs .tab[data-page='accounts']"));
  await d.until("mailboxes", async () => (await d.findAll(".prefs .mbrow")).length === 1, 15000);
  await d.click(await d.find(".prefs .mbrow"));
  await d.until("the page of the mailbox", async () => (await d.findAll(".prefs [data-settings='acc-trust-by-address']")).length === 1, 15000);
  await sleep(400);
  await d.exec("document.querySelector(\"[data-settings='acc-trust-by-address']\")?.scrollIntoView({block:'center'})");
  await sleep(300);
  await shot("02-mailbox-switch");

  // The switch on: the letter of the trusted sender shows its pictures, and the line says the
  // address is not checked.
  await d.click(await d.find(".prefs [data-settings='acc-trust-by-address'] .sw"));
  await d.until("the switch is on", async () => (await d.findAll(".prefs [data-settings='acc-trust-by-address'] .sw[aria-checked='true']")).length === 1, 10000);
  await sleep(500);
  await closeSettings();
  await openBySubject("Смета на монтаж с картинками");
  try {
    await d.until("the line", async () => (await textOf(".reader .remote")).includes("Адрес не проверен"), 15000);
  } catch (e) {
    console.log("  ? читалка:", JSON.stringify((await textOf(".reader")).slice(0, 400)));
    throw e;
  }
  await sleep(600);
  await shot("03-sender-by-address");
}
