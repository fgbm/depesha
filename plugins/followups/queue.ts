// The checkbox "Take the letter out of the inbox" of the compose window (#59, #106, frame
// 6В, 12Б): on an answer to a letter of the inbox in a mailbox that does it, ticked as the
// mailbox says; it moves the letter to the archive and waits for nothing. Greyed with the
// reason for a letter of another folder, a mailbox with no archive, or a reminder chosen
// (then the letter goes to "Waiting for reply"). Pure, covered by queue.test.ts.

import type { ActsOn, ComposeContext, FolderInfo, Waiting } from "@depesha/plugin-api";
import type { Say } from "./labels";
import { S } from "./strings";

export interface QueueBox {
  checked: boolean;
  disabled: boolean;
  text: string;
  title?: string;
}

/** Whether a reminder or a deadline is chosen: the answer waits, and the letter goes to the folder. */
export function waitChosen(options: ComposeContext["options"]): boolean {
  const secs = options.followupSecs ?? (options.followupDays ? options.followupDays * 86_400 : 0);
  const plan = options.followup;
  return secs > 0 || !!plan && (plan.deadline_secs > 0 || !!plan.due_at || !!plan.deadline_at);
}

export function queueBox(
  acts: ActsOn | null | undefined,
  from: string,
  accounts: { id: string; waiting?: Waiting }[],
  folders: FolderInfo[],
  choice: boolean | null,
  say: Say,
  waits = false,
): QueueBox | null {
  if (!acts || acts.act === "forward" || acts.account_id !== from) return null;
  if (!accounts.find((a) => a.id === from)?.waiting?.park) return null;
  if (acts.waiting) return { checked: true, disabled: true, text: say.t(S.queueWaiting) };
  const folder = folders.find((f) => f.account_id === acts.account_id && f.name === acts.folder);
  if (folder?.role !== "inbox") {
    const name = folder?.display_name ?? acts.folder;
    return { checked: false, disabled: true, text: say.t(S.queueStays, { folder: name }), title: say.t(S.queueStaysTitle, { folder: name }) };
  }
  if (waits) return { checked: false, disabled: true, text: say.t(S.queueBox), title: say.t(S.queueGoesToWait) };
  if (!folders.some((f) => f.account_id === acts.account_id && f.role === "archive")) {
    return { checked: false, disabled: true, text: say.t(S.queueBox), title: say.t(S.queueNoArchive) };
  }
  return { checked: choice ?? true, disabled: false, text: say.t(S.queueBox) };
}
