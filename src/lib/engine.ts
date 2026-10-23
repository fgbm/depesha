// What the web engine does on its own — the menu of the right button, «select all», the keys that
// reload the page — and Depesha keeps out of its windows. Depesha is not a browser: a menu with
// «Back», «Reload», «Save page as» and «Inspect» says nothing about a letter, and a selection over
// the interface is not text the user asked to copy. The engine's menu stays where it earns its
// place (fields and editors carry cut, copy, paste and the spelling corrections), and so does the
// selection. Covered by engine.test.ts.

/** Fields and editors: the engine's own menu there is the useful one. */
export const EDITORS = "input, textarea, [contenteditable], .cm-editor";

/** Text Depesha lets the user select and copy: the letter's header, its body, errors, viewers. */
export const SELECTABLE = ".selectable";

/** Everywhere the user may select text, for the keys that belong to the document. */
const TEXT = `${EDITORS}, ${SELECTABLE}`;

/** What a press or a click landed in, as an element: a text node and `window` have no `closest`. */
const within = (target: EventTarget | null, selector: string): boolean => ((target as Element | null)?.closest?.(selector) ?? null) !== null;

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
  // The default action of the engine is all this takes, not the event: the window's own handlers,
  // which run either side of this one, keep their presses.
  doc.addEventListener("keydown", onKey, true);
  return () => doc.removeEventListener("keydown", onKey, true);
}
