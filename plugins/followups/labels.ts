// Names of reminder choices made from what they say, in the language of the interface.

import type { PluralForms, Text } from "@depesha/plugin-api";
import { kindOf, type Spec } from "./due";
import type { LabelOf } from "./presets";
import { BEFORE, BEFORE_DAY, EVERY_LABEL, EVERY_ONE, LABEL, NEXT_DAY, THEN, THEN_ONE } from "./strings";

/** What of the plugin context the words need. */
export interface Say {
  t(text: Text, params?: Record<string, string | number>): string;
  plural(n: number, forms: { en: PluralForms; ru: PluralForms }): string;
}

/** "Remind in 2 working days without a reply", "Every 3 days until a reply", "Remind a day before the deadline". */
export function labelMaker(say: Say): LabelOf {
  return (s: Spec) => {
    const k = kindOf(s);
    const r = s.repeat;
    // Again as often as the first time: one phrase for both.
    if (k === "after" && r && r.amount === s.amount && r.unit === s.unit)
      return r.amount === 1 ? say.t(EVERY_ONE[r.unit]) : say.plural(r.amount, EVERY_LABEL[r.unit]);
    const days = s.unit === "workdays" ? "workdays" : "days";
    const base =
      k === "weekday"
        ? say.t(NEXT_DAY[s.weekday ?? 1] ?? NEXT_DAY[1], { time: s.time ?? "09:00" })
        : k === "before"
          ? s.amount === 1 && days === "days"
            ? say.t(BEFORE_DAY)
            : say.plural(s.amount, BEFORE[days])
          : say.plural(s.amount, LABEL[s.unit]);
    if (!r) return base;
    const then = r.amount === 1 ? say.t(THEN_ONE[r.unit], { label: base }) : say.plural(r.amount, THEN[r.unit]);
    return then.replace("{label}", base);
  };
}
