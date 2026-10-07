// The «Keys» page of the settings (#46), its state and actions without markup or wording:
// the search, recording a key at once, conflicts settled by «Replace» or «Swap», resets.
// The keys go into the settings' draft and are saved with the rest of the settings.
// KeysPanel.svelte brings the markup and every `t("…")`.

import { tick } from "svelte";
import { app } from "../../lib/store.svelte";
import { allCommands } from "../../plugin-host/host.svelte";
import { shortcuts, type TitledCommand } from "../../lib/shortcuts.svelte";
import {
  canSwap,
  changed,
  heldMods,
  matches,
  overlaps,
  pressName,
  removeKey,
  replace,
  resetOne,
  resolve,
  swap,
  take,
  type Custom,
  type Lost,
  type Problem,
} from "../../lib/keymap";
import type { Settings } from "../../lib/types";

export type Message = { kind: "problem"; key: string; problem: Problem } | { kind: "same"; key: string };
/** A quiet line under the row just changed: the same key in the other window, or a Russian letter saved by its place. */
export type Note = { id: string; kind: "elsewhere"; key: string; other: string } | { id: string; kind: "typed"; key: string; typed: string };
export type SwapProblem = { kind: "noKey" } | { kind: "bad"; key: string; other: string } | null;

export class KeyEditor {
  query = $state("");
  /** «Press»: the next press is the search. */
  pressing = $state(false);
  pressKey = $state<string | null>(null);
  onlyChanged = $state(false);
  showMore = $state(false);
  /** The key being recorded: its command and place (past the end adds one). */
  rec = $state<{ id: string; idx: number } | null>(null);
  held = $state<string[]>([]);
  conflict = $state<{ key: string; other: string; typed: string | null } | null>(null);
  message = $state<Message | null>(null);
  /** The special keys, which recording does not take from a press: Esc cancels it. */
  special = $state(false);
  note = $state<Note | null>(null);
  flash = $state<string | null>(null);
  /** The user's keys before «Reset all», to bring back. */
  beforeReset = $state<Custom | null>(null);

  /** The settings' draft the keys go into. */
  private readonly draft: () => Settings;
  /** The palette's commands as they are offered now: they may get a key too. */
  private readonly others = allCommands().map((c) => ({ id: c.id, title: c.title }));

  readonly cmds = $derived(shortcuts.commands(this.others, this.custom));
  readonly resolved = $derived(resolve(this.cmds, this.custom));
  readonly changedCount = $derived(this.cmds.filter((c) => this.isChanged(c.id)).length);
  /** Searching, or the changed ones only: every command that fits shows, folded or not. */
  readonly filtering = $derived(!!this.query.trim() || !!this.pressKey || this.onlyChanged);
  /** Commands of the palette without a key fold into one line at the end. */
  readonly folded = $derived(this.cmds.filter((c) => c.group === "other" && !this.keysOf(c.id).length && this.rec?.id !== c.id && !this.isChanged(c.id)));
  readonly lost = $derived(shortcuts.lost(this.custom, this.dismissed));

  constructor(draft: () => Settings) {
    this.draft = draft;
  }

  get custom(): Custom {
    return this.draft().keybindings?.custom ?? {};
  }

  get dismissed(): string[] {
    return this.draft().keybindings?.dismissed ?? [];
  }

  keysOf = (id: string) => this.resolved.keys[id] ?? [];
  byId = (id: string) => this.cmds.find((c) => c.id === id);
  isChanged = (id: string) => changed(this.cmds, this.custom, id);

  /** The rows of a group, as the search and the folding leave them. */
  rows(group: string): TitledCommand[] {
    return this.cmds.filter(
      (c) =>
        c.group === group &&
        (this.filtering || this.showMore || !this.folded.includes(c)) &&
        this.fits(c) &&
        // A command the palette does not offer now shows only when it has the user's key.
        (c.group !== "other" || this.others.some((o) => o.id === c.id) || this.isChanged(c.id)),
    );
  }

  private fits(c: TitledCommand): boolean {
    if (this.rec?.id === c.id) return true;
    if (this.pressKey) return this.keysOf(c.id).includes(this.pressKey);
    if (this.onlyChanged && !this.isChanged(c.id)) return false;
    return matches(this.query, c.title(), this.keysOf(c.id));
  }

  private save(next: Custom) {
    this.draft().keybindings = { custom: next, dismissed: [...this.dismissed] };
  }

  /** A plugin's notice is seen once, whether the settings are saved or not. */
  dismiss(l: Lost) {
    const next = [...this.dismissed, `${l.id}:${l.key}`];
    this.draft().keybindings = { custom: { ...this.custom }, dismissed: next };
    void app.saveSettings({ ...$state.snapshot(app.settings), keybindings: { ...app.settings.keybindings, dismissed: next } });
  }

  async start(id: string, idx: number) {
    this.rec = { id, idx };
    this.conflict = null;
    this.message = null;
    this.note = null;
    this.held = [];
    this.special = false;
    this.pressing = false;
    this.beforeReset = null;
    await tick();
    document.querySelector(".kr.recording")?.scrollIntoView({ block: "nearest" });
  }

