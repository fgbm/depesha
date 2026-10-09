// Duplicates and merges of the address book (#104). Pure: the book is handed in and the
// answer handed back; the store of the book (peopleBook.svelte.ts) asks the backend to do it.
// Two people are taken for one by their names (the same words, whatever their order, the
// case, ё and е, the punctuation) or by the same first part of an address before the «@»
// at different domains; the user decides, and a refusal is remembered for the pair.
import { addressesOf, strictestFormat, type Person } from "./people";
import type { BodyFormat, ViewRule } from "./types";

/** The hint id the backend keeps «these are two people» under, one row per pair of addresses. */
export const SAME_PERSON = "same-person";

/** An address part shorter than this says nothing: «a@», «ivan» is a name but «ab» is not. */
const MIN_LOCAL = 4;
/** More people than this under one address part is a role (`info@`, `booking@`), not a person. */
const MAX_SHARED = 4;

/** The words of a name, in order of the alphabet: «Смирнова Ольга» and «Ольга Смирнова» agree. */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/** The first part of an address, before the «@», without its case. */
export function localPart(email: string): string {
  return email.split("@")[0].trim().toLowerCase();
}

/** The subject of the refusal «not one person» for two addresses: the pair, sorted, without case. */
export function pairSubject(a: string, b: string): string {
  const [x, y] = [a.trim().toLowerCase(), b.trim().toLowerCase()].sort();
  return `${x}|${y}`;
}

export interface Duplicate {
  a: Person;
  b: Person;
  /** What gave them away: the same name, or the same first part of an address. */
  why: "name" | "address";
  /** The shared first part of an address, for «address». */
  local: string;
}

/** What tells a person from the others in a list: the record's key, else the address. */
export const personKey = (p: Person) => (p.id ? `#${p.id}` : p.email.toLowerCase());
const identity = personKey;

/** Whether the user said these two are not one person, by any pair of their addresses. */
export function refusedPair(a: Person, b: Person, refused: ReadonlySet<string>): boolean {
  if (!refused.size) return false;
  return addressesOf(a).some((x) => addressesOf(b).some((y) => refused.has(pairSubject(x, y))));
}

/** People in groups that share a key, as pairs, the groups too large to mean one person left out. */
function pairsOf(groups: Map<string, Person[]>, why: Duplicate["why"], cap: number): Duplicate[] {
  const out: Duplicate[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2 || list.length > cap) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) out.push({ a: list[i], b: list[j], why, local: why === "address" ? key : "" });
    }
  }
  return out;
}

/**
 * The pairs that may be one person, the same-name ones first. A pair the user refused, and
 * one of two records already one, is not offered.
 */
export function findDuplicates(people: Person[], refused: ReadonlySet<string> = new Set()): Duplicate[] {
  const byName = new Map<string, Person[]>();
  const byLocal = new Map<string, Person[]>();
  for (const p of people) {
    const key = nameKey(p.name);
    if (key) byName.set(key, [...(byName.get(key) ?? []), p]);
    const locals = new Set(addressesOf(p).map(localPart).filter((l) => l.length >= MIN_LOCAL));
    for (const l of locals) byLocal.set(l, [...(byLocal.get(l) ?? []), p]);
  }
  const seen = new Set<string>();
  const out: Duplicate[] = [];
  for (const d of [...pairsOf(byName, "name", Infinity), ...pairsOf(byLocal, "address", MAX_SHARED)]) {
    const key = [identity(d.a), identity(d.b)].sort().join(" ");
    if (identity(d.a) === identity(d.b) || seen.has(key) || refusedPair(d.a, d.b, refused)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/** The first pair of these a person is in, with the other one named. */
export function duplicateIn(found: Duplicate[], person: Person): { other: Person; pair: Duplicate } | null {
  const me = identity(person);
  for (const d of found) {
    if (identity(d.a) === me) return { other: d.b, pair: d };
    if (identity(d.b) === me) return { other: d.a, pair: d };
  }
  return null;
}

/** The pair a person is in, if any, with the other one named. */
export function duplicateOf(people: Person[], person: Person, refused: ReadonlySet<string> = new Set()) {
  return duplicateIn(findDuplicates(people, refused), person);
}

// ---- The merge: what the dialog offers and what it asks the backend for ----

/** A rule the people disagree on, or agree on: the values they have, and the one to take. */
export interface Choice<T> {
  values: T[];
  value: T;
  conflict: boolean;
}

export interface MergePlan {
  /** The people joined, the one with the most letters first. */
  people: Person[];
  names: { name: string; uses: number }[];
  addresses: { email: string; uses: number }[];
  format: Choice<BodyFormat | "">;
  view: Choice<ViewRule>;
  /** Hidden by some, by all, and the result by default: hidden if anyone had it. */
  hidden: { some: boolean; all: boolean };
  /** How many different notes are joined. */
  notes: number;
}

/** What the dialog settled. */
export interface MergeChoice {
  name: string;
  primary: string;
  format: BodyFormat | "";
  view: ViewRule;
  hidden: boolean;
}

const distinct = <T>(items: T[]): T[] => [...new Set(items)];

/**
 * What a merge of these people offers, with the defaults of the decisions: the name of the
 * one with the most letters, the strictest format (plain text < HTML < Markdown), the view of
 * the one whose name stays, hidden if anyone was, the notes joined.
 */
export function planMerge(joined: Person[]): MergePlan {
  const people = [...joined].sort((a, b) => b.uses - a.uses);
  const names = distinct(people.map((p) => p.name || p.email)).map((name) => ({
    name,
    uses: people.filter((p) => (p.name || p.email) === name).reduce((n, p) => n + p.uses, 0),
  }));
  const addresses = people.flatMap((p) => p.emails.map((a) => ({ email: a.email, uses: a.uses })));
  const formats = distinct(people.map((p) => p.send_format).filter(Boolean)) as BodyFormat[];
  const views = distinct(people.map((p) => p.view).filter(Boolean)) as ViewRule[];
  const kept = people[0];
  return {
    people,
    names,
    addresses,
    format: { values: formats, value: formats.length ? strictestFormat(formats) : "", conflict: formats.length > 1 },
    view: { values: views, value: kept?.view || views[0] || "", conflict: views.length > 1 },
    hidden: { some: people.some((p) => p.hidden), all: people.every((p) => p.hidden) },
    notes: distinct(people.map((p) => p.note.trim()).filter(Boolean)).length,
  };
}

/** The choice the dialog starts on. */
export function defaultChoice(plan: MergePlan): MergeChoice {
  return {
    name: plan.names[0]?.name ?? "",
    primary: plan.people[0]?.email ?? plan.addresses[0]?.email ?? "",
    format: plan.format.value,
    view: plan.view.value,
    hidden: plan.hidden.some,
  };
}

/** The request for the backend: one address of each person, then what was settled. */
export function mergeRequest(plan: MergePlan, choice: MergeChoice) {
  return {
    emails: plan.people.map((p) => p.email),
    name: choice.name,
    primary: choice.primary,
    send_format: choice.format,
    view: choice.view,
    hidden: choice.hidden,
  };
}
