// The state and the keys of the «Snooze» menu, apart from how it is drawn. The line is always
// in focus (decision 3.1 В): a letter or a digit lights the item it stands for and goes into
// the line, Enter does what is lit, and more typing makes the line a text to read («завтра 18»).

import type { Lang, WorkTime } from "@depesha/plugin-api";
import { parseWhen, type Parsed } from "./parse";
import { fmtDay, fmtWhen } from "./format";
import { slots, workdaySlots, type SlotId, type WorkdaySlot } from "./times";

export type RowId = SlotId | "days" | "custom" | "parsed";

export interface Row {
  id: RowId;
  kind: "item" | "sub" | "custom";
  label: string;
  /** The date on the right, or why the item is off. */
  hint: string;
  /** The letter shown in its key. */
  key: string;
  off: boolean;
  at: Date | null;
}

/** What the menu needs from outside: the clock, the user's day and the words. */
export interface MenuEnv {
  now: Date;
  work: WorkTime;
  lang: Lang;
  /** The words of an item or a hint, by `strings.ts` key. */
  say(key: string): string;
}

/** The part of a keydown the menu reads. */
export interface KeyInfo {
  code: string;
  key: string;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
  /** The caret stands at the end of the line: only then does → mean «open the submenu». */
  atEnd?: boolean;
}

/** What a key did to the menu, for the one that draws it. `null`: the key is not the menu's, the line takes it. */
export type Outcome = { type: "stay" } | { type: "pick"; at: Date } | { type: "custom" } | { type: "back" } | { type: "close" };

const STAY: Outcome = { type: "stay" };

/**
 * The keys of the items, by the place of the key: the same in Russian and Latin layouts.
 * Russian letters sit on the same keys as the Latin ones shown for English.
 */
const LETTERS: Record<Lang, Record<string, { code: string; shown: string }>> = {
  ru: {
    evening: { code: "KeyD", shown: "В" },
    tomorrow: { code: "KeyP", shown: "З" },
    weekend: { code: "Quote", shown: "Э" },
    nextWeek: { code: "KeyY", shown: "Н" },
    nextMonth: { code: "KeyV", shown: "М" },
    days: { code: "KeyL", shown: "Д" },
    custom: { code: "KeyR", shown: "К" },
  },
  en: {
    evening: { code: "KeyE", shown: "E" },
    tomorrow: { code: "KeyT", shown: "T" },
    weekend: { code: "KeyW", shown: "W" },
    nextWeek: { code: "KeyN", shown: "N" },
    nextMonth: { code: "KeyM", shown: "M" },
    days: { code: "KeyD", shown: "D" },
    custom: { code: "KeyC", shown: "C" },
  },
};

/** 1–7 of the digit row or the numpad: the ISO day of the week. */
function digitOf(code: string): number | null {
  const m = code.match(/^(?:Digit|Numpad)([1-7])$/);
  return m ? Number(m[1]) : null;
}

export class SnoozeMenu {
  /** The line. */
  q = $state("");
  /** The lit row of `rows`; -1 when none is lit. */
  cur = $state(0);
  subOpen = $state(false);
  subCur = $state(0);
  /** The first character of the line is a key of an item, not yet a text. */
  hot = $state(false);

  private env: () => MenuEnv;
  /** A key of an item was pressed and its character has not reached the line yet. */
  private pending = false;

  constructor(env: () => MenuEnv) {
    this.env = env;
    this.cur = this.rowIndex("tomorrow");
  }

  get days(): WorkdaySlot[] {
    const { now, work } = this.env();
    return workdaySlots(now, work);
  }

  /** The text of the line read as a moment; none while the line is empty or is one key of an item. */
  get parsed(): Parsed | null {
    if (!this.q.trim() || this.hot) return null;
    const { now, work } = this.env();
    return parseWhen(this.q, now, work);
  }

  /** What the line says when it cannot be used: a hint under it. */
  get note(): { text: string; bad: boolean } | null {
    const p = this.parsed;
    if (!p || p.ok) return null;
    const { say } = this.env();
    return p.reason === "passed" ? { text: say("timePassed"), bad: true } : { text: say("notUnderstood"), bad: false };
  }

  get items(): Row[] {
    const { now, work, lang, say } = this.env();
    const keys = LETTERS[lang];
    const row = (id: Exclude<RowId, "parsed">, rest: Partial<Row>): Row => ({
      id,
      kind: "item",
      label: say(id),
      hint: "",
      key: keys[id].shown,
      off: false,
      at: null,
      ...rest,
    });
    const list = slots(now, work).map((s) =>
      row(s.id, {
        at: s.at,
        off: s.off !== null,
        hint: s.off === "passed" ? say("passed") : s.off === "noWorkDays" ? say("noWorkDays") : fmtDay(s.at!, lang),
      }),
    );
    const none = work.days.length === 0;
    list.push(row("days", { kind: "sub", off: none, hint: none ? say("noneChosen") : "1–7" }));
    list.push(row("custom", { kind: "custom" }));
    return list;
  }

