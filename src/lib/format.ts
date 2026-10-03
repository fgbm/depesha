import { i18n, locale, t, tn } from "./i18n.svelte";
import type { Account, Addr, FolderRole } from "./types";

/** "Inbox" / "Входящие" for a folder with a known role. */
export function roleLabel(role: FolderRole): string {
  return t(`role.${role}`);
}

type Formats = Record<"time" | "dayMonth" | "full" | "long", Intl.DateTimeFormat>;
const cache = new Map<string, Formats>();

/** Date formats of the interface language, built once per language. */
function f(): Formats {
  const loc = locale();
  let v = cache.get(loc);
  if (!v) {
    v = {
      time: new Intl.DateTimeFormat(loc, { hour: "2-digit", minute: "2-digit" }),
      dayMonth: new Intl.DateTimeFormat(loc, { day: "numeric", month: "short" }),
      full: new Intl.DateTimeFormat(loc, { day: "2-digit", month: "2-digit", year: "numeric" }),
      long: new Intl.DateTimeFormat(loc, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }),
    };
    cache.set(loc, v);
  }
  return v;
}

/** Compact date for the list: time today, day and month this year, full date otherwise. */
export function listDate(unix: number, now = new Date()): string {
  const d = new Date(unix * 1000);
  if (d.toDateString() === now.toDateString()) return f().time.format(d);
  if (d.getFullYear() === now.getFullYear()) return f().dayMonth.format(d).replace(".", "");
  return f().full.format(d);
}

export function longDate(unix: number | null): string {
  return unix ? f().long.format(new Date(unix * 1000)) : "";
}

export function shortDateTime(unix: number | null): string {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  return `${f().full.format(d)} ${f().time.format(d)}`;
}

export function addrName(a: Addr | null | undefined): string {
  if (!a) return "";
  return a.name?.trim() || a.email;
}

/** How the app names a mailbox: the user's label, else the address. */
export function accountLabel(a: Pick<Account, "label" | "email">): string {
  return a.label?.trim() || a.email;
}

/** Mailbox colours: calm enough for a sidebar dot and a list stripe on paper and at night. */
export const ACCOUNT_PALETTE = [
  "#3f7cc4",
  "#c77d1a",
  "#4a9a6a",
  "#9b59b6",
  "#c0504d",
  "#2a9d9b",
  "#b5873a",
  "#5c6bc0",
  "#d0658f",
  "#6d8a3a",
];

/** The mailbox's own colour, or one from the palette by its place. */
export function accountColor(a: Pick<Account, "color"> | undefined, index: number): string {
  return a?.color || ACCOUNT_PALETTE[Math.max(0, index) % ACCOUNT_PALETTE.length];
}

export function addrFull(a: Addr): string {
  return a.name?.trim() ? `${a.name} <${a.email}>` : a.email;
}

export function size(bytes: number): string {
  const ru = i18n.lang === "ru";
  if (bytes < 1024) return `${bytes} ${ru ? "Б" : "B"}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} ${ru ? "КБ" : "KB"}`;
  const mb = (bytes / 1024 / 1024).toFixed(1);
  return ru ? `${mb.replace(".", ",")} МБ` : `${mb} MB`;
}

const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

/** Parses "Name <a@b>", "<a@b>" or "a@b". */
export function parseAddr(input: string): Addr | null {
  const s = input.trim().replace(/[,;]+$/, "");
  if (!s) return null;
  const m = s.match(/^(.*)<([^>]+)>$/);
  if (m) {
    const email = m[2].trim();
    const name = m[1].trim().replace(/^"|"$/g, "");
    return EMAIL.test(email) ? { name: name || null, email } : null;
  }
  return EMAIL.test(s) ? { name: null, email: s } : null;
}

/** Splits text into plain parts and links, so links can be rendered without innerHTML. */
export function linkify(text: string): { text: string; href?: string }[] {
  const out: { text: string; href?: string }[] = [];
  const re = /\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: text.slice(last, i) });
    out.push({ text: m[0], href: m[0] });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export function pluralRu(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/** "3 messages" / "3 письма". */
export function messagesCount(n: number): string {
  return tn("count.messages", n);
}

/** A stable, readable colour per address, so senders are told apart at a glance. */
export function avatarColor(email: string): string {
  let h = 0;
  for (const ch of email.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 42% 40%)`;
}

/** Initials: two letters of the name, or the first of the address. */
export function initials(a: Addr | null | undefined): string {
  const name = a?.name?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter((p) => /\p{L}/u.test(p));
    return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
  }
  return (a?.email?.[0] ?? "?").toUpperCase();
}

/** Every word of the query starts a word of the label (palette search). */
export function matches(label: string, query: string): boolean {
  const words = label.toLowerCase().split(/[^\p{L}\d]+/u).filter(Boolean);
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((q) => words.some((w) => w.startsWith(q)));
}
