import type { Plugin } from "@depesha/plugin-api";
import { S } from "./strings";
import { TABLE } from "./table";

export default {
  manifest: { id: "typography", name: S.name, description: S.about, defaultOff: true },
  activate(ctx) {
    ctx.ui.composeReplacements(TABLE);
  },
} satisfies Plugin;
