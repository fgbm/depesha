import AlarmClock from "@lucide/svelte/icons/alarm-clock";
import AlarmClockOff from "@lucide/svelte/icons/alarm-clock-off";
import { snoozePresets, when, type Plugin } from "@depesha/plugin-api";
import { snoozeMail, unsnoozeMail } from "./actions";
import SnoozeButton from "./SnoozeButton.svelte";
import SnoozeRowMenu from "./SnoozeRowMenu.svelte";
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
      if (ctx.mail.viewing("snooze")) ctx.mail.scheduleReload(); // waits out a folder burst
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
    ctx.ui.rowAction({
      id: "snooze",
      title: () => `${ctx.t(S.action)}…`,
      icon: AlarmClock,
      command: "snooze.open",
      menu: { component: SnoozeRowMenu, props: { ctx } },
    });
    ctx.ui.keybinding({ id: "snooze.open", title: () => ctx.t(S.action), key: "h", run: () => (snooze.open = true), when: () => ctx.mail.opened() !== null });
    // "w" is shared with "Stop waiting" (the core's `core.release`): the letter's state tells which one runs.
    const snoozed = () => ctx.mail.opened()?.row.snoozed_until != null;
    ctx.ui.keybinding({ id: "core.release", title: () => ctx.t(S.release), run: () => void unsnoozeMail(ctx, [ctx.mail.opened()!.row.id]), when: snoozed });
    ctx.ui.rowAction({
      id: "snooze.release",
      title: () => ctx.t(S.release),
      icon: AlarmClockOff,
      command: "core.release",
      when: (_ids, rows) => rows.length > 0 && rows.every((r) => r.snoozed_until != null),
      run: (ids) => void unsnoozeMail(ctx, ids),
    });
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
    // "Bring back now" sits in the line over the letter like "Stop waiting" does for a wait.
    ctx.ui.banner((msg) =>
      msg.row.snoozed_until
        ? {
            icon: AlarmClock,
            text: ctx.t(S.banner, { when: when(msg.row.snoozed_until) }),
            actions: [{ title: ctx.t(S.release), run: () => void unsnoozeMail(ctx, [msg.row.id]) }],
          }
        : null,
    );
    return () => (snooze.open = false);
  },
} satisfies Plugin;
