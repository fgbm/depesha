import type { Plugin } from "@depesha/plugin-api";
import Palette from "./Palette.svelte";
import { palette } from "./state.svelte";

const NAME = { en: "Command palette", ru: "Палитра команд" };

export default {
  manifest: {
    id: "command-palette",
    name: NAME,
    description: {
      en: "Any action, view or folder by a few letters of its name.",
      ru: "Любое действие, раздел или папка по нескольким буквам названия.",
    },
  },
  activate(ctx) {
    ctx.ui.keybinding({ id: "command-palette.open", title: () => ctx.t(NAME), key: "Mod+k", run: () => (palette.open = !palette.open), where: "everywhere" });
    // The palette's own entry (#46): the way into Settings → «Keys» from here.
    ctx.ui.command({ id: "command-palette.keys", title: () => ctx.t({ en: "Configure keys…", ru: "Настроить клавиши…" }), run: () => ctx.editKeys("", "") });
    ctx.ui.overlay({ component: Palette, props: { ctx } });
    return () => (palette.open = false);
  },
} satisfies Plugin;
