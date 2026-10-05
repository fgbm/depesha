import ListX from "@lucide/svelte/icons/list-x";
import type { ListScope, OpenedMessage, Plugin, PluginContext } from "@depesha/plugin-api";
import UnsubscribeChip from "./UnsubscribeChip.svelte";
import { unsub } from "./state.svelte";
import { S } from "./strings";

type Split = "all" | "people" | "bulk";

function listName(ctx: PluginContext, msg: OpenedMessage): string {
  return msg.view.summary.from?.name ?? msg.view.summary.from?.email ?? ctx.t(S.fallback);
}

async function unsubscribe(ctx: PluginContext, msg: OpenedMessage) {
  unsub.confirm = null;
  const name = listName(ctx, msg);
  try {
    const r = await ctx.backend<{ kind: "done" } | { kind: "mail-sent"; to: string } | { kind: "link"; url: string }>("unsubscribe", {
      id: msg.row.id,
    });
    if (r.kind === "done") ctx.toast(ctx.t(S.done, { name }));
    else if (r.kind === "mail-sent") ctx.toast(ctx.t(S.mailSent, { to: r.to }));
    else ctx.openLink(r.url);
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
    ctx.ui.readerHeader({ component: UnsubscribeChip, props: { ctx } });
    ctx.ui.messageAction({
      id: "newsletters.unsubscribe",
      title: () => ctx.t(S.action),
      icon: ListX,
      when: (msg) => !!msg.view.summary.unsubscribe,
      run: (msg) => (unsub.confirm = msg.row.id),
    });
    ctx.ui.banner((msg) =>
      unsub.confirm === msg.row.id
        ? {
            icon: ListX,
            tone: "info",
            text: ctx.t(S.confirm, { name: listName(ctx, msg) }),
            actions: [
              { title: ctx.t(S.action), primary: true, run: () => unsubscribe(ctx, msg) },
              { title: ctx.t(S.cancel), run: () => (unsub.confirm = null) },
            ],
          }
        : null,
    );
    return () => (unsub.confirm = null);
  },
} satisfies Plugin;
