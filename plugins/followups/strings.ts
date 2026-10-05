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
  remindHint: { en: "Remind me if nobody replies", ru: "Напомнить, если не ответят" },
  remind0: { en: "No reminder", ru: "Без напоминания" },
  remind1: { en: "Remind in a day without a reply", ru: "Напомнить через день без ответа" },
  remind3: { en: "Remind in 3 days without a reply", ru: "Напомнить через 3 дня без ответа" },
  remind7: { en: "Remind in a week without a reply", ru: "Напомнить через неделю без ответа" },
  tag: { en: "Waiting for a reply", ru: "Ждёте ответа" },
  banner: {
    en: "You are waiting for a reply. I will remind you {when} if none comes.",
    ru: "Вы ждёте ответа. Напомню {when}, если его не будет.",
  },
  stop: { en: "Stop waiting", ru: "Не ждать" },
  overdue: {
    en: "No reply yet: the reminder was due {when}.",
    ru: "Ответа так и нет: напоминание было {when}.",
  },
  again: { en: "Write again", ru: "Написать ещё раз" },
  later: { en: "Remind tomorrow", ru: "Напомнить завтра" },
  repick: { en: "Set a new date", ru: "Назначить новый срок" },
  repickTitle: { en: "Remind again if nobody replies", ru: "Напомнить снова, если не ответят" },
  due: { en: "No answer yet: {subject}", ru: "Нет ответа: {subject}" },
  noSubject: { en: "(no subject)", ru: "(без темы)" },
  openConversation: { en: "Open the conversation", ru: "Открыть переписку" },
  gone: { en: "The letter is no longer waiting for a reply", ru: "Письмо уже не ждёт ответа" },
  custom: { en: "Custom…", ru: "Настроить…" },
  customTitle: { en: "Remind me if nobody replies", ru: "Напомнить, если не ответят" },
  inAmount: { en: "In", ru: "Через" },
  onDate: { en: "On", ru: "В дату" },
  keep: { en: "Keep in the list", ru: "Запомнить в списке" },
  apply: { en: "Done", ru: "Готово" },
  cancel: { en: "Cancel", ru: "Отмена" },
  untilDate: { en: "Remind {when} without a reply", ru: "Напомнить {when} без ответа" },
  unit: {
    minutes: { en: "minutes", ru: "минут" },
    hours: { en: "hours", ru: "часов" },
    days: { en: "days", ru: "дней" },
    workdays: { en: "working days", ru: "рабочих дней" },
  },
  settings: { en: "Reminders", ru: "Напоминания" },
  settingsNote: {
    en: "Your own choices of the “Remind me if nobody replies” list, after the standard ones. Add them with “Custom…” when writing.",
    ru: "Свои варианты списка «Напомнить, если не ответят», после стандартных. Добавляются через «Настроить…» при написании письма.",
  },
  none: { en: "None yet.", ru: "Пока нет." },
  presetName: { en: "Name", ru: "Название" },
  amount: { en: "How many", ru: "Сколько" },
  unitLabel: { en: "Of what", ru: "Чего" },
  up: { en: "Up", ru: "Выше" },
  down: { en: "Down", ru: "Ниже" },
  remove: { en: "Remove", ru: "Удалить" },
};

/** "In 2 working days without a reply": the label of a saved choice. */
export const LABEL = {
  minutes: {
    en: { one: "Remind in {n} minute without a reply", other: "Remind in {n} minutes without a reply" },
    ru: {
      one: "Напомнить через {n} минуту без ответа",
      few: "Напомнить через {n} минуты без ответа",
      other: "Напомнить через {n} минут без ответа",
    },
  },
  hours: {
    en: { one: "Remind in {n} hour without a reply", other: "Remind in {n} hours without a reply" },
    ru: {
      one: "Напомнить через {n} час без ответа",
      few: "Напомнить через {n} часа без ответа",
      other: "Напомнить через {n} часов без ответа",
    },
  },
  days: {
    en: { one: "Remind in {n} day without a reply", other: "Remind in {n} days without a reply" },
    ru: {
      one: "Напомнить через {n} день без ответа",
      few: "Напомнить через {n} дня без ответа",
      other: "Напомнить через {n} дней без ответа",
    },
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
