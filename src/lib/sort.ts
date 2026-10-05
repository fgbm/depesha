// The order of lists: ready-made sets, the key a list keeps its own order under, and the
// comparison the GUI needs where it joins rows itself (local and server search results).
// The cache sorts every page in SQL (store.rs, `order_by`); this mirrors it.

import type { MessageRow, SortField, SortKey } from "./types";

export const SORT_FIELDS: SortField[] = ["date", "unread", "flagged", "people", "sender", "subject", "size", "attachments"];

/** Which way a key goes when it is added: newest, biggest, the "yes" first; names A to Я. */
export function naturalDesc(by: SortField): boolean {
  return by !== "sender" && by !== "subject";
}

const key = (by: SortField, desc = naturalDesc(by)): SortKey => ({ by, desc });

export interface SortPreset {
  id: "relevance" | "date" | "important" | "sender" | "subject" | "size";
  sort: SortKey[];
}

/** Search results only: the search engine's rank. */
export const RELEVANCE: SortPreset = { id: "relevance", sort: [key("relevance", false)] };

export const PRESETS: SortPreset[] = [
  { id: "date", sort: [] },
  { id: "important", sort: [key("unread"), key("people"), key("flagged"), key("date")] },
  { id: "sender", sort: [key("sender"), key("date")] },
  { id: "subject", sort: [key("subject"), key("date")] },
  { id: "size", sort: [key("size")] },
];

/** Newest first is what an empty order means. */
function normal(sort: SortKey[]): SortKey[] {
  return sort.length === 1 && sort[0].by === "date" && sort[0].desc ? [] : sort;
}

export function sameSort(a: SortKey[], b: SortKey[]): boolean {
  const x = normal(a);
  const y = normal(b);
  return x.length === y.length && x.every((k, i) => k.by === y[i].by && k.desc === y[i].desc);
}

export function presetOf(sort: SortKey[]): SortPreset | undefined {
  return [RELEVANCE, ...PRESETS].find((p) => sameSort(p.sort, sort));
}

/** The same keys, each the other way. */
export function reversed(sort: SortKey[]): SortKey[] {
  const keys = normal(sort).length ? sort : [key("date")];
  return keys.map((k) => ({ by: k.by, desc: !k.desc }));
}

/** A name or a subject as the cache sorts it (message.rs, `sort_key`). */
export function sortText(text: string): string {
  return text
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replaceAll("ё", "е");
}

const PREFIX = /^\s*(re|fwd|fw|aw|wg|sv|vs|tr|ответ|отв|пересл|пер|rif)\s*(?:[[(]\d+[\])])?\s*[:：]/i;

/** The subject without "Re:", "Fwd:", "Отв:" (message.rs, `strip_prefixes`). */
export function subjectKey(subject: string): string {
  let s = subject;
  for (let m = PREFIX.exec(s); m; m = PREFIX.exec(s)) s = s.slice(m[0].length);
  return sortText(s);
}

export function senderKey(row: MessageRow): string {
  const name = row.from?.name?.trim();
  return sortText(name || row.from?.email || "");
}

function value(row: MessageRow, by: SortField): number | string | null {
  switch (by) {
    case "date":
      return row.thread_date || row.date;
    case "unread":
      return row.flags.seen ? 0 : 1;
    case "flagged":
      return row.flags.flagged ? 1 : 0;
    case "people":
      return row.bulk ? 0 : 1;
    case "sender":
      return senderKey(row);
    case "subject":
      return subjectKey(row.subject);
    case "size":
      return row.size;
    case "attachments":
      return row.has_attachments ? 1 : 0;
    case "relevance":
      // Only the search engine knows it: rows keep the order they came in.
      return null;
  }
}

/** Compares rows as the cache would order them. Strings compare by code points, as SQLite does. */
export function compareRows(sort: SortKey[]): (a: MessageRow, b: MessageRow) => number {
  const keys = normal(sort).filter((k) => k.by !== "relevance");
  if (!keys.some((k) => k.by === "date")) keys.push({ by: "date", desc: true });
  return (a, b) => {
    for (const k of keys) {
      const x = value(a, k.by)!;
      const y = value(b, k.by)!;
      if (x === y) continue;
      const less = x < y ? -1 : 1;
      return k.desc ? -less : less;
    }
    return b.id - a.id;
  };
}
