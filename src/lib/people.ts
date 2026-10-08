// The address book and the rules of a person (#66, #44). The book is built on the table of
// addresses the cache already keeps for completion: every address of the correspondence is
// in it, and a person's own record holds what the user decided about them — the name to
// show, the format to write in, the form to show their letters, a note, and whether to
// keep the address out of completion. One person is one address in 0.7: joining several
// addresses into one person is a task of its own. The rules leave the address book for the
// places that need them: the compose window writes by them, the reader shows by them.
import type { BodyFormat, LetterViewPref, MessageView, ViewRule } from "./types";
export type { ViewRule } from "./types";

/** A person of the book: their record, or one only found in the correspondence. */
export interface Person {
  /** The address the record is kept by; addresses are told apart without their case. */
  email: string;
  /** The name shown and offered in completion: the user's own over the letters' spelling. */
  name: string;
  /** Which format letters to them are written in; "" follows the mailbox. */
  send_format: BodyFormat | "";
  /** Which form of their letters the reader shows; "" follows the mailbox, then the app. */
  view: ViewRule;
  note: string;
  /** Kept out of address completion. */
  hidden: boolean;
  /** Added by hand; one seen only in the correspondence is not. */
  manual: boolean;
  /** The hint that set a rule (#69); "" when it was set by hand. */
  via: string;
  /** Letters carrying the address, both ways. */
  uses: number;
}

/** A person's record with every field set; what a new one starts as. */
export function blankPerson(email: string): Person {
  return { email, name: "", send_format: "", view: "", note: "", hidden: false, manual: false, via: "", uses: 0 };
}

/** The address book's record of an address, wherever the address is spelled with case. */
export function findPerson(people: Person[], email: string): Person | undefined {
  const want = email.trim().toLowerCase();
  return people.find((p) => p.email.toLowerCase() === want);
}

// ---- Format of what is written (#44) ----

/**
 * How much of a letter each format keeps, from the least to the most: plain text parts
 * alone, HTML with its text, Markdown with its text and its HTML. The strictest rule of the
 * recipients is what the letter can carry.
 */
const RANK: Record<BodyFormat, number> = { plain: 0, html: 1, markdown: 2 };

/** The strictest of the formats: the one that keeps the least. */
export function strictestFormat(formats: BodyFormat[]): BodyFormat {
  return formats.reduce<BodyFormat>((a, b) => (RANK[b] < RANK[a] ? b : a), "markdown");
}

/** The format letters to this person are written in: their rule, else the mailbox's. */
export function sendFormatFor(person: Person | undefined, mailbox: BodyFormat): BodyFormat {
  return person?.send_format || mailbox;
}

/** What a letter to these recipients can carry, and the address that forced it. */
export interface RecipientParts {
  /** The strictest of the recipients' formats: the parts the letter goes with. */
  parts: BodyFormat;
  /** The recipient whose rule is the strictest, when it is their own and not the mailbox's. */
  by: string | null;
}

/**
 * The parts of a letter to several recipients: the strictest of their rules, the mailbox's
 * standing for the ones without a rule. The address that forced it is named, so the window
 * can say whose rule drops the Markdown part (#44, frame 13).
 */
export function recipientParts(people: Person[], addresses: string[], mailbox: BodyFormat): RecipientParts {
  const formats = addresses.map((a) => sendFormatFor(findPerson(people, a), mailbox));
  const parts = strictestFormat(formats);
  // Only a rule of a person counts as the cause; the mailbox's format is no one's rule.
  const by = addresses.find((a) => findPerson(people, a)?.send_format === parts) ?? null;
  return { parts, by };
}

/**
 * The format the window switches to on its own for these recipients, or null to keep the
 * one it is already in. Only the strictest rule, plain text, takes the formatting away
 * silently: it is the one that would be lost unseen (#44, frame 13). A letter that already
 * carries a quote — a reply or a forward — is left alone whatever it has typed: rewriting
 * the quoted letter would lose its formatting and pictures, so the line only offers the
 * switch instead.
 */
export function autoFormat(current: BodyFormat, parts: BodyFormat, hasQuote = false): BodyFormat | null {
  if (hasQuote) return null;
  return parts === "plain" && current !== "plain" ? "plain" : null;
}

// ---- Form of what is shown (#44) ----

/**
 * The form the reader shows the letters of a sender in: the person's rule, else the
 * mailbox's, else the app's. A letter's own switch above it overrides all three.
 */
export function letterViewFor(person: ViewRule, mailbox: ViewRule, app: LetterViewPref): LetterViewPref {
  const chosen = person || mailbox;
  return chosen === "" ? app : chosen;
}

/** Whether a person's record holds a rule of the sender different from the mailbox's. */
export function hasOwnRule(person: Person | undefined): boolean {
  return !!person && (person.send_format !== "" || person.view !== "");
}

/** The mark of a format beside an address (#44, frame 12): MD, HTML or T. */
export function formatMark(format: BodyFormat): string {
  return format === "markdown" ? "MD" : format === "html" ? "HTML" : "T";
}

/** The sender's address of a letter, for a rule that read it. */
export function senderEmail(view: Pick<MessageView, "summary">): string {
  return view.summary.from?.email ?? "";
}

// ---- Finding one's way in the book (#66, frame 10) ----

/** A filter over the list. */
export type PeopleFilter = "all" | "ruled" | "manual" | "hidden";

/** Whether a person matches the search over their name, address and note. */
export function matchPerson(person: Person, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    person.name.toLowerCase().includes(q) || person.email.toLowerCase().includes(q) || person.note.toLowerCase().includes(q)
  );
}

/** The people a filter keeps: everyone, those with a rule, those added by hand, the hidden. */
export function filterPeople(people: Person[], filter: PeopleFilter): Person[] {
  switch (filter) {
    case "ruled":
      return people.filter((p) => p.send_format !== "" || p.view !== "");
    case "manual":
      return people.filter((p) => p.manual);
    case "hidden":
      return people.filter((p) => p.hidden);
    case "all":
      return people;
  }
}
