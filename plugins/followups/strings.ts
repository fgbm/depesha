// What "Waiting for reply" says, in English and Russian. Plural tables are by
// Intl.PluralRules category; `{n}` is the number.

export const S = {
  name: { en: "Waiting for reply", ru: "Ждут ответа" },
  about: {
    en: "Ask for a reminder when sending; it clears itself once the answer arrives.",
    ru: "При отправке можно попросить напомнить; напоминание снимется само, когда придёт ответ.",
  },
  view: { en: "Waiting for reply", ru: "Ждут ответа" },
  empty: {
    en: "Nobody owes you an answer. When sending, you can ask to be reminded if nobody replies.",
    ru: "Никто не должен вам ответ. При отправке можно попросить напомнить, если не ответят.",
  },
  emptyClosed: {
    en: "Answered waits and the ones you stopped stay here for {n} days.",
    ru: "Здесь {n} дней хранятся ожидания, на которые ответили или которые вы закрыли.",
  },
  tabs: {
    active: { en: "Active", ru: "Активные" },
    closed: { en: "Closed", ru: "Закрытые" },
  },
  closedCmd: { en: "Waiting for reply: closed", ru: "Ждут ответа: закрытые" },

  // The compose window.
  remindHint: { en: "Remind me if nobody replies", ru: "Напомнить, если не ответят" },
  remind0: { en: "No reminder", ru: "Без напоминания" },
  remind1: { en: "Remind in a day without a reply", ru: "Напомнить через день без ответа" },
  remind3: { en: "Remind in 3 days without a reply", ru: "Напомнить через 3 дня без ответа" },
  remind7: { en: "Remind in a week without a reply", ru: "Напомнить через неделю без ответа" },
  custom: { en: "Custom…", ru: "Настроить…" },
  // The reminder takes the Snooze menu (#103): the line, the calendar's button and the saved choices.
  remindPlaceholder: { en: "When to remind: “Fri 9:00”, “in 3 days”", ru: "Когда напомнить: «пт 9:00», «через 3 дня»" },
  remindPick: { en: "Remind", ru: "Напомнить" },
  passedMark: { en: "· passed", ru: "· прошёл" },
  passedHint: { en: "This date has passed: the reminder will come a minute after the letter leaves", ru: "Этот срок уже прошёл: напоминание придёт через минуту после отправки письма" },
  savedChoices: { en: "Saved", ru: "Сохранённые" },
  customTitle: { en: "Remind me if nobody replies", ru: "Напомнить, если не ответят" },
  untilDate: { en: "Remind {when} without a reply", ru: "Напомнить {when} без ответа" },
  lineWhen: { en: "I will remind you {when}", ru: "Напомню {when}" },
  lineBy: { en: "Reply needed by", ru: "Ответ нужен к" },
  lineThen: { en: "· I will remind you {when}", ru: "· напомню {when}" },
  lineIfNone: { en: "if nobody replies", ru: "если не ответят" },
  lineIf: { en: "if no reply comes from", ru: "если не ответит" },
  fromAnyone: { en: "anyone of the recipients", ru: "любой из получателей" },
  fromTitle: { en: "Wait for a reply from", ru: "Ждать ответа от" },

  // "Custom…" and "Set a new date".
  modes: {
    amount: { en: "In", ru: "Через" },
    date: { en: "On a date", ru: "В дату" },
    weekday: { en: "On a weekday", ru: "В день недели" },
  },
  atTime: { en: "at", ru: "в" },
  repeatOnce: { en: "then every", ru: "потом каждые" },
  repeatTail: { en: "until a reply", ru: "до ответа" },
  keep: { en: "Keep in the list", ru: "Запомнить в списке" },
  apply: { en: "Done", ru: "Готово" },
  cancel: { en: "Cancel", ru: "Отмена" },
  repickTitle: { en: "Remind again if nobody replies", ru: "Напомнить снова, если не ответят" },
  unit: {
    minutes: { en: "minutes", ru: "минут" },
    hours: { en: "hours", ru: "часов" },
    days: { en: "days", ru: "дней" },
    workdays: { en: "working days", ru: "рабочих дней" },
  },
  weekdays: [
    { en: "Sunday", ru: "воскресенье" },
    { en: "Monday", ru: "понедельник" },
    { en: "Tuesday", ru: "вторник" },
    { en: "Wednesday", ru: "среда" },
    { en: "Thursday", ru: "четверг" },
    { en: "Friday", ru: "пятница" },
    { en: "Saturday", ru: "суббота" },
  ],

  // The banner over a letter.
  waiting: { en: "You are waiting for a reply.", ru: "Вы ждёте ответа." },
  waitingBy: { en: "A reply is needed by {when}.", ru: "Ответ нужен к {when}." },
  willRemind: { en: "I will remind you {when} if none comes.", ru: "Напомню {when}, если его не будет." },
  overdueReminder: { en: "No reply yet: the reminder was {when}.", ru: "Ответа так и нет: напоминание было {when}." },
  overdueDeadline: { en: "No reply yet: it was needed by {when}.", ru: "Ответа так и нет: ответ был нужен к {when}." },
  onlyFrom: { en: "Only a reply from {who} counts.", ru: "Засчитается только ответ от получателя {who}." },
  answered: { en: "The reply came {when}: {who}.", ru: "Ответ получен {when}: {who}." },
  answeredAnon: { en: "The reply came {when}.", ru: "Ответ получен {when}." },
  closed: { en: "You stopped waiting for a reply {when}.", ru: "Ожидание ответа закрыто вручную {when}." },
  again: { en: "Write again", ru: "Написать ещё раз" },
  later: { en: "Remind tomorrow", ru: "Напомнить завтра" },
  repick: { en: "Set a new date", ru: "Назначить новый срок" },
  stop: { en: "Stop waiting", ru: "Не ждать" },
  // The toast after it (#98), as "Bring back now" has one: what it did and how to take it back.
  stopped: { en: "No longer waiting for a reply: {what}", ru: "Не ждём ответа: {what}" },
  stoppedMany: { en: { one: "{n} message", other: "{n} messages" }, ru: { one: "{n} письмо", few: "{n} письма", other: "{n} писем" } },
  undo: { en: "Undo", ru: "Отменить" },
  resumeFailed: { en: "Could not take it back: the wait has already changed", ru: "Не удалось вернуть: ожидание уже изменилось" },
  // A letter waiting in the folder (#59).
  comesBack: { en: "The letter comes back to the inbox when they reply.", ru: "Письмо вернётся во «Входящие», когда ответят." },
  unpark: { en: "Back to the inbox", ru: "Вернуть во входящие" },
  remindMe: { en: "Remind me…", ru: "Напомнить…" },
  openAnswer: { en: "Open the reply", ru: "Открыть ответ" },
  waitAgain: { en: "Wait for a reply again", ru: "Снова ждать ответа" },
  history: { en: "Reminder history", ru: "История напоминаний" },
  next: { en: "Next", ru: "Следующее" },
  nextRepeat: { en: "{when}, and so on until a reply", ru: "{when}, и так до ответа" },
  choice: { en: "Choice", ru: "Вариант" },
  sentAt: { en: "Sent", ru: "Отправлено" },
  neverReminded: { en: "Reminded", ru: "Напоминали" },
  notYet: { en: "not yet", ru: "ещё нет" },

  // The row of a list.
  answeredTag: { en: "replied: {who}, {when}", ru: "ответ: {who}, {when}" },
  answeredTagAnon: { en: "replied {when}", ru: "ответили {when}" },
  closedTag: { en: "closed by hand {when}", ru: "закрыто вручную {when}" },
  deadlineNote: { en: "due {when}", ru: "срок {when}" },
  goingTag: { en: "to “Waiting for reply”", ru: "в «Ждут ответа»" },
  goingLaterTag: { en: "goes to “Waiting for reply” {when}", ru: "уйдёт в «Ждут ответа» {when}" },
  cameTag: { en: "reply came", ru: "пришёл ответ" },
  sinceTag: { en: "waiting since {when}", ru: "ждём с {when}" },
  sinceToday: { en: "waiting since today", ru: "ждём с сегодня" },
  sinceYesterday: { en: "waiting since yesterday", ru: "ждём со вчера" },
  autoTag: { en: "auto-reply {when}: does not count", ru: "автоответ {when} — не в счёт" },

  // The compose window: the letter answered leaves the inbox.
  queueBox: { en: "Take the letter out of the inbox", ru: "Убрать письмо из входящих" },
  queueChainTitle: { en: "Together with the read letters of this conversation", ru: "Вместе с прочитанными письмами этой переписки" },
  queueGoesToWait: { en: "The letter goes to “Waiting for reply”", ru: "Письмо уйдёт в «Ждут ответа»" },
  queueNoArchive: { en: "The mailbox has no archive folder", ru: "У ящика нет папки архива" },
  queueWaiting: { en: "The letter is waiting for a reply already", ru: "Письмо уже ждёт ответа" },
  queueStays: { en: "The letter is in the folder “{folder}” and stays there", ru: "Письмо в папке «{folder}», останется там" },
  queueStaysTitle: {
    en: "Only letters of the inbox are taken out. This one stays in the folder “{folder}”.",
    ru: "Убираются только письма из «Входящих». Это письмо останется в папке «{folder}».",
  },

  // The notification.
  due: { en: "No answer yet: {subject}", ru: "Нет ответа: {subject}" },
  noSubject: { en: "(no subject)", ru: "(без темы)" },
  openConversation: { en: "Open the conversation", ru: "Открыть переписку" },
  gone: { en: "The letter is no longer waiting for a reply", ru: "Письмо уже не ждёт ответа" },

  // Settings.
  settings: { en: "Reminders", ru: "Напоминания" },
  settingsNote: {
    en: "Your own choices of the “Remind me if nobody replies” list, after the standard ones. Add them here or with “Custom…” when writing.",
    ru: "Свои варианты списка «Напомнить, если не ответят», после стандартных. Добавляются здесь или через «Настроить…» при написании письма.",
  },
  add: { en: "Add a choice", ru: "Добавить вариант" },
  none: { en: "None yet.", ru: "Пока нет." },
  presetName: { en: "Name", ru: "Название" },
  amount: { en: "How many", ru: "Сколько" },
  unitLabel: { en: "Of what", ru: "Чего" },
  kindLabel: { en: "When to remind", ru: "Когда напомнить" },
  kinds: {
    after: { en: "In", ru: "Через" },
    weekday: { en: "Next", ru: "В ближайший" },
    before: { en: "Before the deadline", ru: "До срока" },
  },
  every: { en: "every", ru: "каждые" },
  repeatLabel: { en: "Remind again until a reply", ru: "Повторять до ответа" },
  up: { en: "Up", ru: "Выше" },
  down: { en: "Down", ru: "Ниже" },
  remove: { en: "Remove", ru: "Удалить" },
  keepClosed: { en: "Keep closed waits for", ru: "Хранить закрытые ожидания" },
  keepDays: { en: "days", ru: "дней" },
};

