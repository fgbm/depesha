// Points in time offered by "Send later". Local time, pure functions.

import { locale, t } from "./i18n.svelte";

export interface Preset {
  label: string;
  /** Unix seconds. */
  at: number;
  /** Short reminder of when exactly, e.g. "пт, 9:00". */
  hint: string;
}

const weekday = () => new Intl.DateTimeFormat(locale(), { weekday: "short" });
const hm = () => new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" });
const dayMonth = () => new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long" });

function at(base: Date, days: number, hour: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function nextMonday(now: Date): Date {
  const days = ((8 - now.getDay()) % 7) || 7;
  return at(now, days, 9);
}

/** "today at 18:00", "tomorrow at 09:00", "Mon, 09:00", "12 October, 09:00". */
export function when(unix: number, now = new Date()): string {
  const d = new Date(unix * 1000);
  const days = Math.round((at(d, 0, 0).getTime() - at(now, 0, 0).getTime()) / 86_400_000);
  const time = hm().format(d);
  if (days === 0) return t("when.today", { time });
  if (days === 1) return t("when.tomorrow", { time });
  if (days > 1 && days < 7) return `${weekday().format(d)}, ${time}`;
  return `${dayMonth().format(d)}, ${time}`;
}

function preset(label: string, d: Date, now: Date): Preset {
  const at = Math.floor(d.getTime() / 1000);
  return { label, at, hint: when(at, now) };
}

function uniq(list: Preset[]): Preset[] {
  return list.filter((p, i) => list.findIndex((q) => q.at === p.at) === i);
}

export function sendLaterPresets(now = new Date()): Preset[] {
  const list: Preset[] = [];
  if (now.getHours() < 8) list.push(preset(t("later.thisMorning"), at(now, 0, 9), now));
  list.push(preset(t("later.tomorrow"), at(now, 1, 9), now));
  list.push(preset(t("later.mondayMorning"), nextMonday(now), now));
  return uniq(list);
}

/** Value for <input type="datetime-local"> and back. */
export function toLocalInput(unix: number): string {
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fromLocalInput(value: string): number | null {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}
