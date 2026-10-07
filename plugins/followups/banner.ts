// The line over a letter with a wait for an answer: what it waits for, or how it ended,
// what to do about it, and the history of its reminders. Covered by banner.test.ts.

import MessageSquareReply from "@lucide/svelte/icons/message-square-reply";
import Check from "@lucide/svelte/icons/check";
import { addrName, when, type Banner, type FollowupInfo, type MessageRow } from "@depesha/plugin-api";
import type { Say } from "./labels";
import { REMINDED, S } from "./strings";
import { parked, stateOf, waitOf, whoOf, type State } from "./wait";

/** What the buttons of the line do. */
export interface Actions {
  again(): void;
  later(): void;
  repick(): void;
  stop(): void;
  waitAgain(): void;
  /** Takes a letter waiting in the folder back to the inbox, and stops waiting. */
  unpark(): void;
  /** Opens the answer; missing where letters cannot be opened (a window of one letter). */
  openAnswer?: (id: number) => void;
}

export function bannerOf(row: MessageRow, now: number, say: Say, act: Actions): Banner | null {
  const f = waitOf(row);
  if (!f) return null;
  const state = stateOf(f, now);
  const details: { label: string; value: string }[] = [];
  const n = f.reminded.length;
  details.push({
    label: n ? say.plural(n, REMINDED) : say.t(S.neverReminded),
    value: n ? f.reminded.map((t) => when(t)).join(", ") : say.t(S.notYet),
  });
  if ((state === "waiting" || state === "overdue") && f.due > now)
    details.push({ label: say.t(S.next), value: f.repeat_secs > 0 ? say.t(S.nextRepeat, { when: when(f.due) }) : when(f.due) });
  if (f.kind) details.push({ label: say.t(S.choice), value: f.kind });
  const history = { details, detailsTitle: say.t(S.history) };

  if (state === "answered") {
    const at = when(f.ended ?? now);
    return {
      icon: Check,
      tone: "good",
      text: f.answered_by ? say.t(S.answered, { when: at, who: addrName(f.answered_by) }) : say.t(S.answeredAnon, { when: at }),
      actions: [
        ...(f.answer !== null && act.openAnswer ? [{ title: say.t(S.openAnswer), run: () => act.openAnswer!(f.answer!) }] : []),
        { title: say.t(S.waitAgain), run: act.waitAgain },
      ],
      ...history,
      details: [...details, { label: say.t(S.sentAt), value: when(row.date) }],
    };
  }
  if (state === "closed")
    return {
      icon: MessageSquareReply,
      tone: "info",
      text: say.t(S.closed, { when: when(f.ended ?? now) }),
      actions: [{ title: say.t(S.waitAgain), run: act.waitAgain }],
      ...history,
    };

  return waitingBanner(row, f, state, now, say, act, history);
}

type History = Pick<Banner, "details" | "detailsTitle">;

/** Still waiting, overdue or not; in the folder (frame 10) or for a sent letter. */
function waitingBanner(row: MessageRow, f: FollowupInfo, state: State, now: number, say: Say, act: Actions, history: History): Banner {
  const text: string[] = [];
  const inFolder = parked(f);
  if (state === "overdue") {
    text.push(f.own_deadline ? say.t(S.overdueDeadline, { when: when(f.deadline) }) : say.t(S.overdueReminder, { when: when(f.reminded.at(-1) ?? f.deadline) }));
  } else {
    text.push(f.own_deadline ? say.t(S.waitingBy, { when: when(f.deadline) }) : say.t(S.waiting));
    if (inFolder) text.push(say.t(S.comesBack));
    if (f.due > now) text.push(say.t(S.willRemind, { when: when(f.due) }));
  }
  if (f.expect) text.push(say.t(S.onlyFrom, { who: whoOf(row, f.expect) }));
  const stop = { title: say.t(S.stop), run: act.stop };
  const again = { title: say.t(S.again), primary: true, run: act.again };
  // Past due: what to do about the silence, the reply first. In the folder: back to the
  // inbox, a reminder, stop.
  const actions = inFolder
    ? [{ title: say.t(S.unpark), run: act.unpark }, { title: say.t(S.remindMe), run: act.repick }, stop]
    : state === "overdue"
      ? [{ title: say.t(S.repick), run: act.repick }, { title: say.t(S.later), run: act.later }, stop]
      : [{ title: say.t(S.repick), run: act.repick }, stop];
  return {
    icon: MessageSquareReply,
    tone: state === "overdue" ? "warn" : "info",
    text: text.join(" "),
    actions: state === "overdue" ? [again, ...actions] : actions,
    ...history,
  };
}
