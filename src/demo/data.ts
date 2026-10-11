// Demo mail for the live mockup: two mailboxes, the folders of each, conversations of three
// to twelve letters, newsletters, letters with pictures and attachments, one with a long
// subject, unread, snoozed and «waiting for reply» ones. The plots are the ones the
// screenshots use (`e2e/scenes-*.mjs`, `e2e/imap_helper.py demo-seed 0.8.0`): the same
// people, the same subjects, the same mailboxes «Работа» and «Личное».
//
// Only `example.*` addresses and made-up names: no personal data. The backend
// (`src/demo/backend.ts`) copies this once and mutates the copy, so actions in the mockup
// (read, archive, delete, snooze, flag, labels) change what is on screen and are gone on
// reload.

import type {
  AccountView,
  Addr,
  AttachmentInfo,
  FolderInfo,
  Label,
  MessageRow,
  OutboxItem,
  Settings,
  Task,
} from "../lib/types";
import type { Person } from "../lib/people";

/** A letter with what the reader shows beyond its headers: the body and its attachments. */
export interface DemoLetter {
  row: MessageRow;
  /** The plain-text body; what a letter without HTML shows. */
  text: string;
  /** Sanitized HTML, as the reader puts it into its frame; pictures are `data:` URLs. */
  html: string | null;
  attachments: AttachmentInfo[];
  /** The letter references remote pictures or styles (the quiet line above the body). */
  hasRemote: boolean;
}

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const HOUR = 3600;

const WORK = "w";
const HOME = "p";

function addr(name: string | null, email: string): Addr {
  return { name, email };
}

