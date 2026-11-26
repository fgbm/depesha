import type { Plugin } from "@depesha/plugin-api";
import Help from "./Help.svelte";
import { searchHelp } from "./state.svelte";
import { S } from "./strings";

export default {
  manifest: { id: "search-help", name: S.name, description: S.about },
  activate(ctx) {
    ctx.ui.command({ id: "search-help.open", title: () => ctx.t(S.command), run: () => (searchHelp.open = true) });
    // Ctrl+/ opens it from anywhere, the way F1 would in a program of its own.
    ctx.ui.keybinding({ id: "search-help.open", title: () => ctx.t(S.command), key: "Mod+/", run: () => (searchHelp.open = !searchHelp.open), where: "everywhere" });
    ctx.ui.overlay({ component: Help, props: { ctx } });
    return () => (searchHelp.open = false);
  },
} satisfies Plugin;
