// Which form of a letter the reader shows: its HTML, its Markdown or its plain text.
// A letter offers them in `multipart/alternative`, the sender's favourite last; the
// setting «Показывать письма» may prefer Markdown or plain text, and the switch above
// the letter overrides both for as long as it is open.
import type { BodyView, LetterViewPref, MessageView, ViewRule } from "./types";

type Forms = Pick<MessageView, "html" | "text" | "markdown" | "views">;

/** The switch's order, whatever the letter's. */
export const SWITCH_ORDER: readonly BodyView[] = ["html", "markdown", "text"];

/** The letter has this form, and something to show in it. */
export function hasView(view: Forms, form: BodyView): boolean {
  const content = form === "html" ? view.html : form === "markdown" ? view.markdown : view.text;
  if (content == null) return false;
  // Letters read before the forms were told apart: HTML when there is some, else text.
  return view.views ? view.views.includes(form) : form !== "markdown";
}

/** The form the sender put last: the one they meant to be read. */
export function senderView(view: Forms): BodyView {
  const last = [...(view.views ?? [])].reverse().find((v) => hasView(view, v));
  return last ?? (view.html != null ? "html" : "text");
}

/**
 * What asks for the form: the sender's rule, else the mailbox's, else the setting. An empty
 * rule leaves it to the next one. The switch above the letter, picked by hand, comes before all.
 */
export function effectivePref(person: ViewRule | null | undefined, mailbox: ViewRule | null | undefined, setting: LetterViewPref): LetterViewPref {
  return person || mailbox || setting;
}

/** The form the setting asks for, when the letter has it; the sender's otherwise. */
export function preferredView(view: Forms, pref: LetterViewPref): BodyView {
  if (pref !== "sender" && hasView(view, pref)) return pref;
  return senderView(view);
}

/**
 * The forms the switch above the letter offers, none when it stays hidden. It shows
 * for a letter with Markdown, and for one the setting shows otherwise than its sender
 * meant: the way back to the sender's form is a click away.
 */
export function switchViews(view: Forms, pref: LetterViewPref): BodyView[] {
  const offered = SWITCH_ORDER.filter((v) => hasView(view, v));
  if (offered.length < 2) return [];
  return hasView(view, "markdown") || preferredView(view, pref) !== senderView(view) ? offered : [];
}
