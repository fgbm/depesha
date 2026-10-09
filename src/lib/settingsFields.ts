// What the settings search finds (#68, #102): the pages of the menu and every row of them,
// read off the catalog, so a row added there is found with no second list to keep. The mailboxes
// and the plugins' groups join the index in the window, which knows them.

import { MENU, PAGES, pageTitle, type RowContext } from "./settingsCatalog";
import type { SearchEntry } from "./settingsSearch";

const NONE: RowContext = { accounts: [], noTray: false };

/** One entry per page (so its name alone finds it) and one per row, with the words that also find it. */
export function buildSettingsIndex(): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const id of MENU.flatMap((g) => g.pages)) {
    const title = pageTitle(id);
    out.push({ page: id, group: title, section: "", label: title, anchor: null });
  }
  for (const page of PAGES) {
    for (const g of page.groups) {
      for (const row of g.rows) {
        if (row.kind === "layer") continue;
        const words = [...(row.also?.() ?? []), ...(row.kind === "choice" ? row.options(NONE).map((o) => o.label()) : [])];
        out.push({ page: page.id, group: page.title(), section: g.title(), label: row.label(), synonyms: words.join(" "), anchor: row.id });
      }
    }
  }
  return out;
}