/** A small round picture as a `data:` URL, so the reader's frame (img-src data:) draws it. */
function svgData(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

/** The round logo of a made-up company, as if the BIMI lookup had found it. */
export const LOGO_WORK = svgData(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1f6f8b"/><path d="M18 46V18h15a9 9 0 0 1 0 18H18m0 0h18a9 9 0 0 1 0 10z" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round"/></svg>`,
);
export const LOGO_HOME = svgData(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2b2b3a"/><circle cx="32" cy="27" r="13" fill="#f2b632"/><rect x="25" y="42" width="14" height="6" rx="2" fill="#f2b632"/></svg>`,
);

/** A wide picture put into a letter's HTML body, for the reader's frame. */
const PHOTO = svgData(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 240"><rect width="640" height="240" fill="#e7eef3"/><rect x="40" y="40" width="560" height="160" rx="10" fill="#cfdde7"/><path d="M60 190l120-90 90 70 110-100 160 120z" fill="#8fb3c9"/><circle cx="150" cy="80" r="18" fill="#f2b632"/></svg>`,
);

let nextId = 1000;
function id(): number {
  return ++nextId;
}

const seen = { seen: true, answered: false, flagged: false, draft: false, deleted: false, forwarded: false, answered_all: false };
const unread = { ...seen, seen: false };
const flagged = { ...seen, flagged: true };
const unreadFlagged = { ...seen, seen: false, flagged: true };

interface LetterSpec {
  account?: string;
  folder?: string;
  thread: string;
  subject: string;
  from: Addr;
  to?: Addr[];
  cc?: Addr[];
  date: number;
  size?: number;
  flags?: MessageRow["flags"];
  attachments?: AttachmentInfo[];
  hasRemote?: boolean;
  importance?: MessageRow["importance"];
  dmarc?: boolean;
  bulk?: boolean;
  text: string;
  html?: string | null;
  keywords?: string[];
  snoozed_until?: number;
  followup?: MessageRow["followup"];
  followup_due?: number | null;
  thread_voices?: MessageRow["thread_voices"];
}

function letter(s: LetterSpec): DemoLetter {
  const n = id();
  const row: MessageRow = {
    id: n,
    account_id: s.account ?? WORK,
    folder: s.folder ?? "INBOX",
    uid: n,
    message_id: `<${s.thread}-${n}@example.org>`,
    in_reply_to: null,
    references: [],
    subject: s.subject,
    from: s.from,
    to: s.to ?? [addr("Анна Крылова", "anna@example.org")],
    cc: s.cc ?? [],
    reply_to: [],
    date: s.date,
    size: s.size ?? 4096,
    flags: s.flags ?? seen,
    keywords: s.keywords ?? [],
    has_attachments: !!s.attachments?.length,
    thread: s.thread,
    bulk: s.bulk ?? false,
    thread_count: 1,
    thread_date: s.date,
    thread_size: s.size ?? 4096,
    thread_senders: [],
    thread_draft: false,
    snoozed_until: s.snoozed_until ?? null,
    followup_due: s.followup_due ?? null,
    followup: s.followup ?? null,
    marks: [],
    my_answer: null,
    outgoing: null,
    answer_came: false,
    dmarc: s.dmarc ?? false,
    importance: s.importance ?? "normal",
    thread_voices: s.thread_voices ?? [],
  };
  return { row, text: s.text, html: s.html ?? null, attachments: s.attachments ?? [], hasRemote: s.hasRemote ?? false };
}

function file(index: number, name: string, mime: string, size: number, inline = false): AttachmentInfo {
  return { index, name, mime, size, content_id: inline ? `img${index}` : null, inline };
}

const peter = addr("Пётр Соколов", "petr@example.com");
const maria = addr("Мария Лебедева", "maria@example.org");
const olga = addr("Ольга Смирнова", "olga.smirnova@example.org");
const sergey = addr("Сергей Волков", "sergey@example.net");
const billing = addr("ООО «Северстрой»", "billing@example.org");
const digest = addr("Дайджест отрасли", "news@example.net");
const anna = addr("Анна Крылова", "anna@example.org");

/** The letters of the mockup, oldest first within a thread. */
export const LETTERS: DemoLetter[] = [
  // 1. A conversation of three: the scheme, my answer, the answer to my answer.
  letter({
    thread: "smeta",
    subject: "Смета на монтаж",
    from: peter,
    date: NOW - 3 * DAY,
    size: 182_000,
    attachments: [file(0, "Смета на монтаж.pdf", "application/pdf", 182_000)],
    dmarc: true,
    text: "Анна, добрый день!\n\nПрикладываю смету на монтаж освещения. Посмотрите, пожалуйста, до пятницы — от неё зависит график поставок.\n\nПётр",
    html: `<p>Анна, добрый день!</p><p>Прикладываю смету на монтаж освещения. Посмотрите, пожалуйста, до пятницы — от неё зависит график поставок.</p><p>Пётр</p>`,
  }),
  letter({
    thread: "smeta",
    folder: "Sent",
    subject: "Re: Смета на монтаж",
    from: anna,
    to: [peter],
    date: NOW - 2 * DAY - 4 * HOUR,
    size: 5200,
    text: "Пётр, посмотрела. По монтажу освещения считаем отдельно, доставку закладываем 120 000. Ответ пришлю сегодня.\n\nАнна",
    html: `<p>Пётр, посмотрела. По монтажу освещения считаем отдельно, доставку закладываем 120 000. Ответ пришлю сегодня.</p><p>Анна</p>`,
  }),
  letter({
    thread: "smeta",
    subject: "Re: Смета на монтаж",
    from: peter,
    date: NOW - 6 * HOUR,
    size: 6100,
    flags: unread,
    dmarc: true,
    text: "Спасибо! Тогда жду итоговый вариант и схему склада. Если успеете до обеда — отлично.\n\nПётр",
    html: `<p>Спасибо! Тогда жду итоговый вариант и схему склада. Если успеете до обеда — отлично.</p><p>Пётр</p>`,
  }),

  // 1б. A longer conversation of five: the acceptance of the equipment.
  letter({
    thread: "priemka",
    subject: "Приёмка оборудования на складе",
    from: maria,
    date: NOW - 4 * DAY,
    size: 8_400,
    text: "Анна, оборудование привезли на склад. Нужен ваш человек на приёмку в четверг.\n\nМария",
    html: `<p>Анна, оборудование привезли на склад. Нужен ваш человек на приёмку в четверг.</p><p>Мария</p>`,
  }),
  letter({
    thread: "priemka",
    folder: "Sent",
    subject: "Re: Приёмка оборудования на складе",
    from: anna,
    to: [maria],
    date: NOW - 3 * DAY - 5 * HOUR,
    size: 5_200,
    text: "Мария, в четверг приедет Сергей, он всё сверит по спецификации.\n\nАнна",
  }),
  letter({
    thread: "priemka",
    subject: "Re: Приёмка оборудования на складе",
    from: sergey,
    date: NOW - 2 * DAY - 2 * HOUR,
    size: 7_100,
    text: "Анна, был на приёмке. Две позиции не совпали со спецификацией, список ниже.\n\nСергей",
    html: `<p>Анна, был на приёмке. Две позиции не совпали со спецификацией:</p><ul><li>кронштейны — 8 вместо 12;</li><li>кабель — короче на 15 метров.</li></ul><p>Сергей</p>`,
  }),
  letter({
    thread: "priemka",
    subject: "Re: Приёмка оборудования на складе",
    from: maria,
    date: NOW - 1 * DAY - 3 * HOUR,
    size: 6_000,
    flags: unread,
    text: "Сергей, поставщик согласен довезти недостающее в пятницу. Подтвердите, что примете.\n\nМария",
    html: `<p>Сергей, поставщик согласен довезти недостающее в пятницу. Подтвердите, что примете.</p><p>Мария</p>`,
  }),
  letter({
    thread: "priemka",
    folder: "Sent",
    subject: "Re: Приёмка оборудования на складе",
    from: anna,
    to: [maria, sergey],
    date: NOW - 20 * HOUR,
    size: 5_600,
    text: "Мария, Сергей, пятница подходит. Сергей, будьте на складе к десяти.\n\nАнна",
  }),

  // 2. The important letter, with the sender's mark.
  letter({
    thread: "schet",
    subject: "Счёт на оплату № 4471",
    from: billing,
    date: NOW - 5 * HOUR,
    size: 96_000,
    flags: unreadFlagged,
    importance: "high",
    dmarc: true,
    attachments: [file(0, "Счёт 4471.pdf", "application/pdf", 96_000)],
    text: "Добрый день!\n\nНаправляем счёт на оплату по договору поставки. Просим оплатить до конца недели.\n\nООО «Северстрой»",
    html: `<p>Добрый день!</p><p>Направляем счёт на оплату по договору поставки. Просим оплатить до конца недели.</p><p>ООО «Северстрой»</p>`,
  }),

  // 3. Many attachments.
  letter({
    thread: "paket",
    subject: "Пакет документов по поставке",
    from: sergey,
    date: NOW - 8 * HOUR,
    size: 4_200_000,
    attachments: [
      file(0, "Договор поставки.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 1_100_000),
      file(1, "Спецификация.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 640_000),
      file(2, "Схема склада.png", "image/png", 320_000),
      file(3, "Прайс-лист.pdf", "application/pdf", 1_800_000),
      file(4, "Заметки к встрече.md", "text/markdown", 4_000),
    ],
    text: "Анна, весь пакет по поставке во вложении: договор, спецификация, схема склада, прайс и мои заметки к встрече.\n\nСергей",
    html: `<p>Анна, весь пакет по поставке во вложении: договор, спецификация, схема склада, прайс и мои заметки к встрече.</p><p>Сергей</p>`,
  }),

  // 4. A letter with pictures in its HTML.
  letter({
    thread: "sklad",
    subject: "Схема склада и фотографии с площадки",
    from: maria,
    date: NOW - 11 * HOUR,
    size: 860_000,
    flags: unread,
    text: "Анна, выкладываю схему склада и пару кадров с площадки. Стеллажи поставили, освещение ещё нет.\n\nМария",
    html: `<p>Анна, выкладываю схему склада и пару кадров с площадки. Стеллажи поставили, освещение ещё нет.</p><p><img src="${PHOTO}" alt="Склад" width="640"></p><p>Мария</p>`,
  }),

  // 5. A newsletter (bulk), with a one-click unsubscribe.
  letter({
    thread: "digest",
    subject: "Дайджест отрасли: логистика и склады",
    from: digest,
    date: NOW - 1 * DAY - 2 * HOUR,
    size: 64_000,
    bulk: true,
    flags: { ...unread, seen: false },
    text: "Главное за неделю: цены на перевозки, новые склады, изменения в правилах.\n\nОтписаться можно одной кнопкой.",
    html: `<h2>Главное за неделю</h2><ul><li>Цены на перевозки выросли на 4%</li><li>Открылся новый склад класса A</li><li>Изменились правила приёмки</li></ul>`,
  }),
  letter({
    thread: "digest2",
    subject: "Рассылка: обновления тарифов",
    from: digest,
    date: NOW - 4 * DAY,
    size: 48_000,
    bulk: true,
    text: "С 1 числа меняются тарифы на доставку. Полный список — по ссылке.",
    html: `<p>С 1 числа меняются тарифы на доставку. Полный список — по ссылке.</p>`,
  }),

  // 6. A long subject.
  letter({
    thread: "longsubject",
    subject:
      "Согласование бюджета на второй квартал: монтаж освещения, поставка стеллажей, доставка и пусконаладка на площадке в Подольске",
    from: olga,
    date: NOW - 14 * HOUR,
    size: 22_000,
    flags: flagged,
    text: "Анна, нужен ваш ответ по бюджету на квартал. Все три части — монтаж, поставка и доставка — идут одним пакетом.\n\nОльга",
    html: `<p>Анна, нужен ваш ответ по бюджту на квартал. Все три части — монтаж, поставка и доставка — идут одним пакетом.</p><p>Ольга</p>`,
  }),

  // 7. Unread letters.
  letter({
    thread: "dates",
    subject: "Сверить даты поставки на ноябрь",
    from: maria,
    date: NOW - 40 * 60,
    size: 7_400,
    flags: unread,
    text: "Анна, сверьте, пожалуйста, даты поставки на ноябрь — у меня сходятся не все позиции.\n\nМария",
  }),
  letter({
    thread: "call",
    subject: "Созвон по складу в четверг в 15:00",
    from: sergey,
    date: NOW - 2 * HOUR,
    size: 5_200,
    flags: unread,
    text: "Анна, давайте созвонимся в четверг в 15:00 и пройдёмся по складу. Ссылку пришлю.\n\nСергей",
  }),
  letter({
    thread: "otchet",
    subject: "Отчёт за месяц по отгрузкам",
    from: olga,
    date: NOW - 3 * DAY - 6 * HOUR,
    size: 210_000,
    flags: flagged,
    attachments: [file(0, "Отчёт за месяц.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 210_000)],
    text: "Анна, отчёт за месяц во вложении. Отгрузки выросли на 12%.\n\nОльга",
  }),

  // 8. Snoozed letters.
  letter({
    thread: "remont",
    subject: "Плановый ремонт серверной",
    folder: "Отложенные",
    from: sergey,
    date: NOW - 2 * DAY,
    size: 9_100,
    snoozed_until: NOW + 2 * DAY,
    text: "Анна, в субботу плановый ремонт серверной. Доступ будет закрыт с 9 до 15.\n\nСергей",
  }),
  letter({
    thread: "snyatie",
    subject: "Снять помещение для переговоров",
    folder: "Отложенные",
    from: maria,
    date: NOW - 3 * DAY,
    size: 6_300,
    snoozed_until: NOW + 5 * DAY,
    text: "Напомню про помещение для переговоров — нужно до конца месяца.\n\nМария",
  }),

  // 9. Personal mailbox.
  letter({
    account: HOME,
    thread: "tour",
    subject: "Билеты и бронь на выходные",
    from: addr("Гостиница «Озёрная»", "book@example.net"),
    date: NOW - 7 * HOUR,
    size: 32_000,
    flags: unread,
    dmarc: true,
    text: "Подтверждаем бронь на два дня. Билеты пришлём отдельным письмом.\n\nГостиница «Озёрная»",
    html: `<p>Подтверждаем бронь на два дня. Билеты пришлём отдельным письмом.</p>`,
  }),
  letter({
    account: HOME,
    thread: "photo",
    subject: "Фотографии с дачи",
    from: addr("Дмитрий", "dmitry@example.net"),
    date: NOW - 1 * DAY - 5 * HOUR,
    size: 3_400_000,
    attachments: [file(0, "Дача.png", "image/png", 3_400_000, true)],
    text: "Смотри, какие кадры получились на выходных!\n\nДмитрий",
    html: `<p>Смотри, какие кадры получились на выходных!</p><p><img src="${PHOTO}" alt="Дача" width="640"></p>`,
  }),
  letter({
    account: HOME,
    thread: "kino",
    subject: "Пойдём в кино в субботу?",
    from: addr("Дмитрий", "dmitry@example.net"),
    date: NOW - 30 * 60,
    size: 3_100,
    flags: unread,
    text: "Есть два билета на вечер, пойдём?\n\nДмитрий",
  }),
  letter({
    account: HOME,
    thread: "shop",
    subject: "Заказ № 5521 отправлен",
    from: addr("Магазин «Товары»", "orders@example.com"),
    date: NOW - 2 * DAY - 3 * HOUR,
    size: 12_000,
    bulk: true,
    text: "Ваш заказ № 5521 отправлен. Ожидайте курьера завтра.\n\nМагазин «Товары»",
  }),

  // 10. Sent letters, two of them waiting for an answer (the «Ждут ответа» view).
  letter({
    thread: "propusk",
    folder: "Sent",
    subject: "Заявка на пропуск для подрядчиков",
    from: anna,
    to: [peter],
    date: NOW - 5400,
    size: 4_600,
    followup: {
      status: "waiting",
      due: NOW + 2 * DAY,
      deadline: NOW + 2 * DAY,
      own_deadline: false,
      repeat_secs: 0,
      expect: "",
      kind: "3 дня",
      ended: null,
      answered_by: null,
      answer: null,
      reminded: [],
      sent: NOW - 5400,
      park: "",
      park_folder: "",
      auto_reply: null,
    },
    followup_due: NOW + 2 * DAY,
    text: "Пётр, отправил заявку на пропуск для подрядчиков. Подтвердите, пожалуйста, что приняли.\n\nАнна",
  }),
  letter({
    thread: "datchiki",
    folder: "Sent",
    subject: "Проверка датчиков на складе",
    from: anna,
    to: [maria],
    date: NOW - 10 * DAY,
    size: 3_900,
    followup: {
      status: "waiting",
      due: NOW - 2 * DAY,
      deadline: NOW - 2 * DAY,
      own_deadline: false,
      repeat_secs: 0,
      expect: "",
      kind: "3 дня",
      ended: null,
      answered_by: null,
      answer: null,
      reminded: [NOW - 5 * DAY],
      sent: NOW - 10 * DAY,
      park: "",
      park_folder: "",
      auto_reply: null,
    },
    followup_due: NOW - 2 * DAY,
    text: "Мария, проверьте, пожалуйста, датчики на складе до конца недели.\n\nАнна",
  }),
  letter({
    thread: "smeta-otvet",
    folder: "Sent",
    subject: "Re: Схема склада",
    from: anna,
    to: [maria],
    date: NOW - 20 * HOUR,
    size: 5_100,
    text: "Мария, схему посмотрела, всё верно. Спасибо!\n\nАнна",
  }),

  // 11. Drafts, Trash, Spam and Archive, so every folder of the sidebar has something.
  letter({
    thread: "draft1",
    folder: "Drafts",
    subject: "Черновик: ответ по бюджету",
    from: anna,
    to: [olga],
    date: NOW - 5 * HOUR,
    size: 2_200,
    flags: { ...seen, seen: true, draft: true },
    text: "Ольга, по бюджету на квартал…\n\nАнна",
  }),
  letter({
    thread: "draft2",
    folder: "Drafts",
    subject: "Черновик: письмо подрядчику",
    from: anna,
    to: [sergey],
    date: NOW - 2 * DAY,
    size: 1_800,
    flags: { ...seen, seen: true, draft: true },
    text: "Сергей, добрый день!\n\nАнна",
  }),
  letter({
    thread: "trash1",
    folder: "Trash",
    subject: "Старое приглашение на семинар",
    from: addr("Семинары «Профи»", "info@example.com"),
    date: NOW - 12 * DAY,
    size: 18_000,
    bulk: true,
    text: "Приглашаем на семинар по логистике.\n\nСеминары «Профи»",
  }),
  letter({
    thread: "trash2",
    folder: "Trash",
    subject: "Напоминание об оплате",
    from: billing,
    date: NOW - 9 * DAY,
    size: 8_000,
    text: "Напоминаем об оплате.\n\nООО «Северстрой»",
  }),
  letter({
    thread: "spam1",
    folder: "Junk",
    subject: "Вы выиграли приз!",
    from: addr("Призы", "win@example.com"),
    date: NOW - 6 * DAY,
    size: 5_000,
    flags: unread,
    bulk: true,
    text: "Поздравляем, вы выиграли приз. Перейдите по ссылке.",
  }),
  letter({
    thread: "arch1",
    folder: "Archive",
    subject: "Договор аренды склада (архив)",
    from: sergey,
    date: NOW - 40 * DAY,
    size: 320_000,
    attachments: [file(0, "Аренда.pdf", "application/pdf", 320_000)],
    text: "Анна, договор аренды подписан, копия во вложении.\n\nСергей",
  }),
];

/** The two mailboxes: «Работа» and «Личное». */
export const ACCOUNTS: AccountView[] = [
  {
    status: { state: "online" },
    id: WORK,
    label: "Работа",
    color: "#3d7ea6",
    display_name: "Анна Крылова",
    email: "anna@example.org",
    username: "anna@example.org",
    imap: { host: "imap.example.org", port: 993, security: "tls" },
    smtp: { host: "smtp.example.org", port: 465, security: "tls" },
    save_sent_copy: true,
    signatures: [
      { id: "sig-work", name: "Рабочая", html: "<p>С уважением,<br>Анна Крылова<br>отдел ИТ, +7 495 000-00-00</p>", text: "С уважением,\nАнна Крылова\nотдел ИТ, +7 495 000-00-00" },
    ],
    default_signature: "sig-work",
    waiting: { park: false, folder: "", stop_to_archive: false },
  },
  {
    status: { state: "online" },
    id: HOME,
    label: "Личное",
    color: "#b06a3b",
    display_name: "Анна Крылова",
    email: "anna.k@example.net",
    username: "anna.k@example.net",
    imap: { host: "imap.example.net", port: 993, security: "tls" },
    smtp: { host: "smtp.example.net", port: 465, security: "tls" },
    save_sent_copy: true,
    signatures: [],
    waiting: { park: false, folder: "", stop_to_archive: false },
  },
];

function folder(account_id: string, name: string, display_name: string, role: FolderInfo["role"], total: number, unreadCount: number): FolderInfo {
  return { account_id, total, unread: unreadCount, name, display_name, delimiter: "/", role, selectable: true, hidden: false };
}

function countIn(account: string, folderName: string, unreadOnly = false): number {
  return LETTERS.filter((l) => l.row.account_id === account && l.row.folder === folderName && (!unreadOnly || !l.row.flags.seen)).length;
}

/** The folders of the two mailboxes, with the counts the sidebar shows. */
export const FOLDERS: FolderInfo[] = [
  folder(WORK, "INBOX", "Входящие", "inbox", countIn(WORK, "INBOX"), countIn(WORK, "INBOX", true)),
  folder(WORK, "Sent", "Отправленные", "sent", countIn(WORK, "Sent"), 0),
  folder(WORK, "Drafts", "Черновики", "drafts", countIn(WORK, "Drafts"), 0),
  folder(WORK, "Отложенные", "Отложенные", "snoozed", countIn(WORK, "Отложенные"), 0),
  folder(WORK, "Archive", "Архив", "archive", countIn(WORK, "Archive"), 0),
  folder(WORK, "Junk", "Спам", "junk", countIn(WORK, "Junk"), countIn(WORK, "Junk", true)),
  folder(WORK, "Trash", "Корзина", "trash", countIn(WORK, "Trash"), 0),
  folder(HOME, "INBOX", "Входящие", "inbox", countIn(HOME, "INBOX"), countIn(HOME, "INBOX", true)),
  folder(HOME, "Sent", "Отправленные", "sent", countIn(HOME, "Sent"), 0),
  folder(HOME, "Drafts", "Черновики", "drafts", countIn(HOME, "Drafts"), 0),
  folder(HOME, "Отложенные", "Отложенные", "snoozed", countIn(HOME, "Отложенные"), 0),
  folder(HOME, "Archive", "Архив", "archive", countIn(HOME, "Archive"), 0),
  folder(HOME, "Junk", "Спам", "junk", countIn(HOME, "Junk"), countIn(HOME, "Junk", true)),
  folder(HOME, "Trash", "Корзина", "trash", countIn(HOME, "Trash"), 0),
];

/** The labels of the work mailbox. */
export const LABELS: Label[] = [
  { name: "Срочно", keyword: "urgent", color: "#c42b1c", stripping: false },
  { name: "Поставка", keyword: "delivery", color: "#3d7ea6", stripping: false },
  { name: "Оплата", keyword: "payment", color: "#2e7d32", stripping: false },
];

/** The address book: one person with two spellings (the merge of the screenshots), the rest. */
export const PEOPLE: Person[] = [
  {
    id: 1,
    email: "olga.smirnova@example.org",
    emails: [
      { email: "olga.smirnova@example.org", primary: true, uses: 3, name: "Ольга Смирнова" },
      { email: "smirnova.o@example.net", primary: false, uses: 1, name: "Смирнова Ольга" },
    ],
    name: "Ольга Смирнова",
    send_format: "",
    view: "",
    note: "Согласует графики поставок. Пишет с двух адресов; лучше звонить до обеда.",
    hidden: false,
    manual: true,
    via: "",
    uses: 4,
    heard: true,
  },
  {
    id: 2,
    email: "petr@example.com",
    emails: [{ email: "petr@example.com", primary: true, uses: 2, name: "Пётр Соколов" }],
    name: "Пётр Соколов",
    send_format: "",
    view: "",
    note: "",
    hidden: false,
    manual: false,
    via: "",
    uses: 2,
    heard: true,
  },
  {
    id: 3,
    email: "maria@example.org",
    emails: [{ email: "maria@example.org", primary: true, uses: 4, name: "Мария Лебедева" }],
    name: "Мария Лебедева",
    send_format: "",
    view: "",
    note: "",
    hidden: false,
    manual: false,
    via: "",
    uses: 4,
    heard: true,
  },
  {
    id: 4,
    email: "sergey@example.net",
    emails: [{ email: "sergey@example.net", primary: true, uses: 3, name: "Сергей Волков" }],
    name: "Сергей Волков",
    send_format: "",
    view: "",
    note: "",
    hidden: false,
    manual: false,
    via: "",
    uses: 3,
    heard: true,
  },
];

/** The background tasks of the backend, as the «Задачи» window lists them. */
export const TASKS: Task[] = [
  { key: "sync:w", kind: "sync", account_id: WORK, label: "Синхронизация «Работа»", done: 42, total: 42, state: "running", started: NOW - 4 },
];

/** Letters queued in the outbox, waiting for their undo delay. */
export const OUTBOX: OutboxItem[] = [
  {
    id: 1,
    account_id: WORK,
    draft: {
      from: { name: "Анна Крылова", email: "anna@example.org" },
      to: [peter],
      cc: [],
      bcc: [],
      subject: "Смета на монтаж: итоговый вариант",
      text: "Пётр, во вложении итоговый вариант сметы.\n\nАнна",
      html: null,
      format: "plain",
      in_reply_to: null,
      references: [],
      attachments: [{ name: "Смета-итог.pdf", mime: "application/pdf", data: "" }],
    },
    attempts: 0,
    next_attempt: NOW + 8,
    last_error: null,
    failed: false,
    broken: false,
    sending_started: 0,
    created: NOW,
    followup_secs: 0,
    followup: { deadline_secs: 0, repeat_secs: 0, expect: "", kind: "" },
  },
];

/** The settings the mockup starts from: Russian, the paper theme, conversations on. */
export const SETTINGS: Settings = {
  undo_send_secs: 10,
  notify: "people",
  dnd_until: 0,
  threads: true,
  list_avatars: true,
  templates: [
    { name: "Приветствие", text: "Здравствуйте!\n\n" },
    { name: "Подпись", text: "\n\nС уважением,\nАнна" },
  ],
  updates: "auto",
  language: "ru",
  theme: "paper",
  disabled_plugins: [],
  enabled_plugins: [],
  plugin_settings: {},
  keybindings: { custom: {}, dismissed: [] },
  disabled_extensions: [],
  oauth_clients: {},
  offline: "30",
  offline_attachments: false,
  sender_logos: true,
  attachments_dir: "",
  list_sort: [],
  view_sorts: {},
  large_mb: 25,
  image_max_px: 1600,
  compose_format: "html",
  quota_warn: true,
  quota_levels: [90, 95],
  quota_repeat: "threshold",
  close_action: "ask",
  background_without_tray: false,
  autostart: "off",
  tray_count: true,
  tray_always: true,
  hints: true,
  markdown_parts_note: true,
  day_start: "9:00",
  evening_start: "18:00",
  work_days: [1, 2, 3, 4, 5],
  letter_view: "sender",
  default_account_id: null,
};
