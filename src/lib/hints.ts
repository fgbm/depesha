// One mechanism for every suggestion the app makes (#69): «write to Ivan in Markdown
// always?», «Ivan sends Markdown — answer in Markdown?», «you switched the form three
// times — remember it?». Each suggestion is an entry of the registry with an id, the
// subject it is about, the words of the question and the name of its accepting button; the
// engine decides whether one may be shown now, so no suggestion decides that for itself.
// The decisions are kept per hint and per subject: «never this person», «never to anyone»,
// «not now» and «already answered» are rows of one table, and the limits of frame 16 are
// read from them. Time is handed in, never read here: the tests steer it.
import type { BodyFormat, LetterViewPref } from "./types";

/** What was decided about a hint, or that it was shown and left unanswered. */
export type HintDecision = "accepted" | "dismissed" | "never" | "shown";

/** The decision about one hint, about one subject ("" is «any subject» or a looking-up). */
export interface HintState {
  id: string;
  /** The address the decision is about; "" is a decision about the hint itself. */
  subject: string;
  decision: HintDecision;
  /** Times it was shown and left unanswered. */
  shows: number;
  /** Times «not now» was answered. */
  refusals: number;
  /** When the last decision was made. */
  decided: number;
  /** When it was last shown; 0 when never. */
  shown: number;
}

/** A suggestion the app may make, and the action that accepts it. */
export interface Hint {
  /** The entry of the registry: one per kind of suggestion. */
  id: string;
  /** The address it is about. */
  subject: string;
  /** The words of the question; `who` is how the person is named. */
  text: (who: string) => string;
  /** The accepting button names what it does, not «yes» (#69). */
  accept: string;
}

/** The entry of the registry: what may be asked, before it is asked about someone. */
export interface HintSpec {
  id: string;
  /** The question about a person, named by `who`. */
  text: (who: string) => string;
  /** The accepting button's words. */
  accept: string;
  /** The rule the accepted answer sets: the format written in, or the form shown. */
  sets: { send_format?: BodyFormat; view?: LetterViewPref };
}

/** The first suggestions of 0.7, in the order they are looked at (#69). */
export const HINTS: HintSpec[] = [
  {
    id: "send-format",
    text: (who) => `You wrote ${who} in Markdown twice — write that way always?`,
    accept: "Write in Markdown",
    sets: { send_format: "markdown" },
  },
  {
    id: "reply-format",
    text: (who) => `${who} sends Markdown — answer in Markdown?`,
    accept: "Answer in Markdown",
    sets: { send_format: "markdown" },
  },
  {
    id: "incoming-view",
    text: (who) => `You switched the form of ${who}'s letters three times — remember it?`,
    accept: "Show them that way",
    sets: { view: "markdown" },
  },
];

/** One entry of the registry about one person. */
export function hintAbout(spec: HintSpec, email: string, who: string): Hint {
  return { id: spec.id, subject: email.trim().toLowerCase(), text: spec.text, accept: spec.accept };
}

/** The limits of frame 16: one hint at a time, three a day, and the pauses after «no». */
export interface HintPolicy {
  /** The one switch that turns every suggestion off. */
  enabled: boolean;
  /** At most this many hints a day. */
  perDay: number;
  /** «Not now» keeps the hint away for this many days. */
  pauseDays: number;
  /** This many refusals and it goes quiet for good. */
  decayRefusals: number;
  /** Shown this many times without an answer and it goes quiet for good. */
  decayShows: number;
  /** Nothing is suggested for this many days after the install. */
  quietDays: number;
}

export const HINT_POLICY: HintPolicy = {
  enabled: true,
  perDay: 3,
  pauseDays: 14,
  decayRefusals: 2,
  decayShows: 3,
  quietDays: 7,
};

const DAY = 86_400;

/** The decision kept about one hint and one subject. */
export function stateOf(states: HintState[], id: string, subject: string): HintState | undefined {
  const sub = subject.trim().toLowerCase();
  return states.find((s) => s.id === id && s.subject === sub);
}

/** How many hints were shown and left unanswered today, whatever their subject. */
export function shownToday(states: HintState[], now: number): number {
  const day = Math.floor(now / DAY);
  return states.filter((s) => s.shown > 0 && Math.floor(s.shown / DAY) === day).length;
}

