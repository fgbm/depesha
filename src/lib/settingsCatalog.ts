// What the settings window shows (#102): the pages of the menu, the groups on each and the
// rows in a group, described as data. SettingsPage.svelte draws every row from its kind with
// the one set of controls, the search reads the same list, and a page to come (avatars #108,
// importance #72) is a few lines here: a row, in the group it belongs to. The row's key is
// a field of `Settings`; its id is what the search scrolls to and the e2e steps look for.

import type { Component } from "svelte";
import Bell from "@lucide/svelte/icons/bell";
import BookOpen from "@lucide/svelte/icons/book-open";
import Clock from "@lucide/svelte/icons/clock";
import HardDrive from "@lucide/svelte/icons/hard-drive";
import Inbox from "@lucide/svelte/icons/inbox";
import Keyboard from "@lucide/svelte/icons/keyboard";
import Palette from "@lucide/svelte/icons/palette";
import Power from "@lucide/svelte/icons/power";
import Puzzle from "@lucide/svelte/icons/puzzle";
import SquarePen from "@lucide/svelte/icons/square-pen";
import Users from "@lucide/svelte/icons/users";
import { accountLabel } from "./format";
import { t, tn } from "./i18n.svelte";
import type { NumberSpec, RowKind } from "./settingsRows";
import type { AccountView, Settings } from "./types";

export interface Option {
  value: string | number;
  label: () => string;
  /** Said under the row while this option is the chosen one (never for all of them at once). */
  desc?: () => string;
}

/** What a row may ask of the window to know about the rest of the app. */
export interface RowContext {
  accounts: AccountView[];
  /** The system shows no tray icons (the page «Startup» asked once). */
  noTray: boolean;
}

interface Base {
  /** The id the search scrolls to and the e2e steps find (`data-settings`). */
  id: string;
  label: () => string;
  /** The line under the row; null for none. Shown only when it tells something the label does not. */
  hint?: (s: Settings, c: RowContext) => string | null;
  /** A line in the colour of warning, for a value that works against its purpose. */
  warn?: (s: Settings, c: RowContext) => string | null;
  /** The row stands under a switch above it: its place at the left is one strip with its neighbours. */
  dep?: boolean;
  /** The row can be changed; false dims it where it stands (#102, 1.6 А). */
  enabled?: (s: Settings) => boolean;
  /** Other words that find the row in the search. */
  also?: () => string[];
}

type BoolKey = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never;
}[keyof Settings];

export type RowSpec = Base &
  (
    | { kind: "toggle"; key: BoolKey }
    | {
        kind: "choice";
        key: keyof Settings;
        options: (c: RowContext) => Option[];
        /** What the row shows for the saved value; the default is the value itself. */
        read?: (s: Settings, c: RowContext) => string | number;
        /** What is saved for an option's value; the default is the value itself. */
        write?: (v: string | number) => unknown;
        /** Added to the patch, besides the key (the consent that goes with a choice). */
        extra?: (v: string | number, c: RowContext) => Record<string, unknown>;
      }
    | { kind: "number"; key: "image_max_px"; unit: () => string; spec: NumberSpec }
    | { kind: "clock"; key: "day_start" | "evening_start" }
    | { kind: "days"; key: "work_days" }
    | { kind: "folder"; key: "attachments_dir" }
    | { kind: "theme"; key: "theme" }
    | { kind: "numunit"; key: "large_mb" }
    | { kind: "pair"; key: "quota_levels" }
    /** A button with a status line: «Check now». */
    | { kind: "action"; run: "update-check" }
    /** The way to a place that has the setting: «Set at the mailbox ›». */
    | { kind: "link"; to: "mailboxes"; section: string; text: () => string }
    /** «Own at 2 people, 1 mailbox ›»: where the layers below the general value differ from it. */
    | { kind: "layer"; layer: "format" | "view" }
    /** A block of its own drawing (the list of the hints' decisions). */
    | { kind: "block"; block: "hints-list" }
  );

export type RowKindOf = RowSpec["kind"];

/** The kind the keys know a row by. */
export function rowKind(spec: RowSpec): RowKind {
  return spec.kind === "layer" ? "link" : spec.kind;
}

export interface GroupSpec {
  id: string;
  title: () => string;
  rows: RowSpec[];
}

export interface PageSpec {
  id: string;
  title: () => string;
  icon: Component;
  groups: GroupSpec[];
}

// ---- The options several rows share ----

const FORMATS = (): Option[] => (["plain", "html", "markdown"] as const).map((f) => ({ value: f, label: () => t(`format.${f}`) }));

