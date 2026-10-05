// Warnings before a letter leaves: the plugins' checks, then the extensions'. Shared by the
// composition window and the quick reply.

import { registry } from "../plugin-host/registry.svelte";
import { extensions } from "./extensions.svelte";
import type { ComposeDraft } from "./types";

/** Everything the checks found; a check that fails is logged and the others still run. */
export async function sendWarnings(draft: ComposeDraft, accountEmail: string): Promise<string[]> {
  const found: string[] = [];
  for (const check of registry.items("sendChecks")) {
    try {
      found.push(...check(draft, accountEmail));
    } catch (err) {
      console.error("send check failed:", err);
    }
  }
  found.push(...(await extensions.beforeSend(draft, accountEmail)));
  return found;
}
