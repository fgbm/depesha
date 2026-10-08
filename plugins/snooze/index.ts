import AlarmClock from "@lucide/svelte/icons/alarm-clock";
import AlarmClockOff from "@lucide/svelte/icons/alarm-clock-off";
import { when, type Plugin, type PluginContext } from "@depesha/plugin-api";
import { snoozeMail, unsnoozeMail } from "./actions";
import { readerButtonAnchor } from "./anchor";
import { fmtDay } from "./format";
import SnoozeButton from "./SnoozeButton.svelte";
import SnoozeOverlay from "./SnoozeOverlay.svelte";
import { closeSnooze, openSnooze, snooze } from "./state.svelte";
import { S } from "./strings";
import { slots, type SlotId } from "./times";

/** The palette offers the moments of the menu: «Snooze: tomorrow»; they move with the clock. */
function presetCommands(ctx: PluginContext) {
  const ids: SlotId[] = ["evening", "tomorrow", "weekend", "nextWeek", "nextMonth"];
  for (const id of ids) {
    const slot = () => slots(new Date(), ctx.workTime()).find((x) => x.id === id)!;
    ctx.ui.command({
      id: `snooze.preset.${id}`,
      title: () => ctx.t(S.command, { when: ctx.t(S[id]).toLowerCase() }),
      hint: () => (slot().at ? fmtDay(slot().at!, ctx.lang()) : ""),
      when: () => ctx.mail.selection().length > 0 && slot().off === null,
      run: () => snoozeMail(ctx, Math.floor(slot().at!.getTime() / 1000)),
    });
  }
}

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
      run: (ids, at) => openSnooze(ids, at ?? ctx.anchor()),
    });
    ctx.ui.overlay({ component: SnoozeOverlay, props: { ctx } });
    // By a key the menu hangs on the selected row; a letter's own window has no list, there it hangs on the button.
    ctx.ui.keybinding({
      id: "snooze.open",
      title: () => ctx.t(S.action),
      key: "h",
      run: () => openSnooze(ctx.mail.selection(), (!ctx.mail.main() && readerButtonAnchor()) || ctx.anchor()),
      when: () => ctx.mail.selection().length > 0,
    });
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
    presetCommands(ctx);
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
    return closeSnooze;
  },
} satisfies Plugin;
