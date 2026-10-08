// "Stop waiting" outside the line over the letter: the key it shares with bringing snoozed
// mail back (`core.release`) and an item of the row menu. Covered by index.test.ts.

import MessageSquareReply from "@lucide/svelte/icons/message-square-reply";
import type { MessageRow, PluginContext } from "@depesha/plugin-api";
import { S } from "./strings";
import { stateOf, waitOf } from "./wait";

const now = () => Math.floor(Date.now() / 1000);

/** Ends the wait on the backend; false (and the error told) when it did not. */
export const stopWaiting = (ctx: PluginContext, id: number) =>
  ctx
    .backend("followup_cancel", { id })
    .then(() => true)
    .catch((e) => (ctx.fail(e), false));

/** A wait that is still on: what the line over the letter offers "Stop waiting" for. */
const isWaiting = (row: MessageRow) => {
  const w = waitOf(row);
  return w !== null && ["waiting", "overdue"].includes(stateOf(w, now()));
};

export function registerStop(ctx: PluginContext) {
  ctx.ui.keybinding({
    id: "core.release",
    title: () => ctx.t(S.stop),
    run: () => {
      const row = ctx.mail.opened()?.row;
      if (row) void stopWaiting(ctx, row.id).then((ok) => ok && ctx.mail.reload());
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
    when: (_ids, rows) => rows.length > 0 && rows.every(isWaiting),
    run: (ids) => void Promise.all(ids.map((id) => stopWaiting(ctx, id))).then(() => ctx.mail.reload()),
  });
}
