// The rules the rows of the settings window share (#102): how a choice is drawn, what a typed
// value may be, how a row answers the keys, how rows that depend on another stand together.
// Pure functions: the window (SettingsPage.svelte) draws from them, and the pages to come
// (avatars #108, importance #72) add rows by describing them, with no rule of their own.

import { formatClock, parseClock } from "./workTime";

/** «Choose one of several» is a set of segments up to this many options and this many letters in all. */
export const SEG_MAX_OPTIONS = 3;
export const SEG_MAX_CHARS = 40;

export type ChoiceMode = "seg" | "drop";

/** Segments when the options are few and short (the whole set reads at a glance), else a list. */
export function choiceMode(labels: string[]): ChoiceMode {
  const letters = labels.reduce((n, l) => n + [...l].length, 0);
  return labels.length <= SEG_MAX_OPTIONS && letters <= SEG_MAX_CHARS ? "seg" : "drop";
}

// ---- Typed values ----

export interface NumberSpec {
  min: number;
  max: number;
  step?: number;
}

/** A whole number within the spec; nothing for anything else (the field is lit and not saved). */
export function parseWhole(raw: string, spec: NumberSpec): number | null {
  const text = raw.trim();
  if (!/^\d{1,9}$/.test(text)) return null;
  const n = Number(text);
  return n >= spec.min && n <= spec.max ? n : null;
}

/** One step up or down (ten with Shift), held inside the spec. */
export function stepWhole(value: number, dir: 1 | -1, spec: NumberSpec, big = false): number {
  const by = (spec.step ?? 1) * (big ? 10 : 1);
  return Math.min(spec.max, Math.max(spec.min, value + dir * by));
}

/** A quarter of an hour either way, round the clock; nothing when the text is not a time. */
export function stepClock(text: string, dir: 1 | -1): string | null {
  const c = parseClock(text);
  if (!c) return null;
  const minutes = (((c.h * 60 + c.m + dir * 15) % 1440) + 1440) % 1440;
  return formatClock({ h: Math.floor(minutes / 60), m: minutes % 60 });
}

/** The next value of a list in a direction; the ends hold (no wrap, so ← at the first stays). */
export function stepChoice<T>(values: T[], current: T, dir: 1 | -1): T {
  const i = values.indexOf(current);
  const next = Math.min(values.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir));
  return values[next] ?? current;
}

// ---- Keys on a row (#102, 4.1–4.3) ----

export type RowKind = "toggle" | "choice" | "number" | "clock" | "numunit" | "pair" | "theme" | "days" | "folder" | "action" | "link" | "block";

export type RowAction =
  | { type: "move"; to: "prev" | "next" | "first" | "last" }
  | { type: "step"; dir: 1 | -1; big: boolean }
  | { type: "set"; on: boolean }
  | { type: "toggle" }
  | { type: "enter" }
  | { type: "clear" }
  | { type: "day"; n: number };

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

/** ← / → on a row: a switch goes off or on, a link is followed, the rest step through their values. */
function sideAction(kind: RowKind, key: string, shift: boolean): RowAction | null {
  const dir = key === "ArrowRight" ? 1 : -1;
  if (kind === "toggle") return { type: "set", on: dir === 1 };
  if (kind === "link") return dir === 1 ? { type: "enter" } : null;
  if (kind === "folder" || kind === "action" || kind === "block" || kind === "pair") return null;
  return { type: "step", dir, big: shift };
}

const MOVES: Record<string, "prev" | "next" | "first" | "last"> = { ArrowUp: "prev", ArrowDown: "next", Home: "first", End: "last" };

/**
 * What a key does on a row that has the focus. A row is one stop: ↑/↓ walk the rows of the
 * page, ←/→ change the value, Enter opens or enters it. A key with Ctrl, Alt or Meta is the
 * window's (Alt+← to the menu, Ctrl+PgUp/PgDn between pages) and the row leaves it alone.
 */
export function rowKeyAction(kind: RowKind, e: KeyLike): RowAction | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  const move = MOVES[e.key];
  if (move) return { type: "move", to: move };
  switch (e.key) {
    case "ArrowLeft":
    case "ArrowRight":
      return sideAction(kind, e.key, !!e.shiftKey);
    case "Enter":
      return kind === "toggle" ? { type: "toggle" } : kind === "block" || kind === "theme" ? null : { type: "enter" };
    case " ":
      return kind === "toggle" ? { type: "toggle" } : kind === "action" || kind === "link" || kind === "days" ? { type: "enter" } : null;
    case "Delete":
    case "Backspace":
      return kind === "folder" ? { type: "clear" } : null;
    default:
      return kind === "days" && /^[1-7]$/.test(e.key) ? { type: "day", n: Number(e.key) } : null;
  }
}

/** The index the cursor goes to; it stops at the ends of the page. */
export function moveCursor(count: number, current: number, to: "prev" | "next" | "first" | "last"): number {
  if (count <= 0) return -1;
  if (to === "first") return 0;
  if (to === "last") return count - 1;
  return Math.min(count - 1, Math.max(0, current + (to === "next" ? 1 : -1)));
}

// ---- Rows that stand together ----

export type Run<T> = { run: false; row: T } | { run: true; rows: T[] };

/**
 * Rows in a group, with the ones that depend on a switch above them gathered in runs: one
 * wrapper for a run, so the strip at its left is one line and does not break between rows.
 */
export function dependentRuns<T extends { dep?: boolean }>(rows: T[]): Run<T>[] {
  const out: Run<T>[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (!row.dep) out.push({ run: false, row });
    else if (last?.run) last.rows.push(row);
    else out.push({ run: true, rows: [row] });
  }
  return out;
}
