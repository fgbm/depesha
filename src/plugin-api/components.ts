// The core's components a plugin may draw, each with the props it is promised. The props are
// written out here and not taken from the component: the component may grow props for the core's
// own use, a plugin sees and relies on these only. Assigning the component to its contract type is
// what makes the compiler check that the promise holds.

import type { Component, Snippet } from "svelte";
import PopoverImpl from "../components/Popover.svelte";
import SelectImpl from "../components/Select.svelte";
import KeysImpl from "../components/Keys.svelte";
import LaterMenuImpl from "../components/LaterMenu.svelte";
import type { Preset } from "../lib/later";

export interface PopoverProps {
  /** Bind it: the menu closes itself on Escape and on a click outside. */
  open: boolean;
  /** The edge of the parent the menu lines up with; the parent is the element the menu sits in. */
  align?: "left" | "right";
  /** The menu is at least as wide as its parent. */
  matchWidth?: boolean;
  role?: "menu" | "listbox";
  children: Snippet;
}

export interface SelectProps<T> {
  /** Bind it, or follow `onchange`. */
  value: T;
  options: { value: T; label: string }[];
  onchange?: (value: T) => void;
  title?: string;
  /** Accessible name when no <label> wraps the list. */
  label?: string;
  disabled?: boolean;
  class?: string;
}

export interface KeysProps {
  /** A key as menus and the palette show it, `e у`: `Mod+k`, `Shift+r`, `h`. */
  key?: string;
  /** Or the key a command has as the user set it; nothing for a command without a key. */
  of?: string;
}

export interface LaterMenuProps {
  /** The heading over the moments. */
  title: string;
  presets: Preset[];
  /** The label of the button that takes the moment typed by hand. */
  action: string;
  /** The moment chosen, in unix seconds. */
  onPick: (at: number) => void;
}

/** A menu that hangs under its parent and takes the focus. */
export const Popover: Component<PopoverProps, object, "open"> = PopoverImpl;

/** A drop-down list drawn like the app's menus, in place of the system <select>. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Select: Component<SelectProps<any>, object, "value"> = SelectImpl;

/** A key with the Russian letter of the same key beside it. */
export const Keys: Component<KeysProps> = KeysImpl;

/** The content of a «later» menu: the moments to pick and a field for one's own. Goes in a `Popover`. */
export const LaterMenu: Component<LaterMenuProps> = LaterMenuImpl;
