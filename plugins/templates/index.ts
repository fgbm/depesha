import type { Plugin } from "@depesha/plugin-api";
import TemplatesButton from "./TemplatesButton.svelte";
import TemplatesSettings from "./TemplatesSettings.svelte";
import { S } from "./strings";

export interface Template {
  name: string;
  text: string;
}

export default {
  manifest: { id: "templates", name: S.name, description: S.about },
  activate(ctx) {
    ctx.ui.composeControl({ component: TemplatesButton, props: { ctx }, order: 30 });
    ctx.ui.settingsSection({ title: () => ctx.t(S.name), component: TemplatesSettings, props: { ctx }, page: "writing" });
  },
} satisfies Plugin;