/** "Remind in 2 working days without a reply": the label of a saved choice. */
export const LABEL = {
  minutes: {
    en: { one: "Remind in {n} minute without a reply", other: "Remind in {n} minutes without a reply" },
    ru: { one: "Напомнить через {n} минуту без ответа", few: "Напомнить через {n} минуты без ответа", other: "Напомнить через {n} минут без ответа" },
  },
  hours: {
    en: { one: "Remind in {n} hour without a reply", other: "Remind in {n} hours without a reply" },
    ru: { one: "Напомнить через {n} час без ответа", few: "Напомнить через {n} часа без ответа", other: "Напомнить через {n} часов без ответа" },
  },
  days: {
    en: { one: "Remind in {n} day without a reply", other: "Remind in {n} days without a reply" },
    ru: { one: "Напомнить через {n} день без ответа", few: "Напомнить через {n} дня без ответа", other: "Напомнить через {n} дней без ответа" },
  },
  workdays: {
    en: { one: "Remind in {n} working day without a reply", other: "Remind in {n} working days without a reply" },
    ru: {
      one: "Напомнить через {n} рабочий день без ответа",
      few: "Напомнить через {n} рабочих дня без ответа",
      other: "Напомнить через {n} рабочих дней без ответа",
    },
  },
};

/** "2 days left" and "3 days overdue": the tag of a row waiting for a reply. */
export const LEFT = {
  minutes: {
    en: { one: "{n} minute left", other: "{n} minutes left" },
    ru: { one: "осталась {n} минута", few: "осталось {n} минуты", other: "осталось {n} минут" },
  },
  hours: {
    en: { one: "{n} hour left", other: "{n} hours left" },
    ru: { one: "остался {n} час", few: "осталось {n} часа", other: "осталось {n} часов" },
  },
  days: {
    en: { one: "{n} day left", other: "{n} days left" },
    ru: { one: "остался {n} день", few: "осталось {n} дня", other: "осталось {n} дней" },
  },
};

