import type { Plugin } from "@depesha/plugin-api";
import FromTint from "./FromTint.svelte";
import { S } from "./strings";

export default {
  manifest: { id: "account-color", name: S.name, description: S.about, defaultOff: true },
  activate(ctx) {
    // The "From" slot sits just before the mailbox select; the tint follows its choice.
    ctx.ui.composeControl({ component: FromTint, props: { ctx }, slot: "from" });
  },
} satisfies Plugin;
