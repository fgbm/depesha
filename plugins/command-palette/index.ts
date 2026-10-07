import type { Plugin } from "@depesha/plugin-api";
import Palette from "./Palette.svelte";
import { palette } from "./state.svelte";

const NAME = { en: "Command palette", ru: "Палитра команд" };

export default {
  manifest: {
    id: "command-palette",
    name: NAME,
    description: {
      en: "Ctrl+K: any action, view or folder by a few letters of its name.",
      ru: "Ctrl+K: любое действие, раздел или папка по нескольким буквам названия.",
    },
  },
  activate(ctx) {
    ctx.ui.keybinding({ id: "command-palette.open", title: () => ctx.t(NAME), key: "Mod+k", run: () => (palette.open = !palette.open), where: "everywhere" });
    ctx.ui.overlay({ component: Palette, props: { ctx } });
    return () => (palette.open = false);
  },
} satisfies Plugin;
