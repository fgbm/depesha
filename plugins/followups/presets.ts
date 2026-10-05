// Saved choices of the reminder list: what they are, their names, their edits. Pure,
// covered by presets.test.ts.

import { goodTime, kindOf, type Kind, type Repeat, type Spec, type Unit } from "./due";

/** A saved choice of the reminder list. */
export interface Remind extends Spec {
  id: string;
  label: string;
  /** The label is made from the rest, not typed by the user: it follows them and the language. */
  auto?: boolean;
}

/** "Remind in 2 working days without a reply" in the language of the interface. */
export type LabelOf = (spec: Spec) => string;

/** Choices saved before `auto` existed are made up when their label is the made one. */
export const isAuto = (p: Remind, label: LabelOf) => p.auto ?? p.label === label(p);

/** The name shown in the list. */
export const labelOf = (p: Remind, label: LabelOf) => (isAuto(p, label) ? label(p) : p.label);

/** A new choice of the settings: in 2 days, its name made up. */
export function fresh(id: string, label: LabelOf): Remind {
  const spec: Spec = { kind: "after", amount: 2, unit: "days" };
  return { id, ...spec, label: label(spec), auto: true };
}

const positive = (n: number | undefined): n is number => n !== undefined && Number.isInteger(n) && n > 0;

/** A change of a saved choice in the settings. */
export type Change = { label?: string; kind?: Kind; amount?: number; unit?: Unit; weekday?: number; time?: string; repeat?: Repeat | null };

/**
 * A saved choice after an edit in the settings. A made-up label follows the new values;
 * one the user typed stays. An empty name gives the made-up one back; a non-positive
 * amount, a bad time or day keep the old ones. A choice before a deadline counts days.
 */
export function edit(p: Remind, change: Change, label: LabelOf): Remind {
  const next: Remind = { ...p };
  if (change.kind) next.kind = change.kind;
  if (positive(change.amount)) next.amount = change.amount;
  if (change.unit) next.unit = change.unit;
  if (change.weekday !== undefined && Number.isInteger(change.weekday) && change.weekday >= 0 && change.weekday <= 6) next.weekday = change.weekday;
  if (goodTime(change.time)) next.time = change.time;
  if (change.repeat === null) next.repeat = null;
  else if (change.repeat && positive(change.repeat.amount)) next.repeat = change.repeat;
  const k = kindOf(next);
  if (k === "weekday") next.weekday ??= 1;
  if (k !== "after") next.time ??= "09:00";
  if (k === "before" && next.unit !== "workdays") next.unit = "days";
  let auto = isAuto(p, label);
  let name = p.label;
  if (change.label !== undefined) {
    const typed = change.label.trim();
    if (!typed || typed === label(next)) auto = true;
    else if (typed !== labelOf(p, label)) {
      auto = false;
      name = typed;
    }
  }
  return { ...next, auto, label: auto ? label(next) : name };
}
