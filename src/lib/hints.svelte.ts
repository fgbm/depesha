// The hints of #69 at work: the decisions and the detectors' counters read from the cache,
// the limits applied, and the one hint shown now. The pure rules live in hints.ts and are
// tested there; this file only holds the state, talks to the backend and hands the answer's
// rule to the address book. Time is the clock's, read once per call.
import { api } from "./api";
import { t } from "./i18n.svelte";
import { app } from "./store.svelte";
import {
  answer,
  countOf,
  detected,
  HINT_POLICY,
  markShown,
  mayShow,
  specById,
  type Hint,
  type HintAnswer,
  type HintCounters,
  type HintState,
  type HintSpec,
} from "./hints";
import { blankPerson } from "./people";
import { peopleBook } from "./peopleBook.svelte";
import type { ComposeDraft, ViewRule } from "./types";

/** When the app was first run on this computer, for the week of quiet of frame 16. */
const SINCE = "depesha.hints.since";

function now(): number {
  return Math.floor(Date.now() / 1000);
}

class Hints {
  /** The decisions kept: accepted, refused, «not now», shown. */
  states = $state<HintState[]>([]);
  /** What the detectors have counted, by hint and subject. */
  counters = $state<HintCounters>({});
  /** The one hint shown now, in the quiet line or as a toast; null shows none. */
  active = $state<Hint | null>(null);
  /** The form the user last switched a letter to, to set as the sender's rule. */
  private lastView: Record<string, ViewRule> = {};
  private reading: Promise<void> | null = null;

  /** Reads the decisions and the counters once; a failure leaves hints off. */
  load(): Promise<void> {
    if (this.reading) return this.reading;
    this.reading = Promise.all([api.hints(), api.hintCounts()])
      .then(([states, counts]) => {
        this.states = states;
        this.counters = bySubject(counts);
      })
      .catch(() => {}) // A failure leaves hints off (see above).
      .finally(() => {
        this.reading = null;
      });
    return this.reading;
  }

  /** When the app was first run here; 0 when localStorage is not there. */
  private get since(): number {
    try {
      const set = localStorage.getItem(SINCE);
      if (set) return Number(set);
      const at = now();
      localStorage.setItem(SINCE, String(at));
      return at;
    } catch { // No localStorage: counted as the first run, which keeps hints quiet.
      return 0;
    }
  }

  /** Whether this hint about its subject may be shown now, with the limits of frame 16. */
  mayShow(hint: Hint, typing = false): boolean {
    return mayShow(hint, this.states, {
      now: now(),
      typing,
      installedAt: this.since,
      policy: { ...HINT_POLICY, enabled: app.settings.hints },
    });
  }

  /** Shows the hint now: it becomes the one on the line and its showing is counted. */
  async show(hint: Hint): Promise<void> {
    this.active = hint;
    this.states = markShown(this.states, hint, now());
    await this.persist(hint.id, hint.subject);
  }

  /** The hint of the reader's detector for this sender, or null: the form was switched
   *  often enough. The reply hint is offered when a reply is written, not on reading. */
  readerHint(email: string, who: string): Hint | null {
    const spec = specById("incoming-view");
    if (!spec) return null;
    const hint = detected(spec, email, who, countOf(this.counters, spec.id, email));
    return hint && this.mayShow(hint) ? hint : null;
  }

  /** A reply to a letter with a Markdown part, from a person without a rule: offer to
   *  answer in Markdown. Shown in the compose window, where the answer is written. */
  async offerReply(email: string, who: string, noRule: boolean): Promise<boolean> {
    if (!email || !noRule) return false;
    const spec = specById("reply-format");
    if (!spec) return false;
    const hint = detected(spec, email, who, 1);
    if (!hint || !this.mayShow(hint)) return false;
    await this.show(hint);
    return true;
  }

  /** The send-format hint about this address, if it may be shown now: the letter is written
   *  in Markdown to them often enough, and no rule was set. It waits for such a letter and
   *  is put on the window's quiet line; nothing is shown by asking (#69). */
  sendFormatHint(email: string, who: string): Hint | null {
    const spec = specById("send-format");
    if (!spec) return null;
    const hint = detected(spec, email, who, countOf(this.counters, spec.id, email));
    return hint && this.mayShow(hint) ? hint : null;
  }

