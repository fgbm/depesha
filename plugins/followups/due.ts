// When a reminder comes: a number of minutes, hours, days or working days after
// sending; how far it is; saved choices and their edits. Pure, covered by due.test.ts.

export type Unit = "minutes" | "hours" | "days" | "workdays";

/** A saved choice of the reminder list. */
export interface Remind {
  id: string;
  label: string;
  amount: number;
  unit: Unit;
  /** The label is made from the amount and unit, not typed by the user: it follows them and the language. */
  auto?: boolean;
}

/** A time picked by hand: an amount after now (`keep`: saved as a choice of the list), or a date. */
export type Due = { amount: number; unit: Unit; keep: boolean } | { at: number };

/** "Remind in 2 working days without a reply" in the language of the interface. */
export type LabelOf = (amount: number, unit: Unit) => string;

/** Choices saved before `auto` existed are made up when their label is the made one. */
export const isAuto = (p: Remind, label: LabelOf) => p.auto ?? p.label === label(p.amount, p.unit);

/** The name shown in the list. */
export const labelOf = (p: Remind, label: LabelOf) => (isAuto(p, label) ? label(p.amount, p.unit) : p.label);

/**
 * A saved choice after an edit in the settings. A made-up label follows the new amount
 * and unit; one the user typed stays. An empty name gives the made-up one back; a
 * non-positive amount keeps the old one.
 */
export function edit(p: Remind, change: { label?: string; amount?: number; unit?: Unit }, label: LabelOf): Remind {
  const amount = change.amount !== undefined && Number.isInteger(change.amount) && change.amount > 0 ? change.amount : p.amount;
  const unit = change.unit ?? p.unit;
  let auto = isAuto(p, label);
  let name = p.label;
  if (change.label !== undefined) {
    const typed = change.label.trim();
    if (!typed || typed === label(amount, unit)) auto = true;
    else if (typed !== labelOf(p, label)) {
      auto = false;
      name = typed;
    }
  }
  return { ...p, amount, unit, auto, label: auto ? label(amount, unit) : name };
}

/** How far the reminder is: what is left until it, or how late it is. */
export interface Left {
  overdue: boolean;
  n: number;
  unit: "minutes" | "hours" | "days";
}

/** Whole days, else whole hours, else minutes (at least one); `due` and `now` in seconds. */
export function left(due: number, now: number): Left {
  const overdue = due <= now;
  const secs = Math.abs(due - now);
  if (secs >= 86_400) return { overdue, n: Math.floor(secs / 86_400), unit: "days" };
  if (secs >= 3600) return { overdue, n: Math.floor(secs / 3600), unit: "hours" };
  return { overdue, n: Math.max(1, Math.floor(secs / 60)), unit: "minutes" };
}

/** `amount` units after `from`; working days skip Saturday and Sunday and keep the time of day. */
export function after(from: Date, amount: number, unit: Unit): Date {
  const d = new Date(from);
  if (unit === "minutes") d.setMinutes(d.getMinutes() + amount);
  else if (unit === "hours") d.setHours(d.getHours() + amount);
  else if (unit === "days") d.setDate(d.getDate() + amount);
  else {
    let left = amount;
    while (left > 0) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() !== 0 && d.getDay() !== 6) left--;
    }
  }
  return d;
}

/** Seconds from `from` to the reminder, as the backend takes them. */
export function secondsAfter(from: Date, amount: number, unit: Unit): number {
  return Math.round((after(from, amount, unit).getTime() - from.getTime()) / 1000);
}
