// Looking a setting up by name (#68, frame 4А): the window searches the descriptions of its
// pages — the fields in src/lib/settingsFields.ts and the pages themselves — not the drawn
// window, so a new page joins the search by declaring its fields. Pure functions; the window
// draws the list and acts on the hit.

/** The words of a text, in lower case: letters and digits, everything else separated. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Whether every word of the query begins a word of the text: "уведом" finds «Уведомления»,
 * "форм" finds «Формат» — Russian inflects endings, so the beginning of a word is what tells.
 */
export function matchesText(text: string, query: string): boolean {
  const hay = words(text);
  const want = words(query);
  return want.length > 0 && want.every((w) => hay.some((h) => h.startsWith(w)));
}

/** One thing the search can find: a page, or a field on it. */
export interface SearchEntry {
  /** The page to open, as the window names it ("mail", "account:<id>", "plugin:<i>"). */
  page: string;
  /** The page's title: the heading the hit is grouped under. */
  group: string;
  /** The section of the page, shown beside the group. */
  section: string;
  /** The field or row found. */
  label: string;
  /** Words that also find it («markdown» finds the format field). */
  synonyms?: string;
  /** The data-settings value of the section to scroll to; null when the page is enough. */
  anchor: string | null;
}

export type SearchHit = SearchEntry;

/**
 * The hits for a query, best first: a match in the label, then in the section, then in the
 * page's name or synonyms alone. Within a rank, in the order the entries were given; the
 * window puts the pages in the menu's order already.
 */
export function searchSettings(entries: SearchEntry[], query: string): SearchHit[] {
  const want = words(query);
  if (!want.length) return [];
  const rank = (e: SearchEntry): number | null => {
    const label = words(e.label);
    const section = words(e.section);
    const page = words(e.group);
    const also = words(e.synonyms ?? "");
    const hay = [...label, ...section, ...page, ...also];
    if (!want.every((w) => hay.some((h) => h.startsWith(w)))) return null;
    if (label.some((h) => want.some((w) => h.startsWith(w)))) return 2;
    if (section.some((h) => want.some((w) => h.startsWith(w)))) return 1;
    return 0;
  };
  return entries
    .map((e, i) => ({ e, r: rank(e), i }))
    .filter((x): x is { e: SearchEntry; r: number; i: number } => x.r !== null)
    .sort((a, b) => b.r - a.r || a.i - b.i)
    .map((x) => x.e);
}
