import type { Addr } from "./types";

const time = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const dayMonth = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const full = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const long = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Compact date for the list: time today, day and month this year, full date otherwise. */
export function listDate(unix: number, now = new Date()): string {
  const d = new Date(unix * 1000);
  if (d.toDateString() === now.toDateString()) return time.format(d);
  if (d.getFullYear() === now.getFullYear()) return dayMonth.format(d).replace(".", "");
  return full.format(d);
}

export function longDate(unix: number | null): string {
  return unix ? long.format(new Date(unix * 1000)) : "";
}

export function shortDateTime(unix: number | null): string {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  return `${full.format(d)} ${time.format(d)}`;
}

export function addrName(a: Addr | null | undefined): string {
  if (!a) return "";
  return a.name?.trim() || a.email;
}

export function addrFull(a: Addr): string {
  return a.name?.trim() ? `${a.name} <${a.email}>` : a.email;
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;
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
