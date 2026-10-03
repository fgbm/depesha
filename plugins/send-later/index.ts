import type { Plugin } from "@depesha/plugin-api";
import SendLater from "./SendLater.svelte";
import { S } from "./strings";


export default {
  manifest: { id: "send-later", name: S.name, description: S.about },
  activate(ctx) {
    ctx.ui.composeControl({ component: SendLater, props: { ctx }, slot: "send" });
  },
} satisfies Plugin;
