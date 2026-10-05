// The tag of a row of "Waiting for reply": "2 days left" in grey, "3 days overdue" in red,
// "replied: Ivan Petrov, 3 Oct" in green, "closed by hand 1 Oct" in grey; the kind of
// reminder as a quiet note in the first line. Covered by rows.test.ts.

import AlarmClock from "@lucide/svelte/icons/alarm-clock";
import CalendarDays from "@lucide/svelte/icons/calendar-days";
import Check from "@lucide/svelte/icons/check";
import MessageSquareReply from "@lucide/svelte/icons/message-square-reply";
import Repeat2 from "@lucide/svelte/icons/repeat-2";
import X from "@lucide/svelte/icons/x";
import { addrName, listDate, when, type MessageRow, type RowTag } from "@depesha/plugin-api";
import { left } from "./due";
import type { Say } from "./labels";
import { LATE, LEFT, S } from "./strings";
import { stateOf, waitOf } from "./wait";

/**
 * The tag of `row` at `now`. Answered and closed waits are tagged only in the view itself
 * (`inView`): Sent does not fill up with old waits.
 */
export function rowTag(row: MessageRow, now: number, say: Say, inView: boolean): RowTag | null {
  const f = waitOf(row);
  if (!f) return null;
  const state = stateOf(f, now);
  if ((state === "answered" || state === "closed") && !inView) return null;
  // A deadline of its own is what matters; otherwise the choice it was set with.
  const note = f.own_deadline
    ? { text: say.t(S.deadlineNote, { when: listDate(f.deadline) }), icon: CalendarDays }
    : f.kind
      ? { text: f.kind, icon: f.repeat_secs > 0 ? Repeat2 : AlarmClock }
      : undefined;
  if (state === "answered") {
    const at = listDate(f.ended ?? now);
    const who = f.answered_by ? addrName(f.answered_by) : "";
    return {
      icon: Check,
      text: who ? say.t(S.answeredTag, { who, when: at }) : say.t(S.answeredTagAnon, { when: at }),
      title: when(f.ended ?? now),
      good: true,
      note,
    };
  }
  if (state === "closed")
    return { icon: X, text: say.t(S.closedTag, { when: listDate(f.ended ?? now) }), title: when(f.ended ?? now), note };
  const l = left(f.deadline, now);
  return {
    icon: MessageSquareReply,
    text: say.plural(l.n, (l.overdue ? LATE : LEFT)[l.unit]),
    title: when(f.deadline),
    alert: l.overdue,
    note,
  };
}