export const LATE = {
  minutes: {
    en: { one: "{n} minute overdue", other: "{n} minutes overdue" },
    ru: { one: "просрочено на {n} минуту", few: "просрочено на {n} минуты", other: "просрочено на {n} минут" },
  },
  hours: {
    en: { one: "{n} hour overdue", other: "{n} hours overdue" },
    ru: { one: "просрочено на {n} час", few: "просрочено на {n} часа", other: "просрочено на {n} часов" },
  },
  days: {
    en: { one: "{n} day overdue", other: "{n} days overdue" },
    ru: { one: "просрочено на {n} день", few: "просрочено на {n} дня", other: "просрочено на {n} дней" },
  },
};

/** "Remind next Monday at 9:00": the label of a choice on a day of the week. */
export const NEXT_DAY = [
  { en: "Remind next Sunday at {time}", ru: "Напомнить в ближайшее воскресенье в {time}" },
  { en: "Remind next Monday at {time}", ru: "Напомнить в ближайший понедельник в {time}" },
  { en: "Remind next Tuesday at {time}", ru: "Напомнить в ближайший вторник в {time}" },
  { en: "Remind next Wednesday at {time}", ru: "Напомнить в ближайшую среду в {time}" },
  { en: "Remind next Thursday at {time}", ru: "Напомнить в ближайший четверг в {time}" },
  { en: "Remind next Friday at {time}", ru: "Напомнить в ближайшую пятницу в {time}" },
  { en: "Remind next Saturday at {time}", ru: "Напомнить в ближайшую субботу в {time}" },
];

