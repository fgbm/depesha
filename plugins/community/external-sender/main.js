// Mail from another domain than the account's gets a banner. Personal mailboxes
// (gmail.com, yandex.ru...) are skipped: there everyone is "external".
const PUBLIC = new Set(["gmail.com", "googlemail.com", "yandex.ru", "ya.ru", "mail.ru", "bk.ru", "list.ru",
  "inbox.ru", "outlook.com", "hotmail.com", "icloud.com", "me.com", "yahoo.com", "proton.me", "rambler.ru"]);

const domain = (email) => (email || "").split("@").pop().toLowerCase();

depesha.on("messageOpen", (message) => {
  const mine = domain(message.account);
  const theirs = domain(message.from && message.from.email);
  if (!mine || !theirs || PUBLIC.has(mine) || theirs === mine || theirs.endsWith("." + mine)) return null;
  const text = depesha.lang === "ru"
    ? `письмо пришло извне, с домена ${theirs}. Не открывайте ссылки и вложения, если не ждали его.`
    : `this message comes from outside, from ${theirs}. Do not open links or attachments you did not expect.`;
  return { banner: { tone: "warn", text } };
});
