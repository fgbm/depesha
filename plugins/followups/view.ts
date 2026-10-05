// The "Waiting for reply" view: in the sidebar while any wait is kept, Active / Closed over
// its list, the counts from the backend.

import MessageSquareReply from "@lucide/svelte/icons/message-square-reply";
import type { PluginContext } from "@depesha/plugin-api";
import { followups } from "./state.svelte";
import { S } from "./strings";

/** Closed waits are kept this long unless the settings say otherwise; the backend agrees. */
export const KEEP_DAYS = 90;

export function registerView(ctx: PluginContext) {
  const refresh = () =>
    ctx
      .backend<{ followups: number; followups_closed?: number }>("counters")
      .then((c) => {
        followups.count = c.followups;
        followups.closed = c.followups_closed ?? 0;
      })
      .catch(() => {});
  refresh();
  ctx.onBackend("counters-changed", () => {
    refresh();
    if (ctx.mail.viewing("followups")) ctx.mail.scheduleReload(); // waits out a folder burst
  });

  const show = (tab: "active" | "closed") => {
    followups.tab = tab;
    ctx.mail.reload();
  };
  ctx.ui.view({
    id: "followups",
    title: () => ctx.t(S.view),
    icon: MessageSquareReply,
    count: () => followups.count,
    // The closed ones are history worth reaching while nothing waits.
    shown: () => followups.count + followups.closed > 0,
    // Each sent letter waits for its own answer: not grouped.
    query: () => ({ followups_only: true, threads: false, followup_status: followups.tab }),
    tabs: {
      options: () => [
        { id: "active", title: ctx.t(S.tabs.active), count: followups.count },
        { id: "closed", title: ctx.t(S.tabs.closed) },
      ],
      current: () => followups.tab,
      select: (id) => show(id === "closed" ? "closed" : "active"),
    },
    showRecipients: true,
    empty: () =>
      followups.tab === "closed" ? ctx.t(S.emptyClosed, { n: ctx.settings.get<number>("keep_days", KEEP_DAYS) }) : ctx.t(S.empty),
  });
  ctx.ui.command({
    id: "followups.closed",
    title: () => ctx.t(S.closedCmd),
    run: () => {
      followups.tab = "closed";
      ctx.mail.showView("followups");
      ctx.mail.reload();
    },
  });
}
