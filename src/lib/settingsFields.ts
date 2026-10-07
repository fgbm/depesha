// What the settings search finds on the core's pages (#68): each page's sections and the
// fields in them, plus the words that also find them. The window resolves the keys with `t`
// and the pages' own titles and hands the result to searchSettings. A new page — «People»
// (#66), «Hints» (#69) — adds its fields here and comes up in the search; nothing is parsed
// out of the drawn window.

import type { Key } from "./i18n.svelte";
import type { SearchEntry } from "./settingsSearch";

export interface FieldSpec {
  /** The page this field lives on, as the window names it. */
  page: string;
  /** The section heading. */
  section: Key;
  /** The label of the field. */
  label: Key;
  /** Other words that find it. */
  also?: Key[];
  /** The section's data-settings value, to scroll to after the page opens. */
  anchor: string;
}

/** The page a hit belongs to, in the menu's order. */
export const FIELD_PAGES = ["general", "updates", "mail", "people", "notifications", "background", "offline", "keys"] as const;

export const SETTINGS_FIELDS: FieldSpec[] = [
  // General
  { page: "general", section: "settings.language", label: "settings.language", anchor: "general-language" },
  {
    page: "general",
    section: "settings.appearance",
    label: "settings.appearance",
    also: ["settings.theme.paper", "settings.theme.night", "settings.theme.system"],
    anchor: "general-appearance",
  },
  { page: "general", section: "settings.search", label: "settings.largeMail", also: ["unit.mb", "unit.gb"], anchor: "general-search" },
  {
    page: "general",
    section: "settings.hints",
    label: "hints.enable",
    also: ["hints.note", "hints.forget", "hints.what", "hints.answer"],
    anchor: "general-hints",
  },
  // Updates
  {
    page: "updates",
    section: "settings.updates",
    label: "settings.updatesAuto",
    also: ["settings.updatesNotify", "settings.updatesOff", "settings.checkNow"],
    anchor: "updates",
  },
  // Mail
  { page: "mail", section: "settings.list", label: "settings.threads", anchor: "mail-list" },
  { page: "mail", section: "settings.list", label: "settings.senderLogos", anchor: "mail-list" },
  {
    page: "mail",
    section: "settings.newMessages",
    label: "settings.composeFormat",
    also: ["format.html", "format.markdown", "format.plain"],
    anchor: "mail-new",
  },
  { page: "mail", section: "settings.newMessages", label: "settings.defaultAccount", anchor: "mail-new" },
  {
    page: "mail",
    section: "settings.reading",
    label: "settings.letterView",
    also: ["settings.letterView.markdown", "settings.letterView.text"],
    anchor: "mail-reading",
  },
  { page: "mail", section: "settings.attachmentsDir", label: "settings.attachmentsDir", anchor: "mail-attachments" },
  { page: "mail", section: "settings.sending", label: "settings.undoSend", anchor: "mail-sending" },
  { page: "mail", section: "settings.formatByPeople", label: "settings.openPeople", anchor: "mail-format" },
  // People (#66)
  { page: "people", section: "people.title", label: "people.name", anchor: "people-name" },
  {
    page: "people",
    section: "people.title",
    label: "people.sendFormat",
    also: ["format.html", "format.markdown", "format.plain", "people.asUsual"],
    anchor: "people-send",
  },
  {
    page: "people",
    section: "people.title",
    label: "people.view",
    also: ["letterView.html", "letterView.markdown", "letterView.text"],
    anchor: "people-view",
  },
  { page: "people", section: "people.title", label: "people.note", anchor: "people-note" },
  { page: "people", section: "people.title", label: "people.hide", anchor: "people-hide" },
  { page: "people", section: "people.title", label: "people.addresses", anchor: "people-addresses" },
  // Notifications
  {
    page: "notifications",
    section: "settings.notifications",
    label: "settings.notifyPeople",
    also: ["settings.notifyAll", "settings.notifyNone"],
    anchor: "notify",
  },
  { page: "notifications", section: "settings.notifications", label: "settings.quota", anchor: "quota" },
  // Background and startup
  { page: "background", section: "bg.onClose", label: "bg.onClose", anchor: "bg-close" },
  { page: "background", section: "bg.atLogin", label: "bg.atLogin", anchor: "bg-login" },
  { page: "background", section: "bg.trayIcon", label: "bg.trayIcon", anchor: "bg-tray" },
  // Offline
  {
    page: "offline",
    section: "settings.offline",
    label: "settings.offlineKeep",
    also: ["settings.offlineYear", "settings.offlineAll"],
    anchor: "offline",
  },
];

/**
 * The index the search looks in: one entry per page (so its name alone finds it) and one per
 * field. `tr` resolves an interface key; `title` gives a page's title as the window shows it.
 */
export function buildSettingsIndex(title: (page: string) => string, tr: (key: Key) => string): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const page of FIELD_PAGES) {
    const group = title(page);
    out.push({ page, group, section: "", label: group, anchor: null });
  }
  for (const f of SETTINGS_FIELDS) {
    out.push({
      page: f.page,
      group: title(f.page),
      section: tr(f.section),
      label: tr(f.label),
      synonyms: f.also?.map(tr).join(" ") ?? "",
      anchor: f.anchor,
    });
  }
  return out;
}