const letterViews = (): Option[] => [
  { value: "sender", label: () => t("settings.letterView.sender"), desc: () => t("settings.letterView.senderNote") },
  { value: "markdown", label: () => t("settings.letterView.markdown"), desc: () => t("settings.letterView.markdownNote") },
  { value: "text", label: () => t("settings.letterView.text"), desc: () => t("settings.letterView.textNote") },
];

/** The themes in the order the tiles stand and ← / → go. */
export const THEME_LIST = ["paper", "night", "snow", "graphite", "system"] as const;

// ---- The rows ----

/** The rows of the settings, by id; the groups below pick them. */
const R = {
  language: {
    id: "language",
    kind: "choice",
    key: "language",
    label: () => t("settings.language"),
    options: () => [
      { value: "auto", label: () => t("settings.languageAuto") },
      { value: "en", label: () => "English" },
      { value: "ru", label: () => "Русский" },
    ],
  },
  theme: {
    id: "theme",
    kind: "theme",
    key: "theme",
    label: () => t("settings.appearance"),
    hint: (s) => (s.theme === "system" ? t("settings.theme.systemNote") : null),
    also: () => THEME_LIST.map((x) => t(`settings.theme.${x}`)),
  },
  hints: {
    id: "hints",
    kind: "toggle",
    key: "hints",
    label: () => t("hints.enable"),
    hint: () => t("hints.note"),
  },
  // #103 sets the key when the note in the format menu is closed; this is the way back.
  markdown_parts_note: {
    id: "markdown_parts_note",
    kind: "toggle",
    key: "markdown_parts_note",
    label: () => t("settings.hintsFormatNote"),
  },
  hints_list: {
    id: "hints_list",
    kind: "block",
    block: "hints-list",
    label: () => t("settings.hintsDecisions"),
    also: () => [t("hints.forget"), t("hints.what"), t("hints.answer")],
  },
  threads: { id: "threads", kind: "toggle", key: "threads", label: () => t("settings.threads") },
  sender_logos: {
    id: "sender_logos",
    kind: "toggle",
    key: "sender_logos",
    label: () => t("settings.senderLogos"),
    hint: () => t("settings.senderLogosNote"),
  },
  letter_view: {
    id: "letter_view",
    kind: "choice",
    key: "letter_view",
    label: () => t("settings.letterView"),
    options: letterViews,
    hint: () => t("settings.letterView.hint"),
  },
  layer_view: { id: "layer_view", kind: "layer", layer: "view", label: () => t("settings.letterView"), dep: true },
  compose_format: {
    id: "compose_format",
    kind: "choice",
    key: "compose_format",
    label: () => t("settings.composeFormat"),
    options: FORMATS,
  },
  layer_format: { id: "layer_format", kind: "layer", layer: "format", label: () => t("settings.composeFormat"), dep: true },
  default_account: {
    id: "default_account",
    kind: "choice",
    key: "default_account_id",
    label: () => t("settings.defaultAccount"),
    // A removed mailbox reads as «By context», as the store treats it: no empty value for an id nobody carries.
    options: (c) => [
      { value: "", label: () => t("settings.defaultAccountContext") },
      ...c.accounts.map((a) => ({ value: a.id, label: () => accountLabel(a) })),
    ],
    read: (s, c) => (c.accounts.some((a) => a.id === s.default_account_id) ? (s.default_account_id ?? "") : ""),
    write: (v) => (v === "" ? null : v),
    hint: () => t("settings.defaultAccountNote"),
  },
  image_max_px: {
    id: "image_max_px",
    kind: "number",
    key: "image_max_px",
    label: () => t("settings.imageMaxPx"),
    unit: () => "px",
    spec: { min: 200, max: 8000, step: 100 },
  },
  undo_send: {
    id: "undo_send",
    kind: "choice",
    key: "undo_send_secs",
    label: () => t("settings.undoSend"),
    options: () => [
      { value: 0, label: () => t("settings.noWait") },
      ...[5, 10, 20, 30].map((n) => ({ value: n, label: () => tn("settings.seconds", n) })),
    ],
  },
  attachments_dir: { id: "attachments_dir", kind: "folder", key: "attachments_dir", label: () => t("settings.attachmentsDir") },
  day_start: {
    id: "day_start",
    kind: "clock",
    key: "day_start",
    label: () => t("settings.dayStart"),
    hint: () => t("settings.dayStartNote"),
  },
  evening_start: {
    id: "evening_start",
    kind: "clock",
    key: "evening_start",
    label: () => t("settings.eveningStart"),
    hint: () => t("settings.eveningStartNote"),
  },
  work_days: {
    id: "work_days",
    kind: "days",
    key: "work_days",
    label: () => t("settings.workDays"),
    warn: (s) => (s.work_days.length === 0 ? t("settings.noWorkDays") : null),
  },
  waiting: {
    id: "waiting",
    kind: "link",
    to: "mailboxes",
    section: "letters",
    label: () => t("account.waiting.park"),
    text: () => t("settings.setAtMailbox"),
    hint: () => t("account.waiting.hint"),
  },
  offline: {
    id: "offline",
    kind: "choice",
    key: "offline",
    label: () => t("settings.offlineKeep"),
    options: () => [
      { value: "off", label: () => t("settings.offlineOff") },
      { value: "30", label: () => tn("settings.offlineDays", 30) },
      { value: "90", label: () => tn("settings.offlineDays", 90) },
      { value: "365", label: () => t("settings.offlineYear") },
      { value: "all", label: () => t("settings.offlineAll") },
    ],
    hint: () => t("settings.offlineNote"),
  },
  offline_attachments: {
    id: "offline_attachments",
    kind: "toggle",
    key: "offline_attachments",
    label: () => t("settings.offlineAttachments"),
    dep: true,
    enabled: (s) => s.offline !== "off",
  },
  quota_warn: { id: "quota_warn", kind: "toggle", key: "quota_warn", label: () => t("settings.quotaWarn") },
  quota_levels: { id: "quota_levels", kind: "pair", key: "quota_levels", label: () => t("settings.quotaLevels"), dep: true, enabled: (s) => s.quota_warn },
  quota_repeat: {
    id: "quota_repeat",
    kind: "choice",
    key: "quota_repeat",
    label: () => t("settings.quotaRepeat"),
    options: () => [
      { value: "threshold", label: () => t("settings.quotaRepeatThreshold") },
      { value: "daily", label: () => t("settings.quotaRepeatDaily") },
    ],
    dep: true,
    enabled: (s) => s.quota_warn,
  },
  quota_own: {
    id: "quota_own",
    kind: "link",
    to: "mailboxes",
    section: "storage",
    label: () => t("storage.own"),
    text: () => t("settings.setAtMailbox"),
    dep: true,
    enabled: (s) => s.quota_warn,
  },
  large_mb: {
    id: "large_mb",
    kind: "numunit",
    key: "large_mb",
    label: () => t("settings.largeMail"),
    hint: () => t("settings.largeMailNote"),
  },
  notify: {
    id: "notify",
    kind: "choice",
    key: "notify",
    label: () => t("settings.notifications"),
    options: () => [
      { value: "people", label: () => t("settings.notifyPeople"), desc: () => t("settings.notifyPeopleNote") },
      { value: "all", label: () => t("settings.notifyAll") },
      { value: "none", label: () => t("settings.notifyNone") },
    ],
    hint: () => t("settings.dndNote"),
  },
  tray_count: {
    id: "tray_count",
    kind: "toggle",
    key: "tray_count",
    label: () => t("bg.trayCount"),
    hint: () => t("bg.trayCountNote"),
  },
  tray_always: { id: "tray_always", kind: "toggle", key: "tray_always", label: () => t("bg.trayAlways") },
  close_action: {
    id: "close_action",
    kind: "choice",
    key: "close_action",
    label: () => t("bg.onClose"),
    options: () => [
      { value: "background", label: () => t("bg.onClose.background"), desc: () => t("bg.whileBackgroundText") },
      { value: "quit", label: () => t("bg.onClose.quit") },
      { value: "ask", label: () => t("bg.onClose.ask") },
    ],
    // Chosen here, with the warning in sight, the background with no icon is agreed to.
    extra: (v, c) => (v === "background" && c.noTray ? { background_without_tray: true } : {}),
    hint: () => t("bg.quitHint"),
    warn: (_s, c) => (c.noTray ? t("bg.noTrayWarn") : null),
  },
  autostart: {
    id: "autostart",
    kind: "choice",
    key: "autostart",
    label: () => t("bg.atLogin"),
    options: () => [
      { value: "off", label: () => t("bg.atLogin.off") },
      { value: "window", label: () => t("bg.atLogin.window") },
      { value: "background", label: () => t("bg.atLogin.background") },
    ],
  },
  updates: {
    id: "updates",
    kind: "choice",
    key: "updates",
    label: () => t("settings.updates"),
    options: () => [
      { value: "auto", label: () => t("settings.updatesAuto"), desc: () => t("settings.updatesAutoNote") },
      { value: "notify", label: () => t("settings.updatesNotify") },
      { value: "off", label: () => t("settings.updatesOff") },
    ],
  },
  update_status: {
    id: "update_status",
    kind: "action",
    run: "update-check",
    label: () => t("settings.checkNow"),
    also: () => [t("settings.updates")],
  },
} satisfies Record<string, RowSpec>;

