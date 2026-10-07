// The settings window of 0.7 (#68): the size it shares with the expanded letter, the menu of
// pages, the column a page's fields keep to, what a page says about itself and how leaving a
// page with unsaved changes is settled. Pure values and small helpers; the window
// (Preferences.svelte) draws from them. The numbers are mirrored in src/app.css as
// --win-max / --win-gap / --menu-width / --column-max; layout.test.ts checks the two agree.

/** The widest the window and the expanded letter get, and the gap left around them. */
export const WIN_MAX = 1040;
export const WIN_GAP = 32;
/** The menu of pages on the left. */
export const MENU_WIDTH = 220;
/** The widest a page's column of fields gets; a table takes the whole width instead. */
export const COLUMN_MAX = 680;

/** What a page says about itself; a page without an entry is an ordinary one. */
export interface PageTraits {
  /** Saves as it goes: the shared «Save / Cancel» line is hidden and leaving asks nothing about it. */
  selfSaving?: boolean;
  /** Its content is not capped to one column: a table gets the whole width. */
  wide?: boolean;
}

/**
 * Pages that are not ordinary. «Keys» (#46) saves at once and draws a table; a new page —
 * «People» (#66), «Hints» (#69) — declares the same trait here and takes the shape with no
 * other change to the window.
 */
export const PAGE_TRAITS: Record<string, PageTraits> = {
  keys: { selfSaving: true, wide: true },
  // «People» (#66) saves every record as it is changed and draws a list beside an editor.
  people: { selfSaving: true, wide: true },
};

export function traits(page: string): PageTraits {
  return PAGE_TRAITS[page] ?? {};
}

/**
 * Whether the shared «Save / Cancel» line is hidden on this page. A mailbox's page has its
 * own buttons and saves apart from the rest; a page that saves at once says so in its traits.
 */
export function ownFooter(page: string): boolean {
  return page.startsWith("account:") || traits(page).selfSaving === true;
}

/** Whether the page's content may use the whole width (a table, not a column). */
export function widePage(page: string): boolean {
  return traits(page).wide === true;
}

/** The settings a core page owns; a page not listed (a mailbox, a plugin) saves itself. */
export const PAGE_KEYS: Record<string, string[]> = {
  general: ["language", "theme"],
  updates: ["updates"],
  mail: ["threads", "sender_logos", "compose_format", "default_account_id", "letter_view", "attachments_dir", "undo_send_secs"],
  notifications: ["notify", "quota_warn", "quota_levels", "quota_repeat"],
  background: ["close_action", "background_without_tray", "autostart", "tray_count", "tray_always"],
  offline: ["offline", "offline_attachments"],
};

/** The keys of a core page, or null when the page saves itself (a mailbox, a plugin). */
export function pageKeys(page: string): string[] | null {
  return PAGE_KEYS[page] ?? null;
}

/**
 * Whether any of the page's own fields differ between the draft and what is saved. A page
 * that keeps its own state (a mailbox, a plugin) is never seen as changed here: it asks on
 * its own.
 */
export function pageChanged(page: string, draft: Record<string, unknown>, saved: Record<string, unknown>): boolean {
  const keys = pageKeys(page);
  if (!keys) return false;
  return keys.some((k) => JSON.stringify(draft[k]) !== JSON.stringify(saved[k]));
}

/** What the window does when a page with unsaved changes is left. */
export type LeaveAnswer = "save" | "discard" | "stay";

/** The answer of the three-way question (yes / no / dismissed) as a page's leaving reads it. */
export function resolveLeave(answer: boolean | null): LeaveAnswer {
  return answer === true ? "save" : answer === false ? "discard" : "stay";
}
