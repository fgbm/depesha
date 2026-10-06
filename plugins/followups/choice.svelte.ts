// The reminder chosen in one compose window: shared by the list beside Send and the line
// above the buttons (when it reminds, the deadline, whose answer counts).

import type { ComposeContext } from "@depesha/plugin-api";
import { deadlineFor, kindOf, type Choice, type Repeat, type Spec } from "./due";
import { labelOf, type LabelOf, type Remind } from "./presets";
import { S } from "./strings";

// A class: `$state` may only sit in a class field, not in a function's local variable.
export class ComposeChoice {
  /** "0" none, "d<N>" N days, "p:<id>" a saved one, "c" the one set with "Custom…". */
  value = $state("0");
  /** "Custom…" not saved: a choice of its own, or a date. */
  custom = $state<{ spec: Spec } | { at: number; repeat: Repeat | null } | null>(null);
  /** The day (local midnight) a reply is needed by, for a choice before a deadline. */
  deadline = $state<number | null>(null);
  /** Whose answer ends the wait: an address of To or Cc, or "" for anyone's. */
  expect = $state("");
}

const all = new WeakMap<ComposeContext, ComposeChoice>();

export function choiceOf(compose: ComposeContext): ComposeChoice {
  let c = all.get(compose);
  if (!c) {
    c = new ComposeChoice();
    all.set(compose, c);
  }
  return c;
}

/** What `c` comes to: the choice to plan from and its name; null without a reminder. */
export function resolve(
  c: ComposeChoice,
  saved: Remind[],
  label: LabelOf,
  say: { t: (text: { en: string; ru: string }, params?: Record<string, string | number>) => string },
  dateName: (at: number) => string,
): { choice: Choice; name: string; spec: Spec | null } | null {
  if (c.value.startsWith("d")) {
    const days = Number(c.value.slice(1));
    const spec: Spec = { amount: days, unit: "days" };
    return { choice: { spec, deadline: null }, name: say.t(days === 1 ? S.remind1 : days === 7 ? S.remind7 : S.remind3), spec };
  }
  const p = saved.find((x) => `p:${x.id}` === c.value);
  if (p) return { choice: { spec: p, deadline: c.deadline }, name: labelOf(p, label), spec: p };
  if (c.value === "c" && c.custom) {
    if ("at" in c.custom) return { choice: c.custom, name: say.t(S.untilDate, { when: dateName(c.custom.at) }), spec: null };
    return { choice: { spec: c.custom.spec, deadline: null }, name: label(c.custom.spec), spec: c.custom.spec };
  }
  return null;
}

/** A choice before a deadline gets one to start from, and a new one when sending moves past it. */
export function withDeadline(c: ComposeChoice, spec: Spec | null, from: Date) {
  if (!spec || kindOf(spec) !== "before") return;
  const day = deadlineFor(c.deadline, from, spec);
  if (day !== c.deadline) c.deadline = day;
}
