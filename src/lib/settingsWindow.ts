// The settings window (#68, #102): its size (the expanded letter's since 0.8.12), the menu of
// pages and the column a page's rows keep to. Pure values; the window
// (Preferences.svelte) draws from them. The numbers are mirrored in src/app.css as
// --prefs-max / --win-gap / --menu-width / --column-max; settingsWindow.test.ts checks the
// two agree.

/** The widest the expanded letter gets, and the gap left around it. */
export const WIN_MAX = 1040;
/** The settings window (#68): 0.7.1 made it 1280 for the two columns of «People»; they left
 *  for the main window (#104), and 0.8.12 (5.1 А) brought it back to the letter's width. */
export const PREFS_MAX = 1040;
export const WIN_GAP = 32;
/** The menu of pages on the left. */
export const MENU_WIDTH = 220;
/** The widest a page's column of rows gets; a table takes the whole width instead. */
export const COLUMN_MAX = 680;

/** The pages whose content is not capped to one column: a table gets the whole width. */
const WIDE = new Set(["keys"]);

/** Whether the page's content may use the whole width (a table, not a column). */
export function widePage(page: string): boolean {
  return WIDE.has(page);
}

/**
 * Pages that draw themselves and save as they go (the keys, the people, the mailboxes, the
 * plugins): the pages made of rows are the ones that save a field as it is left.
 */
export function isRowPage(page: string): boolean {
  return !["keys", "accounts", "plugins"].includes(page) && !page.startsWith("account:") && !page.startsWith("plugin:");
}