  stop = () => {
    this.rec = null;
    this.conflict = null;
    this.message = null;
    this.held = [];
    this.special = false;
  };

  /** A press (or a special key from the menu) for the key being recorded. */
  record(key: string, typed: string | null) {
    const rec = this.rec;
    if (!rec) return;
    this.conflict = null;
    this.message = null;
    this.held = [];
    const r = take(this.cmds, this.custom, rec.id, rec.idx, key);
    if ("problem" in r) this.message = { kind: "problem", key, problem: r.problem };
    else if ("same" in r) this.message = { kind: "same", key };
    else if ("conflict" in r) this.conflict = { key, other: r.conflict.other, typed };
    else this.done(r.ok, key, typed);
    // The card or the message under the row stays in sight.
    void tick().then(() => document.querySelector(".kr.recording + .kconf")?.scrollIntoView({ block: "nearest" }));
  }

  private done(next: Custom, key: string, typed: string | null) {
    const id = this.rec!.id;
    const scope = this.byId(id)?.scope ?? "main";
    this.save(next);
    // The same key in the other window is no conflict, only worth a word.
    const keys = resolve(this.cmds, next).keys;
    const elsewhere = this.cmds.find((c) => c.id !== id && !overlaps(c.scope, scope) && keys[c.id]?.includes(key));
    this.note = elsewhere
      ? { id, kind: "elsewhere", key, other: elsewhere.title() }
      : typed && /[^\x20-\x7e]/.test(typed)
        ? { id, kind: "typed", key, typed }
        : null;
    this.stop();
    this.flash = id;
    setTimeout(() => this.flash === id && (this.flash = null), 900);
  }

  /** «Replace» or «Swap» for the key in conflict. */
  settle(how: "replace" | "swap") {
    if (!this.rec || !this.conflict) return;
    const { key, other, typed } = this.conflict;
    this.done((how === "replace" ? replace : swap)(this.cmds, this.custom, this.rec.id, this.rec.idx, key, other), key, typed);
  }

  swapProblem(): SwapProblem {
    if (!this.rec || !this.conflict) return null;
    const old = this.keysOf(this.rec.id)[this.rec.idx];
    if (!old) return { kind: "noKey" };
    if (canSwap(this.cmds, this.custom, this.rec.id, this.rec.idx, this.conflict.other)) return null;
    return { kind: "bad", key: old, other: this.byId(this.conflict.other)?.title() ?? "" };
  }

  removeRecorded() {
    const r = this.rec;
    if (r) this.save(removeKey(this.cmds, this.custom, r.id, r.idx));
    this.stop();
  }

  reset(id: string) {
    this.save(resetOne(this.custom, id));
    this.note = null;
  }

  resetAll() {
    if (!this.changedCount) return;
    const mine = { ...this.custom };
    this.stop();
    this.save({});
    this.beforeReset = mine;
  }

  undoReset() {
    this.save(this.beforeReset ?? {});
    this.beforeReset = null;
  }

  togglePressing() {
    this.pressing = !this.pressing;
    this.stop();
  }

  /** Recording and «Press» take the keys before anything else: the window's shortcuts, Esc of the dialog. */
  onDown = (e: KeyboardEvent) => {
    if (this.pressing) {
      const k = pressName(e);
      e.preventDefault();
      e.stopPropagation();
      if (!k) return;
      this.pressing = false;
      if (k !== "Escape") {
        this.pressKey = k;
        this.query = "";
      }
      return;
    }
    if (!this.rec) return;
    const k = pressName(e);
    if (!k) {
      e.preventDefault();
      e.stopPropagation();
      this.held = heldMods(e);
      return;
    }
    // Tab moves on as ever, and Enter or Space work the buttons of the card and the hint.
    const inside = !!(e.target as HTMLElement | null)?.closest?.(".kconf, .rechint");
    if (k === "Tab" || k === "Shift+Tab" || ((k === "Enter" || k === "Space") && inside)) return;
    e.preventDefault();
    e.stopPropagation();
    if (k === "Escape") return this.stop();
    // Esc, Enter, Tab and Space come from the menu of special keys.
    if (k === "Enter" || k === "Space") return;
    this.record(k, e.key.length === 1 ? e.key : null);
  };

  onUp = (e: KeyboardEvent) => {
    if (this.rec && !this.conflict && !pressName(e)) this.held = heldMods(e);
  };

  /** Listens while recording or pressing; for an effect of the component. */
  listen(): (() => void) | undefined {
    if (!this.rec && !this.pressing) return;
    window.addEventListener("keydown", this.onDown, true);
    window.addEventListener("keyup", this.onUp, true);
    return () => {
      window.removeEventListener("keydown", this.onDown, true);
      window.removeEventListener("keyup", this.onUp, true);
    };
  }
}

export function useKeyEditor(draft: () => Settings): KeyEditor {
  return new KeyEditor(draft);
}
