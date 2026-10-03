import { when, type Moved, type PluginContext } from "@depesha/plugin-api";
import { S } from "./strings";

/** Moves the messages to the server's Snoozed folder until `until`; undoable. */
export function snoozeMail(ctx: PluginContext, until: number, ids = ctx.mail.selection()) {
  return ctx.mail.perform(
    ctx.t(S.done, { when: when(until) }),
    ids,
    (all) => ctx.backend<Moved[]>("snooze", { ids: all, until }),
    ctx.t(S.failed),
  );
}