const group = (id: string, title: () => string, rows: RowSpec[]): GroupSpec => ({ id, title, rows });

// ---- The pages ----

export const PAGES: PageSpec[] = [
  {
    id: "reading",
    title: () => t("settings.page.reading"),
    icon: BookOpen,
    groups: [
      // #108 puts «Avatars in the list» into this group, above the logos.
      group("list", () => t("settings.list"), [R.threads, R.sender_logos]),
      group("read", () => t("settings.reading"), [R.letter_view, R.layer_view]),
    ],
  },
  {
    id: "writing",
    title: () => t("settings.page.writing"),
    icon: SquarePen,
    groups: [
      group("new", () => t("settings.newMessages"), [R.compose_format, R.layer_format, R.default_account, R.image_max_px]),
      group("send", () => t("settings.sending"), [R.undo_send, R.attachments_dir]),
    ],
  },
  {
    id: "later",
    title: () => t("settings.page.later"),
    icon: Clock,
    groups: [
      group("snooze", () => t("settings.snoozeTimes"), [R.day_start, R.evening_start, R.work_days]),
      group("waiting", () => t("account.waiting.title"), [R.waiting]),
    ],
  },
  {
    id: "storage",
    title: () => t("settings.page.storage"),
    icon: HardDrive,
    groups: [
      group("offline", () => t("settings.offline"), [R.offline, R.offline_attachments]),
      group("space", () => t("settings.quota"), [R.quota_warn, R.quota_levels, R.quota_repeat, R.quota_own]),
      group("big", () => t("settings.search"), [R.large_mb]),
    ],
  },
  {
    id: "look",
    title: () => t("settings.page.look"),
    icon: Palette,
    groups: [
      group("lang", () => t("settings.langLook"), [R.language, R.theme]),
      group("hints", () => t("settings.hints"), [R.hints, R.markdown_parts_note, R.hints_list]),
    ],
  },
  {
    id: "notify",
    title: () => t("settings.page.notify"),
    icon: Bell,
    groups: [
      group("notify", () => t("settings.notifications"), [R.notify]),
      group("tray", () => t("bg.trayIcon"), [R.tray_count, R.tray_always]),
    ],
  },
  {
    id: "start",
    title: () => t("settings.page.start"),
    icon: Power,
    groups: [
      group("bg", () => t("settings.page.background"), [R.close_action, R.autostart]),
      group("updates", () => t("settings.updates"), [R.updates, R.update_status]),
    ],
  },
];

