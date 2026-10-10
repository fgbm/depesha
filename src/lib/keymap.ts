// Keys of commands, as the user may change them (#46): how a press is named, how a key
// is labelled, what may not be assigned, conflicts, and which command a key runs once
// the user's keys, the core's and the plugins' are put together. Pure: the reactive
// side is shortcuts.svelte.ts. Covered by keymap.test.ts.
//
// A key is named as plugins name it: modifiers in the order Mod, Shift, Alt, then the
// key: "Mod+Shift+p", "Shift+r", "#", "ArrowDown". Letters by their Latin letter, so
// the Russian "у" is "e" (docs/ux.md, principle 5); a character typed with Shift holds
// it ("#" is Shift+3, not "Shift+3").

import { isMac } from "./platform";

/** A key press, as the DOM delivers it; the fields the key naming reads. */
export interface KeyPress {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** `main`: the main window outside text fields; `compose`: the composition window; `all`: both. */
export type Scope = "main" | "compose" | "all";
/** The group on the «Keys» page. */
export type Group = "everywhere" | "list" | "compose" | "other";

export interface KeyCommand {
  id: string;
  /** Default keys, best first: the first is the one menus and tooltips show. */
  keys: string[];
  scope: Scope;
  group: Group;
  /** "core" or the plugin's id. */
  owner: string;
  /** Its key is not changed: Ctrl+K of the palette. */
  locked?: boolean;
}

/** The user's keys by command id; a command missing here has its default ones. */
export type Custom = Record<string, string[]>;

/** Ctrl+K opens the palette everywhere and is not reassigned. */
export const PALETTE_KEY = "Mod+k";
/** Copy, paste and cut stay with the system. */
const SYSTEM = ["Mod+c", "Mod+v", "Mod+x"];

/** Characters of the US layout, by physical key: plain and with Shift. */
const US: Record<string, [string, string]> = {
  Digit1: ["1", "!"],
  Digit2: ["2", "@"],
  Digit3: ["3", "#"],
  Digit4: ["4", "$"],
  Digit5: ["5", "%"],
  Digit6: ["6", "^"],
  Digit7: ["7", "&"],
  Digit8: ["8", "*"],
  Digit9: ["9", "("],
  Digit0: ["0", ")"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  Backquote: ["`", "~"],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
};

/** What the same key types on the Russian layout: the second label of a key cap. */
const RU: Record<string, string> = { "#": "№", "?": ",", $: ";", "^": ":", "&": "?", "@": '"' };
[..."qwertyuiop[]asdfghjkl;'zxcvbnm,./`"].forEach((c, i) => (RU[c] = "йцукенгшщзхъфывапролджэячсмитьбю.ё"[i]));
/** A Russian letter back to the key it sits on: "у" → "e". */
const FROM_RU: Record<string, string> = {};
for (const [k, v] of Object.entries(RU)) if (/[а-яё№]/.test(v)) FROM_RU[v] = k;

const MODIFIERS = ["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "OS", "Super", "Hyper"];

function mods(e: KeyPress, shift: boolean): string {
  return (e.ctrlKey || e.metaKey ? "Mod+" : "") + (shift && e.shiftKey ? "Shift+" : "") + (e.altKey ? "Alt+" : "");
}

/** Shift goes into the name only of letters and named keys: "#" holds its Shift. */
const holdsShift = (k: string) => k.length === 1 && !/[a-z]/.test(k);

/** The key as typed: a printable character in lower case, or the key's name. */
function typed(e: KeyPress): string {
  if (e.key === " ") return "Space";
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

/** The US key in the same place, if the key types a character. */
function physical(e: KeyPress): string | undefined {
  // A dead key (macOS Option+I, Option+E…) types nothing yet, but sits on a key all the same.
  if (e.key.length !== 1 && e.key !== "Dead") return undefined;
  const letter = /^Key([A-Z])$/.exec(e.code);
  if (letter) return letter[1].toLowerCase();
  const chars = US[e.code];
  return chars ? chars[e.shiftKey ? 1 : 0] : undefined;
}

const named = (e: KeyPress, k: string) => mods(e, !holdsShift(k)) + k;

/**
 * The name to save a press under, or null while only modifiers are held. A layout
 * that types a Latin letter keeps it (the German "z" is z); otherwise it is the US key
 * in the same place: the Russian "у" is e, "№" is #, "." is /.
 */
export function pressName(e: KeyPress): string | null {
  if (MODIFIERS.includes(e.key)) return null;
  const t = typed(e);
  const k = /^[a-z]$/.test(t) ? t : (physical(e) ?? t);
  return named(e, k);
}

/** Names a press may go by, best first: what it types, then the US key in its place. */
export function pressNames(e: KeyPress): string[] {
  const t = typed(e);
  const us = physical(e);
  // Only ASCII is ever a key name: the Russian "о" goes by its place alone.
  const out = /^[\x20-\x7e]$/.test(t) || t.length > 1 ? [named(e, t)] : [];
  if (us && us !== t) out.push(named(e, us));
  return out;
}

/** The modifiers held while recording: "Ctrl + …". */
export function heldMods(e: KeyPress): ("Mod" | "Shift" | "Alt")[] {
  const out: ("Mod" | "Shift" | "Alt")[] = [];
  if (e.ctrlKey || e.metaKey) out.push("Mod");
  if (e.shiftKey) out.push("Shift");
  if (e.altKey) out.push("Alt");
  return out;
}

export interface Cap {
  main: string;
  /** The Russian letter of the same key, as engraved on a keyboard. */
  legend?: string;
}

const NAMES: Record<string, string> = { ArrowDown: "↓", ArrowUp: "↑", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc" };

/** What "Mod" is called on this system: ⌘ on macOS, Ctrl elsewhere. Alt and Shift keep their words. */
export function modName(mac = isMac()): string {
  return mac ? "⌘" : "Ctrl";
}

function partName(p: string, lang: string, mac: boolean): string {
  if (p === "Space") return lang === "ru" ? "Пробел" : "Space";
  if (p === "Mod") return modName(mac);
  return NAMES[p] ?? p;
}

/**
 * The key caps of a key. A single key and Shift+key get the Russian letter of the same
 * key as a second label (`e у`); with Ctrl or Alt it would only be noise.
 */
export function caps(key: string, lang: string, mac = isMac()): Cap[] {
  const parts = key.split("+");
  // "Mod++" would be Ctrl and "+": the last part may itself be "+".
  const k = key.endsWith("++") ? "+" : (parts.pop() as string);
  if (key.endsWith("++")) parts.splice(-2);
  const out: Cap[] = parts.map((m) => ({ main: partName(m, lang, mac) }));
  const main = k.length === 1 && /[a-z]/.test(k) && parts.length ? k.toUpperCase() : partName(k, lang, mac);
  let legend = lang === "ru" && k.length === 1 && !parts.includes("Mod") && !parts.includes("Alt") ? RU[k] : undefined;
  if (legend === main) legend = undefined;
  if (legend && parts.length) legend = legend.toUpperCase();
  out.push(legend ? { main, legend } : { main });
  return out;
}

/** The key in one line, for tooltips and menus: "Ctrl+Shift+P", "e/у". */
export function keyText(key: string, lang: string, mac = isMac()): string {
  const c = caps(key, lang, mac);
  const last = c[c.length - 1];
  return c.map((x) => x.main).join("+") + (last.legend ? `/${last.legend}` : "");
}

export type Problem = { kind: "system" } | { kind: "palette" } | { kind: "letter" };

/** Why the key may not go to a command working in `scope`, if it may not. */
export function problem(key: string, scope: Scope): Problem | null {
  if (SYSTEM.includes(key)) return { kind: "system" };
  if (key === PALETTE_KEY) return { kind: "palette" };
  if (scope !== "main") {
    const k = key.split("+").pop() as string;
    const withMod = key.startsWith("Mod+") || key.includes("Alt+");
    // A key that types nothing is fine: Esc folds the window, F-keys type nothing.
    if (!withMod && key !== "Escape" && !/^F\d+$/.test(k)) return { kind: "letter" };
  }
  return null;
}

/** Both commands work at the same time, so one key cannot run both. */
export function overlaps(a: Scope, b: Scope): boolean {
  return a === b || a === "all" || b === "all";
}

export interface Lost {
  /** The command left without its default key. */
  id: string;
  key: string;
  /** Who has the key. */
  holder: string;
}

export interface Resolved {
  keys: Record<string, string[]>;
  lost: Lost[];
}

/**
 * Every command's keys. A key stays with whoever took it first: the user's own keys,
 * then the core's defaults, then the plugins' in the order they came. A default key
 * that is taken is dropped, and `lost` says so: a plugin cannot take a key quietly.
 */
export function resolve(cmds: KeyCommand[], custom: Custom): Resolved {
  const keys: Record<string, string[]> = {};
  const lost: Lost[] = [];
  const taken: { key: string; scope: Scope; id: string }[] = [];
  const holder = (key: string, scope: Scope) => taken.find((t) => t.key === key && overlaps(t.scope, scope))?.id;
  const own = (c: KeyCommand) => !c.locked && Object.hasOwn(custom, c.id);
  const tiers = [
    cmds.filter((c) => own(c) && c.owner === "core"),
    cmds.filter((c) => own(c) && c.owner !== "core"),
    cmds.filter((c) => !own(c) && c.owner === "core"),
    cmds.filter((c) => !own(c) && c.owner !== "core"),
  ];
  for (const tier of tiers) {
    for (const c of tier) {
      const mine = own(c);
      const list: string[] = [];
      for (const key of mine ? custom[c.id] : c.keys) {
        const by = holder(key, c.scope);
        if (by === undefined) {
          list.push(key);
          taken.push({ key, scope: c.scope, id: c.id });
        } else if (by !== c.id && !mine) lost.push({ id: c.id, key, holder: by });
      }
      keys[c.id] = list;
    }
  }
  return { keys, lost };
}

/** The command a press runs among those working in `scopes`: names best first. */
export function findCommand(r: Resolved, cmds: KeyCommand[], names: string[], scopes: Scope[]): string | undefined {
  for (const name of names) {
    const c = cmds.find((c) => scopes.includes(c.scope) && r.keys[c.id]?.includes(name));
    if (c) return c.id;
  }
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

/** The user's keys with this command's set to `keys`; equal to the defaults, it is dropped. */
export function setKeys(cmds: KeyCommand[], custom: Custom, id: string, keys: string[]): Custom {
  const next = { ...custom };
  const def = cmds.find((c) => c.id === id)?.keys ?? [];
  if (same(def, keys)) delete next[id];
  else next[id] = [...new Set(keys)];
  return next;
}

/** Changed by the user: has keys of its own other than the defaults. */
export function changed(cmds: KeyCommand[], custom: Custom, id: string): boolean {
  const def = cmds.find((c) => c.id === id)?.keys ?? [];
  return Object.hasOwn(custom, id) && !same(def, custom[id]);
}

export function resetOne(custom: Custom, id: string): Custom {
  const next = { ...custom };
  delete next[id];
  return next;
}

export type Take = { ok: Custom } | { problem: Problem } | { same: true } | { conflict: { other: string } };

/**
 * Puts `key` at place `idx` of the command's keys (`idx` past the end adds one).
 * A free key is taken at once; a key held by another command working at the same
 * time is a conflict for the user to settle (`replace`, `swap` or nothing).
 */
export function take(cmds: KeyCommand[], custom: Custom, id: string, idx: number, key: string): Take {
  const cmd = cmds.find((c) => c.id === id);
  if (!cmd) return { ok: custom };
  if (cmd.locked) return { problem: { kind: "palette" } };
  const bad = problem(key, cmd.scope);
  if (bad) return { problem: bad };
  const r = resolve(cmds, custom);
  const mine = r.keys[id] ?? [];
  if (mine[idx] === key) return { ok: custom };
  if (mine.includes(key)) return { same: true };
  const other = cmds.find((c) => c.id !== id && overlaps(c.scope, cmd.scope) && r.keys[c.id]?.includes(key));
  if (other) return { conflict: { other: other.id } };
  return { ok: put(cmds, custom, r, id, idx, key) };
}

function put(cmds: KeyCommand[], custom: Custom, r: Resolved, id: string, idx: number, key: string): Custom {
  const keys = [...(r.keys[id] ?? [])];
  if (idx < keys.length) keys[idx] = key;
  else keys.push(key);
  return setKeys(cmds, custom, id, keys);
}

/** Settles a conflict: the key goes to `id`, the other command loses it. */
export function replace(cmds: KeyCommand[], custom: Custom, id: string, idx: number, key: string, other: string): Custom {
  const r = resolve(cmds, custom);
  const rest = (r.keys[other] ?? []).filter((k) => k !== key);
  return put(cmds, setKeys(cmds, custom, other, rest), r, id, idx, key);
}

/** The other command may take the key `id` gives up: there was one, and it suits it. */
export function canSwap(cmds: KeyCommand[], custom: Custom, id: string, idx: number, other: string): boolean {
  const old = resolve(cmds, custom).keys[id]?.[idx];
  const o = cmds.find((c) => c.id === other);
  return !!old && !!o && !o.locked && problem(old, o.scope) === null;
}

/** Settles a conflict: the commands trade keys. */
export function swap(cmds: KeyCommand[], custom: Custom, id: string, idx: number, key: string, other: string): Custom {
  const r = resolve(cmds, custom);
  const old = r.keys[id][idx];
  const theirs = (r.keys[other] ?? []).map((k) => (k === key ? old : k));
  return put(cmds, setKeys(cmds, custom, other, theirs), r, id, idx, key);
}

export function removeKey(cmds: KeyCommand[], custom: Custom, id: string, idx: number): Custom {
  const keys = [...(resolve(cmds, custom).keys[id] ?? [])];
  keys.splice(idx, 1);
  return setKeys(cmds, custom, id, keys);
}

/** The key as search text: "Ctrl+L", "e". */
const plain = (key: string) => keyText(key, "en").toLowerCase();

/**
 * The search on the «Keys» page. One character is a key, Russian or Latin ("у" finds e,
 * not every title with "у"); from two on, titles and key names ("ctrl") too.
 */
export function matches(query: string, title: string, keys: string[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (q.length === 1) {
    const k = FROM_RU[q] ?? q;
    return keys.includes(k) || keys.includes(q);
  }
  return title.toLowerCase().includes(q) || keys.some((k) => plain(k).includes(q));
}
