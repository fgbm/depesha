// The book of people as the rest of the app reads it (#66, #44, #104): one cache of the address
// book, read once and kept, so a card in a letter, the compose window and the book in the main
// window all see the same records. Saving writes the record and updates the cache, so a rule set
// in one place is in force in the others at once. Changes of the addresses — adding one,
// the primary, a merge, a split — are made by the backend and read back whole.
import { emit } from "@tauri-apps/api/event";
import { api } from "./api";
import { t } from "./i18n.svelte";
import { app } from "./store.svelte";
import { allMailQuery, blankPerson, findPerson, type Added, type Forgotten, type Merged, type Person, type Snapshot, type Split } from "./people";
import { findDuplicates, mergeRequest, pairSubject, SAME_PERSON, type MergeChoice, type MergePlan } from "./peopleMerge";
import type { HintState } from "./hints";

/** Whether a cached person is the one this is a copy of: by key, else by address. */
const same = (p: Person, q: Person) => (q.id ? p.id === q.id : p.id === 0 && p.email.toLowerCase() === q.email.toLowerCase());

export class PeopleBook {
  list = $state<Person[]>([]);
  /** The pairs of addresses the user said are two people: they are not offered as one. */
  refused = $state<Set<string>>(new Set());
  /** The pairs that may be one person, found when asked and kept until the book changes. */
  duplicates = $derived(findDuplicates(this.list, this.refused));
  /** The read in flight: several callers waiting for the first one share it. */
  private reading: Promise<void> | null = null;
  /** The book was read: it stays until something changes it. */
  private loaded = false;
  /** Own changes already applied to the cache: their broadcast needs no re-read. */
  private ownChanges = 0;

  /** A failed read was told: a series of failures is told once, not on every call. */
  private failed = false;

  /** Reads the book once; later callers get the cache. A failure is told once and leaves the previous
   *  list (empty at first); the next call reads again. */
  load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.reading) return this.reading;
    this.reading = this.read()
      .then(() => {
        this.loaded = true;
        this.failed = false;
      })
      .catch((e) => {
        if (!this.failed) app.fail(e, t("people.readFailed"));
        this.failed = true;
      })
      .finally(() => {
        this.reading = null;
      });
    return this.reading;
  }

  private async read() {
    // No refusals known: a pair may be offered again, and the user can refuse again.
    const [list, hints] = await Promise.all([api.people(""), api.hints().catch(() => [] as HintState[])]);
    this.list = list;
    this.refused = new Set((hints ?? []).filter((h) => h.id === SAME_PERSON && h.decision === "never").map((h) => h.subject));
  }

  /** The book changed in another window: read it again. Own changes are already in the cache. */
  changed() {
    if (this.ownChanges > 0) {
      this.ownChanges--;
      return;
    }
    void this.refresh();
  }

  /** Tells the other windows the book changed; the local cache is already up to date. */
  private announce() {
    this.ownChanges++;
    // The other windows will not hear of it: the own change is no longer pending.
    emit("people-changed", {}).catch(() => {
      this.ownChanges--;
    });
  }

  /** The record of an address — any of a person's — or none: an address without a rule is not a record. */
  find(email: string): Person | undefined {
    return findPerson(this.list, email);
  }

  /** Saves a person's fields and keeps the cache in step with them; the record as kept is returned. */
  async save(person: Person): Promise<Person> {
    const known = this.list.some((p) => same(p, person));
    this.list = known ? this.list.map((p) => (same(p, person) ? person : p)) : [...this.list, person];
    const saved = await api.personSave(person);
    this.list = this.list.map((p) => (same(p, person) ? saved : p));
    this.loaded = true;
    this.announce();
    return saved;
  }

  /**
   * Forgets a person added by hand: whole, or — when an address of theirs is in the
   * correspondence — only the mark, their rules kept. The answer carries the way back.
   */
  async forget(email: string): Promise<Forgotten> {
    const done = await api.personForget(email);
    if (done.removed || done.unmarked) await this.settle();
    return done;
  }

  /** The search for every letter of the person, from any of their addresses (a person not in the book: the address). */
  allMail(email: string): string {
    return allMailQuery(this.find(email) ?? blankPerson(email));
  }

  /** Adds an address to a person. An address that is another person's is not moved: that person is returned for a merge. */
  async addAddress(to: Person, email: string): Promise<Added> {
    const added = await api.personAddAddress(to.email, email);
    if (added.person) await this.settle();
    return added;
  }

  async setPrimary(email: string): Promise<Person | null> {
    const person = await api.personSetPrimary(email);
    if (person) await this.settle();
    return person;
  }

  /** Joins the people of the plan as the dialog settled. The result carries the way back. */
  async merge(plan: MergePlan, choice: MergeChoice): Promise<Merged | null> {
    const merged = await api.personMerge(mergeRequest(plan, choice));
    if (merged) await this.settle();
    return merged;
  }

  /** Lets an address leave its person and be a person of its own. */
  async split(email: string): Promise<Split | null> {
    const split = await api.personSplit(email);
    if (split) await this.settle();
    return split;
  }

  /** Puts back what a merge or a split changed. */
  async restore(undo: Snapshot) {
    await api.personRestore(undo);
    await this.settle();
  }

  /** «No, these are two people»: the pair is not offered again. */
  async refuse(a: Person, b: Person) {
    const subject = pairSubject(a.email, b.email);
    await api.hintSave({ id: SAME_PERSON, subject, decision: "never", shows: 0, refusals: 1, decided: Math.floor(Date.now() / 1000), shown: 0 });
    this.refused = new Set([...this.refused, subject]);
  }

  /** Reads the book again, after it changed elsewhere. */
  async refresh() {
    await this.read();
    this.loaded = true;
  }

  /** The backend changed the addresses: the book is read back whole, and the other windows told. */
  private async settle() {
    await this.refresh();
    this.announce();
  }
}

export const peopleBook = new PeopleBook();