/** The pages that are not a list of rows: each draws itself and saves itself. */
export const OWN_PAGES: { id: string; title: () => string; icon: Component }[] = [
  { id: "keys", title: () => t("keys.title"), icon: Keyboard },
  // #104 takes «People» into the main window; until then the panel stays here, and this entry goes with it.
  { id: "people", title: () => t("people.title"), icon: Users },
  { id: "accounts", title: () => t("accounts.title"), icon: Inbox },
  { id: "plugins", title: () => t("ext.manageTitle"), icon: Puzzle },
];

export interface MenuGroup {
  title: () => string;
  pages: string[];
}

/** The menu: two axes, «Mail» and «App», then the mailboxes and the plugins (#102, 2.1 В). */
export const MENU: MenuGroup[] = [
  { title: () => t("settings.group.mail"), pages: ["reading", "writing", "later", "storage"] },
  { title: () => t("settings.group.app"), pages: ["look", "notify", "start", "keys"] },
  { title: () => t("settings.group.mailboxes"), pages: ["people", "accounts"] },
  { title: () => t("settings.page.plugins"), pages: ["plugins"] },
];

/** The page ids the app used before 0.8: asked for by a link or a command, they land on the page that has the matter now. */
const LEGACY: Record<string, string> = {
  general: "look",
  mail: "reading",
  notifications: "notify",
  background: "start",
  offline: "storage",
  updates: "start",
};

export function resolvePage(id: string): string {
  return LEGACY[id] ?? id;
}

/** The pages in the menu's order. */
export function menuPages(): string[] {
  return MENU.flatMap((g) => g.pages);
}

export function pageSpec(id: string): PageSpec | undefined {
  return PAGES.find((p) => p.id === id);
}

export function pageTitle(id: string): string {
  return pageSpec(id)?.title() ?? OWN_PAGES.find((p) => p.id === id)?.title() ?? "";
}

export function pageIcon(id: string): Component | undefined {
  return pageSpec(id)?.icon ?? OWN_PAGES.find((p) => p.id === id)?.icon;
}

/** Whether the row can be changed now. */
export function isEnabled(spec: RowSpec, s: Settings): boolean {
  return spec.enabled ? spec.enabled(s) : true;
}