  /** The user answered the shown hint; the accepted rule is set, the counter forgotten. */
  async decide(what: HintAnswer): Promise<void> {
    const hint = this.active;
    if (!hint) return;
    this.active = null;
    this.states = answer(this.states, hint, what, now());
    // One failure is told once: the counter stays until the answer is kept.
    if (await this.persist(hint.id, what === "never-anyone" ? "" : hint.subject)) await this.clearCount(hint.id, hint.subject);
  }

  /** Accepts the shown hint: sets the rule with the mark «by a hint» and remembers the answer. */
  async accept(view?: ViewRule): Promise<void> {
    const hint = this.active;
    if (!hint) return;
    const spec = specById(hint.id);
    await this.decide("accepted");
    if (!spec) return;
    await this.setRule(hint, spec, view);
  }

  notNow() {
    return this.decide("not-now");
  }

  neverThis() {
    return this.decide("never-this");
  }

  neverAnyone() {
    return this.decide("never-anyone");
  }

  /** Writes the rule of an accepted hint on the person, marked «by a hint» (#69). */
  private async setRule(hint: Hint, spec: HintSpec, view?: ViewRule) {
    const person = peopleBook.find(hint.subject) ?? blankPerson(hint.subject);
    const sets = { ...spec.sets };
    if (sets.view !== undefined && view) sets.view = view;
    try {
      await peopleBook.save({ ...person, ...sets, via: `hint:${hint.id}` });
    } catch (e) {
      app.fail(e);
    }
  }

  // ---- The detectors (#69): what they watch, and the hint they ask for when it is enough.

  /** A Markdown letter sent to these people: the ones without a rule are counted. The
   *  suggestion itself waits for the next letter to them, where it is shown as a quiet line. */
  async recordSend(draft: ComposeDraft): Promise<void> {
    if ((draft.format ?? "plain") !== "markdown") return;
    for (const a of draft.to) {
      const person = peopleBook.find(a.email);
      if (person?.send_format) continue;
      await this.bump("send-format", a.email);
    }
  }

  /** The user switched the form of a letter from this sender: counted for the hint, which
   *  is shown under the switch once its count is reached. */
  async recordViewSwitch(email: string, view: ViewRule, who: string): Promise<void> {
    if (!email) return;
    this.lastView[email.trim().toLowerCase()] = view;
    const n = await this.bump("incoming-view", email);
    const spec = specById("incoming-view");
    if (!spec) return;
    const hint = detected(spec, email, who || email, n);
    if (hint && this.mayShow(hint)) await this.show(hint);
  }

  /** The form the user last switched to for a sender. */
  lastViewOf(email: string): ViewRule | undefined {
    return this.lastView[email.trim().toLowerCase()];
  }

  private async bump(id: string, subject: string): Promise<number> {
    try {
      const n = await api.countHint(id, subject.trim().toLowerCase(), now());
      const sub = subject.trim().toLowerCase();
      this.counters = { ...this.counters, [id]: { ...(this.counters[id] ?? {}), [sub]: n } };
      return n;
    } catch { // A counter that cannot be kept only delays a suggestion.
      return 0;
    }
  }

  private async clearCount(id: string, subject: string): Promise<void> {
    const sub = subject.trim().toLowerCase();
    const row = { ...(this.counters[id] ?? {}) };
    delete row[sub];
    this.counters = { ...this.counters, [id]: row };
    await api.clearHintCount(id, subject.trim().toLowerCase()).catch((e) => app.fail(e, t("hints.saveFailed")));
  }

  private async persist(id: string, subject: string): Promise<boolean> {
    const state = this.states.find((s) => s.id === id && s.subject === subject.trim().toLowerCase());
    if (!state) return true;
    return api.hintSave(state).then(
      () => true,
      (e) => (app.fail(e, t("hints.saveFailed")), false),
    );
  }

  /** Reads the decisions again, after «Ask them again» on the page «Hints». */
  async refresh(): Promise<void> {
    try {
      this.states = await api.hints();
      this.counters = bySubject(await api.hintCounts());
      this.active = null;
    } catch {
      /* nothing to show */
    }
  }
}

/** The rows of the cache by hint and subject, as the engine reads them. */
function bySubject(rows: { id: string; subject: string; n: number }[]): HintCounters {
  const out: HintCounters = {};
  for (const r of rows) out[r.id] = { ...(out[r.id] ?? {}), [r.subject]: r.n };
  return out;
}

export const hints = new Hints();
