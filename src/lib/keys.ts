/** What a key press means for shortcuts, whatever the keyboard layout. */
export interface KeyPress {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

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

/** The character the key types, letters in lower case; non-printable keys by name. */
export function typedKey(e: KeyPress): string {
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

/**
 * The same physical key on the US layout: on the Russian one "j" types "о",
 * "#" (Shift+3) types "№" and "/" types ".", yet shortcuts stay where the hands
 * know them. Undefined for keys without a US character.
 */
export function usKey(e: KeyPress): string | undefined {
  if (e.key.length !== 1) return undefined;
  const letter = /^Key([A-Z])$/.exec(e.code);
  if (letter) return letter[1].toLowerCase();
  const chars = US[e.code];
  return chars ? chars[e.shiftKey ? 1 : 0] : undefined;
}

/**
 * Names to look a shortcut up by, best first: what the key types (a German "#"
 * key is "#"), then the US key in its place (Russian "о" is "j").
 */
export function shortcutKeys(e: KeyPress): string[] {
  const typed = typedKey(e);
  const us = usKey(e);
  return us && us !== typed ? [typed, us] : [typed];
}

/** "Mod+k", "h", "Delete": how plugins name keys; the same candidates as `shortcutKeys`. */
export function keyNames(e: KeyPress): string[] {
  const mods = (e.ctrlKey || e.metaKey ? "Mod+" : "") + (e.altKey ? "Alt+" : "");
  return shortcutKeys(e).map((k) => mods + k);
}
