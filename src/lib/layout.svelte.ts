// How the three columns (sidebar, list, letter) share the window. There is one layout
// for every width: a narrower window folds columns instead of switching to another view.
// Wide: all three. Medium: the sidebar is a strip of icons. Narrow: the strip and one
// column, the list or the letter in turn.

export type Size = "wide" | "medium" | "narrow";

/** Sidebar 248 + list 380 + a readable letter ~480. */
export const WIDE_FROM = 1100;
/** Strip 56 + list 300 + letter 400. */
export const MEDIUM_FROM = 760;
/** The folded sidebar. */
export const STRIP = 56;
/** A sidebar dragged narrower than this snaps into the strip, as in VS Code. */
export const SNAP = 150;

const SIDE = { min: 180, max: 420, initial: 248 };
const LIST = { min: 280, max: 760, initial: 380 };
/** What the letter keeps beside the list before the list gives up its width. */
const READER_MIN = 400;
/** The hairlines between columns. */
const GUTTER = 1;

export function sizeOf(width: number): Size {
  return width >= WIDE_FROM ? "wide" : width >= MEDIUM_FROM ? "medium" : "narrow";
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Widths and the folded sidebar, as kept between launches (`depesha.panes`). */
export interface Panes {
  side: number;
  list: number;
  collapsed: boolean;
}

export function readPanes(raw: string | null): Panes {
  let saved: Partial<Panes> = {};
  try {
    saved = JSON.parse(raw ?? "{}") ?? {};
  } catch {
    // A broken entry gives the defaults.
  }
  const num = (v: unknown, d: { min: number; max: number; initial: number }) =>
    typeof v === "number" && Number.isFinite(v) ? clamp(v, d.min, d.max) : d.initial;
  return { side: num(saved.side, SIDE), list: num(saved.list, LIST), collapsed: saved.collapsed === true };
}

export interface PaneStore {
  get(): string | null;
  set(value: string): void;
}

export class Layout {
  width = $state(1280);
  side = $state(SIDE.initial);
  list = $state(LIST.initial);
  /** Folded by hand («): stays folded at any width until unfolded by hand. */
  collapsed = $state(false);
  /**
   * Unfolded by hand (») while the window is too narrow for the sidebar. Lasts until the
   * window crosses a threshold: then the width decides again. Not kept between launches.
   */
  unfolded = $state(false);
  /** What a narrow window shows: the list, or the letter after Enter or a click. */
  pane = $state<"list" | "message">("list");

  constructor(private store: PaneStore) {
    const p = readPanes(store.get());
    this.side = p.side;
    this.list = p.list;
    this.collapsed = p.collapsed;
  }

  get size(): Size {
    return sizeOf(this.width);
  }

  /** The sidebar is a strip of icons. */
  get strip(): boolean {
    return this.collapsed || (this.size !== "wide" && !this.unfolded);
  }

  /** One column: the list or the letter. */
  get single(): boolean {
    return this.size === "narrow";
  }

  get sideWidth(): number {
    return this.strip ? STRIP : this.side;
  }

  /** The list gives up width before the letter gets narrower than it can be read. */
  get listWidth(): number {
    const room = this.width - this.sideWidth - 2 * GUTTER - READER_MIN;
    return clamp(this.list, LIST.min, Math.max(LIST.min, room));
  }

  /** The window changed size: crossing a threshold hands the sidebar back to the width. */
  resize(width: number) {
    if (sizeOf(width) !== this.size) this.unfolded = false;
    this.width = width;
  }

  /** « and »: by hand, at any width. */
  toggleSidebar() {
    if (this.strip) this.unfold();
    else this.fold();
    this.save();
  }

  private fold() {
    this.collapsed = true;
    this.unfolded = false;
  }

  private unfold() {
    this.collapsed = false;
    this.unfolded = this.size !== "wide";
  }

  /** The sidebar's edge dragged to `width`: below SNAP it snaps into the strip, past it opens again. */
  dragSide(width: number) {
    if (width < SNAP) {
      if (!this.strip) this.fold();
      return;
    }
    if (this.strip) this.unfold();
    this.side = clamp(width, SIDE.min, SIDE.max);
  }

  dragList(width: number) {
    this.list = clamp(width, LIST.min, LIST.max);
  }

  save() {
    this.store.set(JSON.stringify({ side: this.side, list: this.list, collapsed: this.collapsed } satisfies Panes));
  }

  /** What the one column of a narrow window shows; the list when there is no letter to show. */
  column(hasLetter: boolean): "list" | "message" {
    return this.pane === "message" && hasLetter ? "message" : "list";
  }

  showLetter() {
    this.pane = "message";
  }

  showList() {
    this.pane = "list";
  }

  /** Enter in a narrow window: the selected letter takes the column. True when handled. */
  enter(selected: number): boolean {
    if (!this.single || selected !== 1) return false;
    this.showLetter();
    return true;
  }

  /** Esc in a narrow window: from the letter back to the list, its scroll and selection as they were. */
  back(hasLetter: boolean): boolean {
    if (!this.single || this.column(hasLetter) !== "message") return false;
    this.showList();
    return true;
  }
}

export const layout = new Layout({
  get: () => (typeof localStorage === "undefined" ? null : localStorage.getItem("depesha.panes")),
  set: (v) => {
    if (typeof localStorage !== "undefined") localStorage.setItem("depesha.panes", v);
  },
});
