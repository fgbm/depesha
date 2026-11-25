import type { Lang, Text } from "@depesha/plugin-api";

/** One search operator: the word the query takes, what it does, and a sample value. */
export interface Operator {
  id: string;
  ru: string;
  en: string;
  about: Text;
  /** The value after the colon; none for a word that is the whole condition. */
  sample?: { ru: string; en: string };
}

export interface Example {
  id: string;
  title: Text;
  query: { ru: string; en: string };
  about: Text;
}

export const OPERATORS: Operator[] = [
  { id: "from", ru: "от:", en: "from:", about: { ru: "Кто отправил — имя или адрес", en: "Who sent it — a name or an address" }, sample: { ru: "anna@example.com", en: "anna@example.com" } },
  { id: "to", ru: "кому:", en: "to:", about: { ru: "Кому адресовано", en: "Who it was addressed to" }, sample: { ru: "ivan@example.com", en: "ivan@example.com" } },
  { id: "subject", ru: "тема:", en: "subject:", about: { ru: "Слова в теме письма", en: "Words in the subject" }, sample: { ru: "счёт", en: "invoice" } },
  { id: "attachment", ru: "есть:вложение", en: "has:attachment", about: { ru: "Только письма с вложением", en: "Only letters with an attachment" } },
  { id: "after", ru: "после:", en: "after:", about: { ru: "Позже даты, включительно", en: "Later than the date, inclusive" }, sample: { ru: "2026-01-01", en: "2026-01-01" } },
  { id: "before", ru: "до:", en: "before:", about: { ru: "Раньше даты", en: "Earlier than the date" }, sample: { ru: "2026-11-01", en: "2026-11-01" } },
  { id: "in", ru: "в:", en: "in:", about: { ru: "Папка; звёздочка берёт подпапки", en: "A folder; an asterisk takes its subfolders" }, sample: { ru: "Работа/*", en: "Work/*" } },
  { id: "account", ru: "ящик:", en: "account:", about: { ru: "Только один ящик", en: "One mailbox only" }, sample: { ru: "anna@example.com", en: "anna@example.com" } },
  { id: "label", ru: "метка:", en: "label:", about: { ru: "Метка письма", en: "A label of the letter" }, sample: { ru: "Счета", en: "Invoices" } },
  { id: "larger", ru: "больше:", en: "larger:", about: { ru: "Больше размера: М или Г", en: "Larger than a size: M or G" }, sample: { ru: "25М", en: "25M" } },
  { id: "smaller", ru: "меньше:", en: "smaller:", about: { ru: "Меньше размера", en: "Smaller than a size" }, sample: { ru: "10М", en: "10M" } },
  { id: "older", ru: "старше:", en: "older:", about: { ru: "Старше срока: дни, месяцы, годы", en: "Older than an age: days, months, years" }, sample: { ru: "1г", en: "1y" } },
  { id: "newer", ru: "новее:", en: "newer:", about: { ru: "Новее срока", en: "Newer than an age" }, sample: { ru: "1мес", en: "1mo" } },
  { id: "year", ru: "год:", en: "year:", about: { ru: "Календарный год целиком", en: "A whole calendar year" }, sample: { ru: "2025", en: "2025" } },
  { id: "unread", ru: "это:непрочитанное", en: "is:unread", about: { ru: "Только непрочитанные", en: "Unread only" } },
  { id: "important", ru: "это:важное", en: "is:important", about: { ru: "Помеченные важными", en: "Marked important" } },
];

export const EXAMPLES: Example[] = [
  {
    id: "person-large",
    title: { ru: "Крупные письма от человека", en: "Large letters from a person" },
    query: { ru: "от:anna@example.com больше:10М", en: "from:anna@example.com larger:10M" },
    about: { ru: "От кого и размер — условия складываются", en: "Sender and size — conditions add up" },
  },
  {
    id: "invoices",
    title: { ru: "Счета с вложениями за квартал", en: "Invoices with attachments this quarter" },
    query: { ru: "тема:счёт есть:вложение после:2026-10-01", en: "subject:invoice has:attachment after:2026-10-01" },
    about: { ru: "Тема, вложение и дата вместе", en: "Subject, attachment and date together" },
  },
  {
    id: "folder-tree",
    title: { ru: "Вся папка вместе с подпапками", en: "A whole folder with its subfolders" },
    query: { ru: "в:Работа/*", en: "in:Work/*" },
    about: { ru: "Звёздочка после косой черты", en: "An asterisk after the slash" },
  },
  {
    id: "unread-person",
    title: { ru: "Непрочитанные от контакта", en: "Unread from a contact" },
    query: { ru: "от:anna@example.com это:непрочитанное", en: "from:anna@example.com is:unread" },
    about: { ru: "Адрес и состояние письма", en: "An address and the state of the letter" },
  },
  {
    id: "old-large",
    title: { ru: "Старые и большие", en: "Old and large" },
    query: { ru: "больше:25М старше:1г", en: "larger:25M older:1y" },
    about: { ru: "То, что занимает место на сервере", en: "What takes space on the server" },
  },
  {
    id: "mailbox-week",
    title: { ru: "Один ящик за неделю", en: "One mailbox for a week" },
    query: { ru: "ящик:anna@example.com после:2026-11-18", en: "account:anna@example.com after:2026-11-18" },
    about: { ru: "Ящик и дата", en: "A mailbox and a date" },
  },
];

/** How the operator stands in the query for a language. */
export function operatorText(op: Operator, lang: Lang): string {
  const word = lang === "ru" ? op.ru : op.en;
  const sample = op.sample ? (lang === "ru" ? op.sample.ru : op.sample.en) : "";
  return `${word}${sample}`;
}

export function exampleText(ex: Example, lang: Lang): string {
  return lang === "ru" ? ex.query.ru : ex.query.en;
}

function hit(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

export function filterOperators(query: string, lang: Lang): Operator[] {
  const q = query.trim();
  if (!q) return OPERATORS;
  return OPERATORS.filter(
    (op) => hit(operatorText(op, lang), q) || hit(op.about.ru, q) || hit(op.about.en, q) || hit(op.ru, q) || hit(op.en, q),
  );
}

export function filterExamples(query: string, lang: Lang): Example[] {
  const q = query.trim();
  if (!q) return EXAMPLES;
  return EXAMPLES.filter(
    (ex) => hit(exampleText(ex, lang), q) || hit(ex.title.ru, q) || hit(ex.title.en, q) || hit(ex.about.ru, q) || hit(ex.about.en, q),
  );
}
