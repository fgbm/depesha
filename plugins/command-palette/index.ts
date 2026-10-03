import type { Plugin } from "@depesha/plugin-api";
import Palette from "./Palette.svelte";
import { palette } from "./state.svelte";

export default {
  manifest: {
    id: "command-palette",
    name: { en: "Command palette", ru: "Палитра команд" },
    description: {
      en: "Ctrl+K: any action, view or folder by a few letters of its name.",
      ru: "Ctrl+K: любое действие, раздел или папка по нескольким буквам названия.",
    },
  },
  activate(ctx) {
    ctx.ui.keybinding("Mod+k", () => (palette.open = !palette.open));
    ctx.ui.overlay({ component: Palette, props: { ctx } });
    return () => (palette.open = false);
  },
} satisfies Plugin;
