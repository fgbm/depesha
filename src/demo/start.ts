// The entry of the live mockup, mounted by `src/main.ts` through the alias `@demo/start`
// (see `vite.config.ts`). In the real app the same import resolves to `src/lib/demo-off.ts`,
// a no-op, so nothing of `src/demo/` ever reaches the production bundle.

import { mount } from "svelte";
import Questions from "./mockups/Questions.svelte";

/** Puts the «Вопросы» panel over the app. Called once, after the app is mounted. */
export function startDemo(): void {
  const target = document.createElement("div");
  target.id = "demo-questions";
  document.body.appendChild(target);
  mount(Questions, { target });
}
