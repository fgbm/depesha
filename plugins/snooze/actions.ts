import { when, type Moved, type PluginContext } from "@depesha/plugin-api";
import { S } from "./strings";

/** Brings snoozed messages back now, to where they were snoozed from; undo snoozes them again for the same time. */
export function unsnoozeMail(ctx: PluginContext, ids = ctx.mail.selection()) {
  return ctx.mail.perform(
    (moved) => {
      const snoozed = moved.flatMap((m) => m.snoozed ?? []);
      const to = moved[0]?.to ?? "";
      const folder = ctx.mail.folders().find((f) => f.account_id === moved[0]?.account_id && f.name === to)?.display_name ?? to;
      const what =
        snoozed.length === 1 ? snoozed[0].subject || ctx.t(S.noSubject) : ctx.plural(snoozed.length, S.releasedMany);
      return ctx.t(S.released, { folder, what });
    },
    ids,
    (all) => ctx.backend<Moved[]>("unsnooze", { ids: all }),
    ctx.t(S.releaseFailed),
  );
}

/** Moves the messages to the server's Snoozed folder until `until`; undoable. */
export function snoozeMail(ctx: PluginContext, until: number, ids = ctx.mail.selection()) {
  return ctx.mail.perform(
    ctx.t(S.done, { when: when(until) }),
    ids,
    (all) => ctx.backend<Moved[]>("snooze", { ids: all, until }),
    ctx.t(S.failed),
  );
}
