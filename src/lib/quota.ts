// How full a mailbox is, from what the server reported or the folder sizes the user had
// counted, against the server's quota or the mailbox's own limit; the levels that warn
// and when a warning is due. Pure: the sidebar, the "Storage" section and the warnings
// all read these.

import { i18n } from "./i18n.svelte";
import type { Account, QuotaView } from "./types";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DAY = 86_400_000;

/** The threshold of "large mail" until the setting of its own (#16) is there. */
export const LARGE_MB_DEFAULT = 25;

/** The search the warnings and the "Storage" section open: the largest letters first. */
export function largeMailSearch(thresholdMb: number = LARGE_MB_DEFAULT): string {
  const mb = Number.isFinite(thresholdMb) && thresholdMb >= 1 ? Math.round(thresholdMb) : LARGE_MB_DEFAULT;
  return `larger:${mb}M`;
}

/** How full a mailbox is. */
export interface Room {
  used: number;
  /** The nearer of the server's quota and the mailbox's own limit, in bytes. */
  limit: number;
  /** The server's quota, when it reports one. */
  quota: number | null;
  /** The mailbox's own limit, when set. */
  own: number | null;
  /** Counted from folder sizes, not reported by the server: shown with "≈". */
  estimate: boolean;
  /** Some folders could not be counted: the mailbox holds more. */
  partial: boolean;
  /** When the numbers were read or counted, Unix time. */
  at: number;
}

/** The mailbox's own limit in bytes, or null. */
export function ownLimit(account: Pick<Account, "quota_limit_mb">): number | null {
  const mb = account.quota_limit_mb ?? 0;
  return mb > 0 ? mb * MB : null;
}

/**
 * The room of a mailbox: the server's quota and the own limit, the nearer one counting;
 * without a quota, the counted folder sizes against the own limit. Null when there is
 * nothing to compare (no quota and no own limit, or nothing counted).
 */
export function roomOf(view: QuotaView | undefined, account: Pick<Account, "quota_limit_mb">): Room | null {
  const own = ownLimit(account);
  const q = view?.quota;
  if (q && q.limit > 0) {
    return { used: q.used, limit: own ? Math.min(own, q.limit) : q.limit, quota: q.limit, own, estimate: false, partial: false, at: q.checked };
  }
  const e = view?.estimate;
  if (e && own) return { used: e.bytes, limit: own, quota: null, own, estimate: true, partial: e.partial, at: e.counted };
  return null;
}

export function percent(room: Room): number {
  return room.limit > 0 ? (room.used / room.limit) * 100 : 0;
}

/** 0: fine; 1 and 2: past the first and the second level; 3: full. */
export type Level = 0 | 1 | 2 | 3;

export function levelOf(pct: number, levels: [number, number]): Level {
  const [a, b] = [...levels].sort((x, y) => x - y);
  if (pct >= 100) return 3;
  if (pct >= b) return 2;
  if (pct >= a) return 1;
  return 0;
}

/** The levels from the settings, sane: each between 1 and 99. */
export function levels(value: number[] | undefined): [number, number] {
  const ok = (n: unknown, d: number) => (typeof n === "number" && n >= 1 && n <= 99 ? Math.round(n) : d);
  return [ok(value?.[0], 90), ok(value?.[1], 95)];
}

/** The last warning shown for a mailbox. */
export interface Warned {
  level: Level;
  at: number;
}

/**
 * Whether a warning is due now and what to remember. One warning per level crossed; a
 * mailbox that went down remembers the lower level, so crossing again warns again. With
 * `daily`, the same level warns again a day later.
 */
export function warning(prev: Warned | undefined, level: Level, now: number, repeat: string): { warn: boolean; next: Warned | undefined } {
  if (level === 0) return { warn: false, next: undefined };
  const before = prev?.level ?? 0;
  if (level > before) return { warn: true, next: { level, at: now } };
  if (level < before) return { warn: false, next: { level, at: prev?.at ?? now } };
  if (repeat === "daily" && prev && now - prev.at >= DAY) return { warn: true, next: { level, at: now } };
  return { warn: false, next: prev };
}

function number(n: number, digits: number): string {
  return n.toLocaleString(i18n.lang === "ru" ? "ru-RU" : "en-GB", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** A size in GB with one decimal (MB under 1 GB): `3,1 ГБ`. */
export function gb(bytes: number): string {
  const ru = i18n.lang === "ru";
  if (bytes < GB) return `${number(Math.round(bytes / MB), 0)} ${ru ? "МБ" : "MB"}`;
  return `${number(Math.round((bytes / GB) * 10) / 10, 1)} ${ru ? "ГБ" : "GB"}`;
}

/** "3,1 of 10 GB": the used part in the limit's unit, without repeating it. */
export function usedOf(used: number, limit: number): { used: string; limit: string } {
  const ru = i18n.lang === "ru";
  if (limit < GB) return { used: number(Math.round(used / MB), 0), limit: `${number(Math.round(limit / MB), 0)} ${ru ? "МБ" : "MB"}` };
  return { used: number(Math.round((used / GB) * 10) / 10, 1), limit: gb(limit) };
}

/** A whole percent that does not show 100 before the mailbox is full. */
export function wholePercent(pct: number): number {
  return pct >= 100 ? 100 : Math.min(99, Math.floor(pct));
}
