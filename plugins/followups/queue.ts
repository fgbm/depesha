// The checkbox "Take the letter out of the inbox until a reply" of the compose window (#59,
// frame 6В, 12Б): on an answer to a letter of the inbox in a mailbox that does it, ticked
// as the mailbox says; for a letter of another folder, greyed with the reason. Pure,
// covered by queue.test.ts.

import type { ActsOn, FolderInfo, Waiting } from "@depesha/plugin-api";
import type { Say } from "./labels";
import { S } from "./strings";

export interface QueueBox {
  checked: boolean;
  disabled: boolean;
  text: string;
  title?: string;
}

export function queueBox(
  acts: ActsOn | null | undefined,
  from: string,
  accounts: { id: string; waiting?: Waiting }[],
  folders: FolderInfo[],
  choice: boolean | null,
  say: Say,
): QueueBox | null {
  if (!acts || acts.act === "forward" || acts.account_id !== from) return null;
  if (!accounts.find((a) => a.id === from)?.waiting?.park) return null;
  if (acts.waiting) return { checked: true, disabled: true, text: say.t(S.queueWaiting) };
  const folder = folders.find((f) => f.account_id === acts.account_id && f.name === acts.folder);
  if (folder?.role !== "inbox") {
    const name = folder?.display_name ?? acts.folder;
    return { checked: false, disabled: true, text: say.t(S.queueStays, { folder: name }), title: say.t(S.queueStaysTitle, { folder: name }) };
  }
  return { checked: choice ?? true, disabled: false, text: say.t(S.queueBox) };
}
