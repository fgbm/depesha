// When a reminder comes: a number of minutes, hours, days or working days after
// sending. Pure, covered by due.test.ts.

export type Unit = "minutes" | "hours" | "days" | "workdays";

/** A saved choice of the reminder list. */
export interface Remind {
  id: string;
  label: string;
  amount: number;
  unit: Unit;
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
