// The address book and the rules of a person (#66, #44, #104). The book is built on the
// table of addresses the cache already keeps: every address of the correspondence is in it,
// and a person's own record holds what the user decided about them — the name to show, the
// format to write in, the form to show their letters, a note, and whether to keep them out
// of completion. A person has one address or several; one without a record is a person of
// that one address. The rules leave the address book for the places that need them: the
// compose window writes by them, the reader shows by them.
import type { BodyFormat, LetterViewPref, MessageView, ViewRule } from "./types";
export type { ViewRule } from "./types";

/** One address of a person. */
export interface PersonAddress {
  email: string;
  /** The one shown in the list and offered first in completion; one per person. */
  primary: boolean;
  /** Letters carrying the address. */
  uses: number;
  /** The name the letters give the address; kept apart from the person's own. */
  name: string;
}

/** A person of the book: their record, or one only found in the correspondence. */
export interface Person {
  /** The record's key; 0 for a person without a record. */
  id: number;
  /** The primary address. */
  email: string;
  /** Every address, the primary one first. */
  emails: PersonAddress[];
  /** The name shown and offered in completion: the user's own over the letters' spelling. */
  name: string;
  /** Which format letters to them are written in; "" follows the mailbox. */
  send_format: BodyFormat | "";
  /** Which form of their letters the reader shows; "" follows the mailbox, then the app. */
  view: ViewRule;
  note: string;
  /** Kept out of address completion, by every address. */
  hidden: boolean;
  /** Added by hand; one seen only in the correspondence is not. */
  manual: boolean;
  /** The hint that set a rule (#69); "" when it was set by hand. */
  via: string;
  /** Letters carrying any of the addresses. */
  uses: number;
  /** An address is in the correspondence: forgetting the person then only takes the mark off (the backend's say, not the count of letters). */
  heard: boolean;
}

/** What a merge asks the backend for (see `mergeRequest`). */
export interface Merge {
  emails: string[];
  name: string;
  primary: string;
  send_format: BodyFormat | "";
  view: ViewRule;
  hidden: boolean;
}

/** What a merge or a split changed, as it was: handed back, it restores everything. Opaque here. */
export type Snapshot = Record<string, unknown>;

export interface Merged {
  person: Person;
  undo: Snapshot;
}

export interface Split {
  /** The address that left, now a person of its own. */
  person: Person;
  /** The person it left. */
  origin: Person;
  undo: Snapshot;
}

/** The answer to forgetting a person: gone whole, or only unmarked «added by hand» (an address in the correspondence keeps them), and the way back. */
export interface Forgotten {
  removed: boolean;
  unmarked: boolean;
  undo: Snapshot;
}

/** The answer to adding an address: the person, or — when the address is another's — that person. */
export interface Added {
  person: Person | null;
  owner: Person | null;
}

/** A person for address completion: the address to insert, and the person's other addresses to choose. */
export interface Suggestion {
  email: string;
  name: string | null;
  /** Every address of the person, the one to insert first. */
  emails: string[];
}

/** A person's record with every field set; what a new one starts as. */
export function blankPerson(email: string): Person {
  return {
    id: 0,
    email,
    emails: [{ email, primary: true, uses: 0, name: "" }],
    name: "",
    send_format: "",
    view: "",
    note: "",
    hidden: false,
    manual: false,
    via: "",
    uses: 0,
    heard: false,
  };
}

/** The addresses of a person, whatever the shape they came in. */
export function addressesOf(person: Person): string[] {
  return person.emails?.length ? person.emails.map((a) => a.email) : [person.email];
}

/** Whether the address is one of the person's, wherever it is spelled with case. */
export function hasAddress(person: Person, email: string): boolean {
  const want = email.trim().toLowerCase();
  return addressesOf(person).some((a) => a.toLowerCase() === want);
}

/** The address book's record of an address — any of a person's — wherever it is spelled with case. */
export function findPerson(people: Person[], email: string): Person | undefined {
  const want = email.trim().toLowerCase();
  return people.find((p) => p.email.toLowerCase() === want) ?? people.find((p) => hasAddress(p, want));
}

/** The search that finds the letters of a person, from any of their addresses (#104, 4.2 А). */
export function allMailQuery(person: Pick<Person, "email" | "emails">): string {
  const all = (person.emails?.length ? person.emails.map((a) => a.email) : [person.email]).map((a) => a.replace(/"/g, ""));
  // The search splits on spaces outside quotes and takes no escape: a value with a space goes in quotes whole.
  const value = all.join("|");
  return /\s/.test(value) ? `from:"${value}"` : `from:${value}`;
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
    person.name.toLowerCase().includes(q) ||
    addressesOf(person).some((a) => a.toLowerCase().includes(q)) ||
    person.note.toLowerCase().includes(q)
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
