// The tag of a row of "Waiting for reply": "2 days left" in grey, "3 days overdue" in red,
// "replied: Ivan Petrov, 3 Oct" in green, "closed by hand 1 Oct" in grey; the kind of
// reminder as a quiet note in the first line. A letter of the inbox an answer takes to
// the folder says "to Waiting for reply" in blue, and "reply came" in green when it is
// back, until opened (#59). Covered by rows.test.ts.

import AlarmClock from "@lucide/svelte/icons/alarm-clock";
import Bot from "@lucide/svelte/icons/bot";
import CalendarDays from "@lucide/svelte/icons/calendar-days";
import Check from "@lucide/svelte/icons/check";
import MessageSquareReply from "@lucide/svelte/icons/message-square-reply";
import Repeat2 from "@lucide/svelte/icons/repeat-2";
import X from "@lucide/svelte/icons/x";
import { addrName, listDate, when, type FollowupInfo, type MessageRow, type RowTag } from "@depesha/plugin-api";
import { left } from "./due";
import type { Say } from "./labels";
import { LATE, LEFT, S } from "./strings";
import { stateOf, waitOf } from "./wait";

/**
 * The tag of `row` at `now`. Answered and closed waits are tagged only in the view itself
 * (`inView`): Sent does not fill up with old waits.
 */
export function rowTag(row: MessageRow, now: number, say: Say, inView: boolean): RowTag | null {
  if (!inView) {
    const going = goingTag(row, say);
    if (going) return going;
    if (row.answer_came) return { icon: Check, text: say.t(S.cameTag), good: true };
  }
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
  // An auto-reply did not count: said, or why the letter still waits is not seen.
  if (state === "waiting" && f.auto_reply)
    return { icon: Bot, text: say.t(S.autoTag, { when: listDate(f.auto_reply) }), title: when(f.auto_reply), note };
  // Waiting in the folder without a reminder: since when.
  if (!f.deadline) return { icon: MessageSquareReply, text: since(f, now, say), title: when(f.sent), note };
  const l = left(f.deadline, now);
  return {
    icon: MessageSquareReply,
    text: say.plural(l.n, (l.overdue ? LATE : LEFT)[l.unit]),
    title: when(f.deadline),
    alert: l.overdue,
    note,
  };
}

/** The answer takes the letter to "Waiting for reply": now, or when it leaves later. */
function goingTag(row: MessageRow, say: Say): RowTag | null {
  const o = row.outgoing;
  if (o?.park)
    return o.scheduled
      ? { icon: MessageSquareReply, text: say.t(S.goingLaterTag, { when: when(o.at) }), info: true }
      : { icon: MessageSquareReply, text: say.t(S.goingTag), info: true };
  if (row.followup?.status === "waiting" && row.followup.park === "pending") return { icon: MessageSquareReply, text: say.t(S.goingTag), info: true };
  return null;
}

/** "waiting since today", "since yesterday", "since 3 Oct". */
function since(f: FollowupInfo, now: number, say: Say): string {
  const day = (t: number) => new Date(t * 1000).toDateString();
  if (day(f.sent) === day(now)) return say.t(S.sinceToday);
  if (day(f.sent) === day(now - 86_400)) return say.t(S.sinceYesterday);
  return say.t(S.sinceTag, { when: listDate(f.sent) });
}
