// What the settings search finds (#68, #102): the pages of the menu and every row of them,
// read off the catalog, so a row added there is found with no second list to keep. The mailboxes
// and the plugins' groups join the index in the window, which knows them.

import { t } from "./i18n.svelte";
import type { Key } from "./i18n.svelte";
import { MENU, PAGES, pageTitle, type RowContext } from "./settingsCatalog";
import type { SearchEntry } from "./settingsSearch";

const NONE: RowContext = { accounts: [], noTray: false };

/** The fields of a person's card: the card is not a page of the settings any more (#104), but a hit on one of its fields leads to the book. */
const PEOPLE_FIELDS: { anchor: string; label: Key; also?: Key[] }[] = [
  { anchor: "people-name", label: "people.name" },
  { anchor: "people-send", label: "people.sendFormat", also: ["format.html", "format.markdown", "format.plain", "people.asUsual"] },
  { anchor: "people-view", label: "people.view", also: ["letterView.html", "letterView.markdown", "letterView.text"] },
  { anchor: "people-note", label: "people.note" },
  { anchor: "people-hide", label: "people.hide" },
  { anchor: "people-addresses", label: "people.addresses" },
];

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
        if (row.kind === "layer" || row.visible) continue;
        const words = [...(row.also?.() ?? []), ...(row.kind === "choice" ? row.options(NONE).map((o) => o.label()) : [])];
        out.push({ page: page.id, group: page.title(), section: g.title(), label: row.label(), synonyms: words.join(" "), anchor: row.id });
      }
    }
  }
  out.push({ page: "people", group: t("people.title"), section: "", label: t("people.title"), anchor: null });
  for (const f of PEOPLE_FIELDS) {
    out.push({ page: "people", group: t("people.title"), section: t("people.card"), label: t(f.label), synonyms: f.also?.map((k) => t(k)).join(" ") ?? "", anchor: f.anchor });
  }
  return out;
}
