// "Stop waiting" outside the line over the letter: the key it shares with bringing snoozed
// mail back (`core.release`) and an item of the row menu. Covered by index.test.ts.

import MessageSquareReply from "@lucide/svelte/icons/message-square-reply";
import type { MessageRow, PluginContext } from "@depesha/plugin-api";
import { S } from "./strings";
import { stateOf, waitOf } from "./wait";

const now = () => Math.floor(Date.now() / 1000);

/** A letter whose wait is stopped: its row and what the toast calls it. */
export interface Stopped {
  id: number;
  subject: string;
}

/** What a stop tells its caller to do to the rows it shows: after it, and after its undo. */
export interface StopHooks {
  done?: () => void;
  undone?: () => void;
}

/**
 * Ends the waits on the backend and says so with a toast that takes it back, as "Bring back
 * now" does (#98): the waiting returns with the time it had. False when none was ended
 * (the error told, or the wait had ended already).
 */
export async function stopWaiting(ctx: PluginContext, rows: Stopped[], hooks: StopHooks = {}): Promise<boolean> {
  const ended: { row: Stopped; at: number }[] = [];
  for (const row of rows) {
    try {
      // None: the wait had ended meanwhile; there is nothing to tell and nothing to take back.
      const at = await ctx.backend<number | null>("followup_cancel", { id: row.id });
      if (at !== null && at !== undefined) ended.push({ row, at });
    } catch (e) {
      ctx.fail(e);
    }
  }
  if (!ended.length) {
    ctx.mail.reload();
    return false;
  }
  hooks.done?.();
  const what = ended.length === 1 ? ended[0].row.subject || ctx.t(S.noSubject) : ctx.plural(ended.length, S.stoppedMany);
  ctx.toast(ctx.t(S.stopped, { what }), { action: { label: ctx.t(S.undo), run: () => void resumeWaiting(ctx, ended, hooks) } });
  return true;
}

/** "Undo" of the toast: each wait stopped waits again; one that cannot (its letters came back, or it changed some other way since) is told. */
async function resumeWaiting(ctx: PluginContext, ended: { row: Stopped; at: number }[], hooks: StopHooks) {
  let lost = false;
  for (const { row, at } of ended) {
    try {
      if (!(await ctx.backend<boolean>("followup_resume", { id: row.id, ended: at }))) lost = true;
    } catch (e) {
      ctx.fail(e);
    }
  }
  if (lost) ctx.toast(ctx.t(S.resumeFailed), { error: true });
  else hooks.undone?.();
  ctx.mail.reload();
}

/** A wait that is still on: what the line over the letter offers "Stop waiting" for. */
const isWaiting = (row: MessageRow) => {
  const w = waitOf(row);
  return w !== null && ["waiting", "overdue"].includes(stateOf(w, now()));
};

export function registerStop(ctx: PluginContext) {
  // The menu of the rows learns the subjects as it is built; the toast names the letter by them.
  const subjects = new Map<number, string>();
  ctx.ui.keybinding({
    id: "core.release",
    title: () => ctx.t(S.stop),
    run: () => {
      const row = ctx.mail.opened()?.row;
      if (row) void stopWaiting(ctx, [{ id: row.id, subject: row.subject }]).then((ok) => ok && ctx.mail.reload());
    },
    when: () => {
      const row = ctx.mail.opened()?.row;
      return !!row && isWaiting(row);
    },
  });
  ctx.ui.rowAction({
    id: "followups.stop",
    title: () => ctx.t(S.stop),
    icon: MessageSquareReply,
    command: "core.release",
    when: (_ids, rows) => {
      for (const r of rows) subjects.set(r.id, r.subject);
      return rows.length > 0 && rows.every(isWaiting);
    },
    run: (ids) => void stopWaiting(ctx, ids.map((id) => ({ id, subject: subjects.get(id) ?? "" }))).then(() => ctx.mail.reload()),
  });
}
