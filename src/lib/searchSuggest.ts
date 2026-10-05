// Completion in the search box while typing: the operator being typed ("го" → "год:"),
// then its value: a year with its exact range, a folder alone or with its subfolders,
// a size, a mailbox. Pure functions over the text; the box draws and applies them.

import { size } from "./format";
import { locale, t, tn, type Lang } from "./i18n.svelte";
import { folderOperator, recentYears } from "./largeMail";

/** Operators of the search (query.rs) as the cheat sheet and completion offer them. */
export const OPERATORS: Record<Lang, string[]> = {
  en: ["from:", "to:", "subject:", "has:attachment", "after:", "before:", "in:", "larger:", "smaller:", "older:", "newer:", "year:", "account:"],
  ru: ["от:", "кому:", "тема:", "есть:вложение", "после:", "до:", "в:", "больше:", "меньше:", "старше:", "новее:", "год:", "ящик:"],
};

/** Operators added for large mail: the cheat sheet marks them apart. */
export const NEW_OPERATORS: Record<Lang, string[]> = {
  en: ["larger:", "smaller:", "older:", "newer:", "year:", "in:Folder/*", "account:"],
  ru: ["больше:", "меньше:", "старше:", "новее:", "год:", "в:Папка/*", "ящик:"],
};

export interface Completion {
  kind: "operator" | "year" | "folder" | "size" | "account";
  /** What replaces the token being typed. */
  token: string;
  detail: string;
  /** A whole value: a space follows it and the next word starts. */
  done: boolean;
}

export interface SuggestContext {
  lang: Lang;
  now: Date;
  folders: { name: string; display_name: string; delimiter: string | null }[];
  accounts: { email: string; label?: string }[];
}

/** The word being typed: from the last space outside quotes to the end. */
export function lastToken(text: string): { start: number; token: string } {
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (/\s/.test(c) && !quoted) start = i + 1;
  }
  return { start, token: text.slice(start) };
}

/** The text with the word being typed replaced by `c`. */
export function applyCompletion(text: string, c: Completion): string {
  const { start } = lastToken(text);
  return text.slice(0, start) + c.token + (c.done ? " " : "");
}

const YEAR = new Set(["год", "year"]);
const FOLDER = new Set(["в", "in"]);
const SIZE = new Set(["больше", "larger", "меньше", "smaller"]);
const ACCOUNT = new Set(["ящик", "account", "аккаунт"]);

const MAX = 8;

export function completions(text: string, ctx: SuggestContext): Completion[] {
  const { token } = lastToken(text);
  if (!token) return [];
  const colon = token.indexOf(":");
  if (colon < 0) {
    const word = token.toLowerCase();
    const all = [...OPERATORS[ctx.lang], ...OPERATORS[ctx.lang === "ru" ? "en" : "ru"]];
    return all
      .filter((op) => op.startsWith(word) && op !== word)
      .slice(0, MAX)
      .map((op) => ({ kind: "operator", token: op, detail: "", done: !op.endsWith(":") }));
  }
  const key = token.slice(0, colon);
  const k = key.toLowerCase();
  const value = token.slice(colon + 1).replace(/"/g, "");
  if (YEAR.has(k)) {
    return recentYears(ctx.now, 6)
      .filter((y) => String(y).startsWith(value) && String(y) !== value)
      .map((y) => ({ kind: "year", token: `${key}:${y}`, detail: yearRange(y), done: true }));
  }
  if (SIZE.has(k)) {
    const unit = ctx.lang === "ru" ? "М" : "M";
    return [10, 25, 50, 100]
      .map((mb) => `${mb}${unit}`)
      .filter((v) => v.toLowerCase().startsWith(value.toLowerCase()) && v !== value)
      .map((v) => ({ kind: "size", token: `${key}:${v}`, detail: size(Number.parseInt(v) * 1024 * 1024, 0), done: true }));
  }
  if (ACCOUNT.has(k)) {
    const v = value.toLowerCase();
    return ctx.accounts
      .filter((a) => a.email.toLowerCase().includes(v) && a.email !== value)
      .slice(0, MAX)
      .map((a) => ({ kind: "account", token: `${key}:${a.email}`, detail: a.label ?? "", done: true }));
  }
  if (FOLDER.has(k)) return folderCompletions(key, value.replace(/\/\*$/, ""), ctx);
  return [];
}

/** Each matching folder twice: alone, and with its subfolders when it has any. */
function folderCompletions(key: string, value: string, ctx: SuggestContext): Completion[] {
  const v = value.toLowerCase();
  const names = new Map<string, { display_name: string; delimiter: string | null }>();
  for (const f of ctx.folders) if (!names.has(f.name)) names.set(f.name, f);
  const out: Completion[] = [];
  const lang = key.toLowerCase() === "in" ? "en" : "ru";
  for (const [name, f] of names) {
    if (!name.toLowerCase().includes(v) && !f.display_name.toLowerCase().includes(v)) continue;
    const prefix = f.delimiter ? name + f.delimiter : null;
    const inside = prefix ? [...names.keys()].filter((n) => n.startsWith(prefix)).length : 0;
    out.push({ kind: "folder", token: folderOperator(name, false, lang), detail: t("suggest.folderOnly"), done: true });
    if (inside) out.push({ kind: "folder", token: folderOperator(name, true, lang), detail: tn("suggest.folderTree", inside), done: true });
    if (out.length >= MAX) break;
  }
  return out.slice(0, MAX);
}

/** "1 Jan 2024 — 31 Dec 2024 inclusive": the exact range `year:` searches. */
export function yearRange(year: number): string {
  const f = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", year: "numeric" });
  return t("suggest.yearRange", { from: f.format(new Date(year, 0, 1)), to: f.format(new Date(year, 11, 31)) });
}
