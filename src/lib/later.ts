// Points in time offered by "Snooze" and "Send later". Local time, pure functions.

export interface Preset {
  label: string;
  /** Unix seconds. */
  at: number;
  /** Short reminder of when exactly, e.g. "пт, 9:00". */
  hint: string;
}

const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "short" });
const hm = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const dayMonth = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });

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

/** "сегодня в 18:00", "завтра в 9:00", "пн, 9:00", "12 октября, 9:00". */
export function when(unix: number, now = new Date()): string {
  const d = new Date(unix * 1000);
  const days = Math.round((at(d, 0, 0).getTime() - at(now, 0, 0).getTime()) / 86_400_000);
  if (days === 0) return `сегодня в ${hm.format(d)}`;
  if (days === 1) return `завтра в ${hm.format(d)}`;
  if (days > 1 && days < 7) return `${weekday.format(d)}, ${hm.format(d)}`;
  return `${dayMonth.format(d)}, ${hm.format(d)}`;
}

function preset(label: string, d: Date, now: Date): Preset {
  const at = Math.floor(d.getTime() / 1000);
  return { label, at, hint: when(at, now) };
}

function uniq(list: Preset[]): Preset[] {
  return list.filter((p, i) => list.findIndex((q) => q.at === p.at) === i);
}

export function snoozePresets(now = new Date()): Preset[] {
  const list: Preset[] = [];
  const inHour = new Date(now.getTime() + 3_600_000);
  inHour.setMinutes(Math.ceil(inHour.getMinutes() / 5) * 5, 0, 0);
  list.push(preset("Через час", inHour, now));
  if (now.getHours() < 17) list.push(preset("Сегодня вечером", at(now, 0, 18), now));
  list.push(preset("Завтра утром", at(now, 1, 9), now));
  list.push(preset("В понедельник", nextMonday(now), now));
  list.push(preset("Через неделю", at(now, 7, 9), now));
  return uniq(list);
}

export function sendLaterPresets(now = new Date()): Preset[] {
  const list: Preset[] = [];
  if (now.getHours() < 8) list.push(preset("Сегодня утром", at(now, 0, 9), now));
  list.push(preset("Завтра утром", at(now, 1, 9), now));
  list.push(preset("В понедельник утром", nextMonday(now), now));
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