/** "Remind 2 days before the deadline". */
export const BEFORE = {
  days: {
    en: { one: "Remind {n} day before the deadline", other: "Remind {n} days before the deadline" },
    ru: { one: "Напомнить за {n} день до срока", few: "Напомнить за {n} дня до срока", other: "Напомнить за {n} дней до срока" },
  },
  workdays: {
    en: { one: "Remind {n} working day before the deadline", other: "Remind {n} working days before the deadline" },
    ru: {
      one: "Напомнить за {n} рабочий день до срока",
      few: "Напомнить за {n} рабочих дня до срока",
      other: "Напомнить за {n} рабочих дней до срока",
    },
  },
};

export const BEFORE_DAY = { en: "Remind a day before the deadline", ru: "Напомнить за сутки до срока" };

/** "Every 3 days until a reply": a choice that comes again as often as it first comes. */
export const EVERY_LABEL = {
  minutes: {
    en: { one: "Every {n} minute until a reply", other: "Every {n} minutes until a reply" },
    ru: { one: "Каждую {n} минуту до получения ответа", few: "Каждые {n} минуты до получения ответа", other: "Каждые {n} минут до получения ответа" },
  },
  hours: {
    en: { one: "Every {n} hour until a reply", other: "Every {n} hours until a reply" },
    ru: { one: "Каждый {n} час до получения ответа", few: "Каждые {n} часа до получения ответа", other: "Каждые {n} часов до получения ответа" },
  },
  days: {
    en: { one: "Every {n} day until a reply", other: "Every {n} days until a reply" },
    ru: { one: "Каждый {n} день до получения ответа", few: "Каждые {n} дня до получения ответа", other: "Каждые {n} дней до получения ответа" },
  },
};

/** The same, once a period: "Every day until a reply". */
export const EVERY_ONE = {
  minutes: { en: "Every minute until a reply", ru: "Каждую минуту до получения ответа" },
  hours: { en: "Every hour until a reply", ru: "Каждый час до получения ответа" },
  days: { en: "Every day until a reply", ru: "Каждый день до получения ответа" },
};

/** "…, then every 2 days": a repeat after another first reminder. */
export const THEN = {
  minutes: {
    en: { one: "{label}, then every {n} minute", other: "{label}, then every {n} minutes" },
    ru: { one: "{label}, потом каждую {n} минуту", few: "{label}, потом каждые {n} минуты", other: "{label}, потом каждые {n} минут" },
  },
  hours: {
    en: { one: "{label}, then every {n} hour", other: "{label}, then every {n} hours" },
    ru: { one: "{label}, потом каждый {n} час", few: "{label}, потом каждые {n} часа", other: "{label}, потом каждые {n} часов" },
  },
  days: {
    en: { one: "{label}, then every {n} day", other: "{label}, then every {n} days" },
    ru: { one: "{label}, потом каждый {n} день", few: "{label}, потом каждые {n} дня", other: "{label}, потом каждые {n} дней" },
  },
};

export const THEN_ONE = {
  minutes: { en: "{label}, then every minute", ru: "{label}, потом каждую минуту" },
  hours: { en: "{label}, then every hour", ru: "{label}, потом каждый час" },
  days: { en: "{label}, then every day", ru: "{label}, потом каждый день" },
};

/** ", then every 3 days until a reply": the repeat in the line of the compose window. */
export const LINE_REPEAT = {
  minutes: {
    en: { one: ", then every {n} minute until a reply", other: ", then every {n} minutes until a reply" },
    ru: { one: ", потом каждую {n} минуту до ответа", few: ", потом каждые {n} минуты до ответа", other: ", потом каждые {n} минут до ответа" },
  },
  hours: {
    en: { one: ", then every {n} hour until a reply", other: ", then every {n} hours until a reply" },
    ru: { one: ", потом каждый {n} час до ответа", few: ", потом каждые {n} часа до ответа", other: ", потом каждые {n} часов до ответа" },
  },
  days: {
    en: { one: ", then every {n} day until a reply", other: ", then every {n} days until a reply" },
    ru: { one: ", потом каждый {n} день до ответа", few: ", потом каждые {n} дня до ответа", other: ", потом каждые {n} дней до ответа" },
  },
};

/** "Reminded twice: 3 Oct, 10:14; 4 Oct, 10:14": the history in the banner. */
export const REMINDED = {
  en: { one: "Reminded {n} time", other: "Reminded {n} times" },
  ru: { one: "Напоминали {n} раз", few: "Напоминали {n} раза", other: "Напоминали {n} раз" },
};
