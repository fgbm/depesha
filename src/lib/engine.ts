// What the web engine does on its own — the menu of the right button, «select all», the keys that
// reload the page — and Depesha keeps out of its windows. Depesha is not a browser: a menu with
// «Back», «Reload», «Save page as» and «Inspect» says nothing about a letter, and a selection over
// the interface is not text the user asked to copy. The engine's menu stays where it earns its
// place (fields and editors carry cut, copy, paste and the spelling corrections), and so does the
// selection. A press on text moves no focus, so the press is remembered: Ctrl+A in a letter takes
// the text of the letter (textZone), and Ctrl+A in the list chooses the letters. Covered by
// engine.test.ts.

/** Fields and editors: the engine's own menu there is the useful one. */
export const EDITORS = "input, textarea, [contenteditable], .cm-editor";

/** Text Depesha lets the user select and copy: the letter's header, its body, errors, viewers. */
export const SELECTABLE = ".selectable";

/** Everywhere the user may select text, for the keys that belong to the document. */
const TEXT = `${EDITORS}, ${SELECTABLE}`;

/** The `selector` element a press or a click landed in; null when it landed elsewhere. A text node has no `closest`. */
const zoneOf = (target: EventTarget | null, selector: string): Element | null => (target as Element | null)?.closest?.(selector) ?? null;

/** Whether a press or a click landed in `selector`. */
const within = (target: EventTarget | null, selector: string): boolean => zoneOf(target, selector) !== null;

/** Where the last press landed: a click on text leaves the focus on the page's own body. */
let pressed: EventTarget | null = null;

/** Whether the engine's menu belongs on this press: a field, an editor, or text chosen to copy. */
export function engineMenuWanted(target: EventTarget | null, chosen: boolean): boolean {
  return chosen || within(target, EDITORS);
}

/** Whether the text chosen in `doc` is worth a menu: a click leaves an empty selection behind. */
export function textChosen(doc: Document): boolean {
  const s = doc.getSelection();
  return !!s && !s.isCollapsed && s.toString().trim() !== "";
}

/** Stops the engine's menu in `doc` wherever it is not the useful one; returns the way to undo it. */
export function keepEngineMenuOut(doc: Document = document): () => void {
  const onMenu = (e: Event) => {
    if (engineMenuWanted(e.target, textChosen(doc))) return;
    e.preventDefault();
  };
  doc.addEventListener("contextmenu", onMenu);
  return () => doc.removeEventListener("contextmenu", onMenu);
}

/** Whether this press of Ctrl+A belongs to the document: a field, an editor, or text to select. */
export function selectAllWanted(target: EventTarget | null): boolean {
  return within(target, TEXT);
}

/**
 * The text zone Ctrl+A takes: the one the focus is in, or, when the focus stayed on the page
 * itself (a click on text moves it nowhere), the one the last press landed in.
 */
export function textZone(target: EventTarget | null, doc: Document = document): Element | null {
  const el = target instanceof Element && target !== doc.body && target !== doc.documentElement ? target : pressed;
  return zoneOf(el, SELECTABLE);
}

/** Chooses the whole text of `zone`, as Ctrl+A does in a field; false when there is nothing to choose. */
export function selectZone(zone: Element | null, doc: Document = document): boolean {
  if (!zone) return false;
  const range = doc.createRange();
  range.selectNodeContents(zone);
  if (!range.toString().trim()) return false;
  const selection = doc.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** A press the engine must not act on: reloading the page, or the inspector of a built app. */
export function engineKey(e: KeyboardEvent, release: boolean): boolean {
  if (!release) return false;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (e.key === "F5" || e.key === "F12") return !e.altKey;
  return mod && !e.altKey && (key === "r" || (e.shiftKey && key === "i"));
}

/**
 * Keeps the keys of the document and of the app apart in `doc`, for the whole window: `Ctrl+A`
 * stops at the text the user may select, and a built app has no page to reload. The app's own
 * commands (`Ctrl+A` chooses every letter, `Ctrl+P` prints the open one) run as they did: this
 * listener only takes the engine's default, it does not stop the event. Returns the way to undo it.
 */
export function keepEngineHandsOff(doc: Document = document, release = true): () => void {
  const onKey = (e: KeyboardEvent) => {
    const selectAll = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a";
    if (selectAll ? !selectAllWanted(e.target) : engineKey(e, release)) e.preventDefault();
  };
  // A press says where the user is when the focus does not: Ctrl+A in a letter reads it (textZone).
  const onPress = (e: Event) => {
    pressed = e.target;
  };
  // The default action of the engine is all this takes, not the event: the window's own handlers,
  // which run either side of this one, keep their presses.
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("pointerdown", onPress, true);
  return () => {
    doc.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("pointerdown", onPress, true);
  };
}
