import MessageSquareReply from "@lucide/svelte/icons/message-square-reply";
import { when, type MessageRow, type Plugin } from "@depesha/plugin-api";
import { left } from "./due";
import RemindSelect from "./RemindSelect.svelte";
import RemindSettings from "./RemindSettings.svelte";
import Repick from "./Repick.svelte";
import { followups } from "./state.svelte";
import { LATE, LEFT, S } from "./strings";

/** What the backend says when a reminder comes: the sent letter by its Message-ID. */
interface Due {
  account_id: string;
  message_id: string;
  subject: string;
}

const bare = (id: string | null | undefined) => (id ?? "").replace(/^<|>$/g, "");

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
    // "2 days left" or "3 days overdue"; the reminder's own time in the hint.
    ctx.ui.rowTag((row) => {
      if (!row.followup_due) return null;
      const l = left(row.followup_due, Math.floor(Date.now() / 1000));
      return {
        icon: MessageSquareReply,
        text: ctx.plural(l.n, (l.overdue ? LATE : LEFT)[l.unit]),
        title: `${ctx.t(S.tag)}: ${when(row.followup_due)}`,
        alert: l.overdue,
      };
    });
    ctx.ui.overlay({ component: Repick, props: { ctx } });

    const openDue = async (due: Due) => {
      try {
        const rows = await ctx.backend<MessageRow[]>("messages", { query: { followups_only: true, threads: false, limit: 1000 } });
        const row = rows.find((r) => r.account_id === due.account_id && bare(r.message_id) === bare(due.message_id));
        if (row) await ctx.mail.open(row.id, "followups");
        else ctx.toast(ctx.t(S.gone));
      } catch (e) {
        ctx.fail(e);
      }
    };
    // The reminder came: the letter and its conversation are a click away. The desktop
    // notification cannot be clicked into the app, hence the toast in the main window.
    ctx.onBackend("followup-due", (payload) => {
      if (!ctx.mail.main()) return;
      const due = payload as Due;
      ctx.toast(ctx.t(S.due, { subject: due.subject || ctx.t(S.noSubject) }), {
        action: { label: ctx.t(S.openConversation), run: () => openDue(due) },
        ms: 15_000,
      });
    });
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
            title: ctx.t(S.repick),
            run: () => (followups.repick = { id: msg.row.id, set: (next) => (msg.row.followup_due = next) }),
          },
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
    return () => (followups.repick = null);
  },
} satisfies Plugin;
