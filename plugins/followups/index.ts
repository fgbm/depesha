// "Waiting for reply": the parts are wired here and live in their own modules — the view
// (view.ts), rows (rows.ts), the banner (banner.ts), the line of the compose window with
// the folder and the reminder (WaitLine, RemindSelect, RemindLine), the settings
// (RemindSettings), the notification (notify.ts).

import type { Plugin } from "@depesha/plugin-api";
import { bannerOf } from "./banner";
import { registerNotify } from "./notify";
import RemindLine from "./RemindLine.svelte";
import RemindSettings from "./RemindSettings.svelte";
import Repick from "./Repick.svelte";
import WaitLine from "./WaitLine.svelte";
import { rowTag } from "./rows";
import { followups } from "./state.svelte";
import { registerStop, stopWaiting } from "./stop";
import { S } from "./strings";
import { registerView } from "./view";

const now = () => Math.floor(Date.now() / 1000);

export default {
  manifest: { id: "followups", name: S.name, description: S.about },
  activate(ctx) {
    registerView(ctx);
    registerNotify(ctx);
    // One line for the wait: the letter out of the inbox and the reminder; its details below.
    ctx.ui.composeControl({ component: WaitLine, props: { ctx }, slot: "line", order: 10 });
    ctx.ui.composeControl({ component: RemindLine, props: { ctx }, slot: "line", order: 11 });
    ctx.ui.settingsSection({ title: () => ctx.t(S.settings), component: RemindSettings, props: { ctx }, page: "later" });
    ctx.ui.rowTag((row) => rowTag(row, now(), ctx, ctx.mail.viewing("followups")));
    ctx.ui.overlay({ component: Repick, props: { ctx } });

    registerStop(ctx);

    ctx.ui.banner((msg) => {
      const row = msg.row;
      const f = row.followup;
      /** The row as the backend has it now: waiting until `due`. */
      const waiting = (due: number, deadline: number) => {
        if (f) row.followup = { ...f, status: "waiting", due, deadline, ended: null, answered_by: null, answer: null };
        row.followup_due = due;
      };
      const repick = () => (followups.repick = { id: row.id, set: (next) => waiting(next, next) });
      return bannerOf(row, now(), ctx, {
        again: () => ctx.mail.reply(false),
        later: () =>
          ctx
            .backend<number>("followup_postpone", { id: row.id, secs: 86_400 })
            .then((next) => waiting(next, f?.deadline ?? next))
            .catch((e) => ctx.fail(e)),
        repick,
        waitAgain: repick,
        unpark: () =>
          ctx
            .backend("followup_return", { id: row.id })
            .then(() => {
              if (f) row.followup = { ...f, status: "closed", ended: now(), park: "back" };
              row.followup_due = null;
            })
            .catch((e) => ctx.fail(e)),
        stop: () =>
          stopWaiting(ctx, row.id).then((ok) => {
            if (!ok) return;
            if (f) row.followup = { ...f, status: "closed", ended: now() };
            row.followup_due = null;
          }),
        openAnswer: ctx.mail.main() ? (id) => void ctx.mail.open(id) : undefined,
      });
    });
    return () => (followups.repick = null);
  },
} satisfies Plugin;
