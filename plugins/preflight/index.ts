import type { Plugin } from "@depesha/plugin-api";
import { preflight } from "./check";
import { S } from "./strings";

export default {
  manifest: { id: "preflight", name: S.name, description: S.about },
  activate(ctx) {
    ctx.ui.sendCheck((draft, email) =>
      preflight(draft, email).map((w) =>
        w.kind === "many" ? ctx.plural(w.n, S.many) : ctx.t(S[w.kind], { domains: w.domains ?? "" }),
      ),
    );
  },
} satisfies Plugin;