/** What the engine needs besides the decisions: the moment, and what the app is doing. */
export interface HintContext {
  /** Unix time, handed in so the tests can steer it. */
  now: number;
  /** The user is typing: a hint never interrupts (#69). */
  typing: boolean;
  /** When the app was installed / first run, for the week of quiet. */
  installedAt: number;
  policy?: HintPolicy;
}

/**
 * Whether this hint about its subject may be shown now: the switches of frame 16 read from
 * the decisions — the general off, the week of quiet, one at a time (the caller shows the
 * one), the day's limit, and the pauses after «not now», two refusals and three showings.
 */
export function mayShow(hint: Hint, states: HintState[], ctx: HintContext): boolean {
  const policy = ctx.policy ?? HINT_POLICY;
  if (!policy.enabled || ctx.typing) return false;
  if (ctx.now - ctx.installedAt < policy.quietDays * DAY) return false;
  if (shownToday(states, ctx.now) >= policy.perDay) return false;
  // «Never to anyone» is a decision about the hint itself, under an empty subject.
  if (stateOf(states, hint.id, "")?.decision === "never") return false;
  const s = stateOf(states, hint.id, hint.subject);
  if (!s) return true;
  switch (s.decision) {
    case "accepted":
    case "never":
      return false;
    case "dismissed":
      if (s.refusals >= policy.decayRefusals) return false;
      return ctx.now >= s.decided + policy.pauseDays * DAY;
    case "shown":
      return s.shows < policy.decayShows;
  }
}

/** The first hint that may be shown now, or null: only one is shown at a time (#69). */
export function nextHint(hints: Hint[], states: HintState[], ctx: HintContext): Hint | null {
  return hints.find((h) => mayShow(h, states, ctx)) ?? null;
}

/** One row of the decisions list, replaced or added. */
function put(states: HintState[], next: HintState): HintState[] {
  const rest = states.filter((s) => !(s.id === next.id && s.subject === next.subject));
  return [...rest, next];
}

/** The row a decision is written into, or a fresh one for the hint and subject. */
function row(states: HintState[], id: string, subject: string): HintState {
  return stateOf(states, id, subject) ?? { id, subject, decision: "shown", shows: 0, refusals: 0, decided: 0, shown: 0 };
}

/** The hint was shown and left unanswered: the count that makes it go quiet after three. */
export function markShown(states: HintState[], hint: Hint, now: number): HintState[] {
  const s = row(states, hint.id, hint.subject);
  // A showing does not undo an answer: only the count and the moment move.
  const decision: HintDecision = s.decision === "shown" ? "shown" : s.decision;
  return put(states, { ...s, decision, shows: s.shows + 1, shown: now });
}

/** What the user answered. The accepting button sets a rule; the others only remember. */
export type HintAnswer = "accepted" | "not-now" | "never-this" | "never-anyone";

/** The decisions after an answer; accepted keeps its rule, the refusals their count. */
export function answer(states: HintState[], hint: Hint, what: HintAnswer, now: number): HintState[] {
  if (what === "never-anyone") {
    return put(states, { ...row(states, hint.id, ""), decision: "never", decided: now });
  }
  const s = row(states, hint.id, hint.subject);
  switch (what) {
    case "accepted":
      return put(states, { ...s, decision: "accepted", decided: now });
    case "never-this":
      return put(states, { ...s, decision: "never", decided: now });
    case "not-now":
      return put(states, { ...s, decision: "dismissed", refusals: s.refusals + 1, decided: now });
  }
}

/** Whether the hint was refused for good, per person or for everyone (#69, the list). */
export function settled(states: HintState[], hint: Hint, policy: HintPolicy = HINT_POLICY): "accepted" | "never" | "quiet" | "open" {
  if (stateOf(states, hint.id, "")?.decision === "never") return "never";
  const s = stateOf(states, hint.id, hint.subject);
  if (!s) return "open";
  if (s.decision === "accepted") return "accepted";
  if (s.decision === "never") return "never";
  if (s.decision === "dismissed" && s.refusals >= policy.decayRefusals) return "quiet";
  if (s.decision === "shown" && s.shows >= policy.decayShows) return "quiet";
  return "open";
}
