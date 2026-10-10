// What the user does to the structure of the address book (#104): joining people, letting an
// address go, saying two are not one. The dialogs (the merge, the choice of the second person)
// are held here and drawn by App.svelte; the doing is the book's. A merge or a split can be
// taken back for ten seconds with the toast's button or "z" (the decision 3.6 А); later the
// way back is a split by hand.
import { tick } from "svelte";
import { app } from "./store.svelte";
import { bus } from "./bus";
import { t, tn } from "./i18n.svelte";
import type { Person, Split } from "./people";
import { peopleBook } from "./peopleBook.svelte";
import { defaultChoice, planMerge, type MergeChoice, type MergePlan } from "./peopleMerge";

interface MergeDialog {
  plan: MergePlan;
  choice: MergeChoice;
  /** Told the person that came of it: the book follows it. */
  after?: (merged: Person) => void;
}

class PeopleOps {
  /** The merge dialog; null when none is open. */
  dialog = $state<MergeDialog | null>(null);
  /** The person a second one is being chosen for; null when no choice is open. */
  picking = $state<Person | null>(null);

  /** Opens the merge dialog for these people. It is always shown: nothing joins without it (3.7 А). */
  merge(people: Person[], after?: (merged: Person) => void) {
    const distinct = people.filter((p, i) => people.findIndex((q) => q.email.toLowerCase() === p.email.toLowerCase()) === i);
    if (distinct.length < 2) return;
    const plan = planMerge(distinct);
    this.picking = null;
    this.dialog = { plan, choice: defaultChoice(plan), after };
  }

  cancel() {
    this.dialog = null;
  }

  /** Joins the people as the dialog settled, and offers to take it back. */
  async confirm() {
    const open = this.dialog;
    if (!open) return;
    this.dialog = null;
    try {
      const merged = await this.join(open);
      if (!merged) return;
      // The merge is done and can be taken back: what the caller does after it must not hide that.
      try {
        open.after?.(merged);
      } catch (e) {
        app.fail(e);
      }
    } finally {
      await tick();
      bus.emit("people.merge-ended");
    }
  }

  private async join(open: MergeDialog): Promise<Person | null> {
    try {
      const merged = await peopleBook.merge(open.plan, open.choice);
      if (!merged) return null;
      const { person } = merged;
      app.offerUndo(
        tn("people.merged", person.emails.length, { name: person.name || person.email }),
        async () => {
          await peopleBook.restore(merged.undo);
        },
      );
      return person;
    } catch (e) {
      app.fail(e);
      return null;
    }
  }

  /** Chooses the second person for a merge (M on a card without a suggestion). */
  pick(person: Person) {
    this.picking = person;
  }

  stopPicking() {
    this.picking = null;
  }

  /** Lets an address go as a person of its own, and offers to take it back. */
  async split(person: Person, address: string, after?: (split: Split) => void) {
    if (person.emails.length < 2) return;
    try {
      const split = await peopleBook.split(address);
      if (!split) return;
      app.offerUndo(
        t("people.split", { email: split.person.email, name: split.person.name || split.person.email }),
        async () => {
          await peopleBook.restore(split.undo);
        },
      );
      after?.(split);
    } catch (e) {
      app.fail(e);
    }
  }

  /** «No, these are two people»: the pair is not offered again. */
  async refuse(a: Person, b: Person) {
    try {
      await peopleBook.refuse(a, b);
      app.toast(t("people.refused"));
    } catch (e) {
      app.fail(e);
    }
  }
}

export const peopleOps = new PeopleOps();
