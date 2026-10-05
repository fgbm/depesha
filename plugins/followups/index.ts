import MessageSquareReply from "@lucide/svelte/icons/message-square-reply";
import { when, type Plugin } from "@depesha/plugin-api";
import RemindSelect from "./RemindSelect.svelte";
import RemindSettings from "./RemindSettings.svelte";
import { followups } from "./state.svelte";
import { S } from "./strings";

export default {
  manifest: { id: "followups", name: S.name, description: S.about },
  activate(ctx) {
    const refresh = () =>
      ctx
        .backend<{ followups: number }>("counters")
        .then((c) => (followups.count = c.followups))
        .catch(() => {});
    refresh();
    ctx.onBackend("counters-changed", () => {
      refresh();
      if (ctx.mail.viewing("followups")) ctx.mail.reload();
    });

    ctx.ui.view({
      id: "followups",
      title: () => ctx.t(S.view),
      icon: MessageSquareReply,
      count: () => followups.count,
      // Each sent letter waits for its own answer: not grouped.
      query: () => ({ followups_only: true, threads: false }),
      showRecipients: true,
      empty: () => ctx.t(S.empty),
    });
    ctx.ui.composeControl({ component: RemindSelect, props: { ctx }, order: 10 });
    ctx.ui.settingsSection({ title: () => ctx.t(S.settings), component: RemindSettings, props: { ctx } });
    ctx.ui.rowTag((row) =>
      row.followup_due
        ? {
            icon: MessageSquareReply,
            text: when(row.followup_due),
            title: ctx.t(S.tag),
            alert: row.followup_due * 1000 < Date.now(),
          }
        : null,
    );
    ctx.ui.banner((msg) => {
      const due = msg.row.followup_due;
      if (!due) return null;
      // Past due: what to do about the silence, not only the wait.
      const overdue = due * 1000 < Date.now();
      return {
        icon: MessageSquareReply,
        tone: overdue ? "warn" : undefined,
        text: ctx.t(overdue ? S.overdue : S.banner, { when: when(due) }),
        actions: [
          ...(overdue
            ? [
                { title: ctx.t(S.again), primary: true, run: () => ctx.mail.reply(false) },
                {
                  title: ctx.t(S.later),
                  run: () =>
                    ctx
                      .backend<number>("followup_postpone", { id: msg.row.id, secs: 86_400 })
                      .then((next) => (msg.row.followup_due = next))
                      .catch((e) => ctx.fail(e)),
                },
              ]
            : []),
          {
            title: ctx.t(S.stop),
            run: () =>
              ctx
                .backend("followup_cancel", { id: msg.row.id })
                .then(() => (msg.row.followup_due = null))
                .catch((e) => ctx.fail(e)),
          },
        ],
      };
    });
  },
} satisfies Plugin;
