import ListX from "@lucide/svelte/icons/list-x";
import type { ListScope, OpenedMessage, Plugin, PluginContext } from "@depesha/plugin-api";
import UnsubscribeChip from "./UnsubscribeChip.svelte";
import { confirmation, type Plan } from "./confirm";
import { unsub } from "./state.svelte";
import { S } from "./strings";

type Split = "all" | "people" | "bulk";

function listName(ctx: PluginContext, msg: OpenedMessage): string {
  return msg.view.summary.from?.name ?? msg.view.summary.from?.email ?? ctx.t(S.fallback);
}

type Unsubscribed = { kind: "done" } | { kind: "mail-sent"; to: string } | { kind: "confirm"; plan: Plan; reason: string };

function close() {
  unsub.confirm = null;
  unsub.plan = null;
  unsub.reason = null;
}

/** Asks the backend how it would unsubscribe; the banner shows that before anything goes out. */
async function ask(ctx: PluginContext, id: number) {
  close();
  unsub.confirm = id;
  try {
    const plan = await ctx.backend<Plan>("unsubscribe_plan", { id });
    if (unsub.confirm === id) unsub.plan = plan;
  } catch (e) {
    if (unsub.confirm === id) close();
    ctx.fail(e, ctx.t(S.failed));
  }
}

/** Does what the banner showed, and only that. */
async function unsubscribe(ctx: PluginContext, msg: OpenedMessage, plan: Plan) {
  const id = msg.row.id;
  const name = listName(ctx, msg);
  close();
  if (plan.way.kind === "link") {
    ctx.openLink(plan.way.url);
    return;
  }
  try {
    const r = await ctx.backend<Unsubscribed>("unsubscribe", { id, way: plan.way.kind });
    if (r.kind === "done") ctx.toast(ctx.t(S.done, { name }));
    else if (r.kind === "mail-sent") ctx.toast(ctx.t(S.mailSent, { to: r.to }));
    else {
      // One click failed: the letter needs its own yes.
      unsub.confirm = id;
      unsub.plan = r.plan;
      unsub.reason = r.reason;
    }
  } catch (e) {
    ctx.fail(e, ctx.t(S.failed));
  }
}

export default {
  manifest: { id: "newsletters", name: S.name, description: S.about },
  activate(ctx) {
    // Each list keeps its own choice. The single choice of earlier versions ("split",
    // inboxes only) stays what inboxes show until one is made for them.
    const current = (list: ListScope): Split =>
      ctx.settings.get<Record<string, Split>>("splits", {})[list.key] ??
      (list.inbox ? ctx.settings.get<Split>("split", "all") : "all");
    ctx.ui.listFilter({
      title: () => ctx.t(S.show),
      options: () => [
        { id: "all", title: ctx.t(S.all) },
        { id: "people", title: ctx.t(S.people) },
        { id: "bulk", title: ctx.t(S.bulk) },
      ],
      current,
      select: (list, id) => {
        ctx.settings.set("splits", { ...ctx.settings.get<Record<string, Split>>("splits", {}), [list.key]: id });
        ctx.mail.reload();
      },
      query: (list) => {
        const split = current(list);
        return split === "all" ? {} : { bulk: split === "bulk" };
      },
    });
    ctx.ui.readerHeader({ component: UnsubscribeChip, props: { ctx, ask: (id: number) => ask(ctx, id) } });
    ctx.ui.messageAction({
      id: "newsletters.unsubscribe",
      title: () => ctx.t(S.action),
      icon: ListX,
      when: (msg) => !!msg.view.summary.unsubscribe,
      run: (msg) => ask(ctx, msg.row.id),
    });
    ctx.ui.banner((msg) => {
      const plan = unsub.plan;
      if (unsub.confirm !== msg.row.id || !plan) return null;
      const go = plan.way.kind === "mail" ? S.send : plan.way.kind === "link" ? S.openPage : S.action;
      return {
        icon: ListX,
        ...confirmation(ctx.t, listName(ctx, msg), plan, unsub.reason),
        actions: [
          { title: ctx.t(go), primary: true, run: () => unsubscribe(ctx, msg, plan) },
          { title: ctx.t(S.cancel), run: close },
        ],
      };
    });
    return close;
  },
} satisfies Plugin;