  /** The rows of the list: what the line says on top, when it is a time, then the items. */
  get rows(): Row[] {
    const p = this.parsed;
    const { lang, say } = this.env();
    if (!p?.ok) return this.items;
    const parsed: Row = { id: "parsed", kind: "item", label: fmtWhen(p.at, lang), hint: say("fromYou"), key: "↵", off: false, at: p.at };
    return [parsed, ...this.items];
  }

  rowIndex(id: RowId): number {
    return this.rows.findIndex((r) => r.id === id);
  }

  /** The lit row, when it can be chosen. */
  get lit(): Row | null {
    const r = this.rows[this.cur];
    return r && !r.off ? r : null;
  }

  private selectable(): number[] {
    return this.rows.flatMap((r, i) => (r.off ? [] : [i]));
  }

  /** The line changed (typed, pasted, cleared). */
  setQuery(value: string) {
    this.q = value;
    this.hot = this.pending && value.length === 1;
    this.pending = false;
    if (!this.hot) this.subOpen = false;
    if (!value) {
      this.hot = false;
      this.cur = this.rowIndex("tomorrow");
    } else if (!this.hot) {
      // A text that reads as a moment lights it; one that does not lights nothing, Enter does nothing.
      this.cur = this.parsed?.ok ? 0 : -1;
    }
  }

  private move(step: number) {
    const list = this.selectable();
    if (!list.length) return;
    const at = list.indexOf(this.cur);
    this.cur = list[at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length];
  }

  private choose(row: Row | null): Outcome {
    if (!row || row.off) return STAY;
    if (row.kind === "sub") {
      this.subOpen = true;
      this.subCur = 0;
      return STAY;
    }
    if (row.kind === "custom") return { type: "custom" };
    return row.at ? { type: "pick", at: row.at } : STAY;
  }

  /** Mouse: the row under the pointer is lit; the submenu follows the row it hangs on. */
  hover(index: number) {
    const r = this.rows[index];
    if (!r || r.off || index === this.cur) return;
    this.cur = index;
    if (r.id !== "days") this.subOpen = false;
  }

  click(index: number): Outcome {
    this.cur = index;
    return this.choose(this.lit);
  }

  clickDay(index: number): Outcome {
    const d = this.days[index];
    return d ? { type: "pick", at: d.at } : STAY;
  }

  private escape(): Outcome {
    if (this.subOpen) this.subOpen = false;
    else if (this.q) this.setQuery("");
    else return { type: "close" };
    return STAY;
  }

  private arrow(code: string, e: KeyInfo): Outcome | null {
    if (code === "ArrowDown" || code === "ArrowUp") {
      const step = code === "ArrowDown" ? 1 : -1;
      if (this.subOpen) {
        const n = this.days.length;
        this.subCur = (this.subCur + step + n) % n;
      } else this.move(step);
      return STAY;
    }
    if (code === "ArrowRight" && !this.subOpen && e.atEnd && this.lit?.kind === "sub") return this.choose(this.lit);
    if (code === "ArrowLeft" && this.subOpen) {
      this.subOpen = false;
      return STAY;
    }
    return null;
  }

  /** The first key of a line that is a key of an item lights the item; the character still goes into the line. */
  private itemKey(code: string): void {
    const digit = digitOf(code);
    if (digit !== null) {
      const at = this.days.findIndex((d) => d.iso === digit);
      this.pending = true;
      this.cur = at < 0 ? -1 : this.rowIndex("days");
      this.subOpen = at >= 0;
      this.subCur = Math.max(0, at);
      return;
    }
    const letters = LETTERS[this.env().lang];
    const id = Object.keys(letters).find((k) => letters[k].code === code);
    if (!id) return;
    this.pending = true;
    this.subOpen = false;
    const index = this.rowIndex(id as RowId);
    this.cur = this.rows[index]?.off ? -1 : index;
  }

  key(e: KeyInfo): Outcome | null {
    if (e.ctrl || e.alt || e.meta) return null;
    const c = e.code;
    if (c === "Escape") return this.escape();
    if (c === "Enter" || c === "NumpadEnter") return this.subOpen ? this.clickDay(this.subCur) : this.choose(this.lit);
    const moved = this.arrow(c, e);
    if (moved) return moved;
    if (this.q === "" && e.key.length === 1) this.itemKey(c);
    return null;
  }
}
