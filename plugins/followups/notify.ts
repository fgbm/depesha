// When a reminder comes the main window offers the letter and its conversation: the
// desktop notification cannot be clicked into the app.

import { type MessageRow, type PluginContext } from "@depesha/plugin-api";
import { S } from "./strings";

/** What the backend says when a reminder comes: the sent letter by its Message-ID. */
interface Due {
  account_id: string;
  message_id: string;
  subject: string;
}

const bare = (id: string | null | undefined) => (id ?? "").replace(/^<|>$/g, "");

export function registerNotify(ctx: PluginContext) {
  const open = async (due: Due) => {
    try {
      const rows = await ctx.backend<MessageRow[]>("messages", { query: { followups_only: true, threads: false, limit: 1000 } });
      const row = rows.find((r) => r.account_id === due.account_id && bare(r.message_id) === bare(due.message_id));
      if (row) await ctx.mail.open(row.id, "followups");
      else ctx.toast(ctx.t(S.gone));
    } catch (e) {
      ctx.fail(e);
    }
  };
  ctx.onBackend("followup-due", (payload) => {
    if (!ctx.mail.main()) return;
    const due = payload as Due;
    ctx.toast(ctx.t(S.due, { subject: due.subject || ctx.t(S.noSubject) }), {
      action: { label: ctx.t(S.openConversation), run: () => open(due) },
      ms: 15_000,
    });
  });
}
