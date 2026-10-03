import AlarmClock from "@lucide/svelte/icons/alarm-clock";
import { snoozePresets, when, type Plugin } from "@depesha/plugin-api";
import { snoozeMail } from "./actions";
import SnoozeButton from "./SnoozeButton.svelte";
import { snooze } from "./state.svelte";
import { S } from "./strings";

export default {
  manifest: { id: "snooze", name: S.name, description: S.about },
  activate(ctx) {
    const refresh = () =>
      ctx
        .backend<{ snoozed: number }>("counters")
        .then((c) => (snooze.count = c.snoozed))
        .catch(() => {});
    refresh();
    ctx.onBackend("counters-changed", () => {
      refresh();
      if (ctx.mail.viewing("snooze")) ctx.mail.reload();
    });

    ctx.ui.view({
      id: "snooze",
      title: () => ctx.t(S.view),
      icon: AlarmClock,
      count: () => snooze.count,
      query: () => ({ snoozed_only: true }),
      empty: () => ctx.t(S.empty),
    });
    ctx.ui.readerToolbar({ component: SnoozeButton, props: { ctx } });
    ctx.ui.bulkToolbar({ component: SnoozeButton, props: { ctx, bulk: true } });
    ctx.ui.keybinding("h", () => (snooze.open = true), () => ctx.mail.opened() !== null);
    for (const [i, p] of snoozePresets().entries()) {
      ctx.ui.command({
        id: `snooze.preset.${i}`,
        // Presets move with the clock: recomputed each time the palette asks.
        title: () => ctx.t(S.command, { when: (snoozePresets()[i] ?? p).label.toLowerCase() }),
        hint: () => (snoozePresets()[i] ?? p).hint,
        when: () => ctx.mail.selection().length > 0 && snoozePresets()[i] !== undefined,
        run: () => snoozeMail(ctx, snoozePresets()[i].at),
      });
    }
    ctx.ui.rowTag((row) => (row.snoozed_until ? { icon: AlarmClock, text: when(row.snoozed_until), title: ctx.t(S.tag) } : null));
    ctx.ui.banner((msg) => (msg.row.snoozed_until ? { icon: AlarmClock, text: ctx.t(S.banner, { when: when(msg.row.snoozed_until) }) } : null));
    return () => (snooze.open = false);
  },
} satisfies Plugin;
