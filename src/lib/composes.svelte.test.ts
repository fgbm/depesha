// Keeping the drafts of a window when it goes (#71): every composition saves through the
// manager (each waited for at most a moment), and the drafts kept locally when the app last
// stopped open again as compositions.
import { describe, expect, it, vi } from "vitest";

vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));

import { ComposeManager, type ComposeHost } from "./composes.svelte";
import { emptyDraft } from "./compose";
import { api } from "./testing";
import type { CachedDraft } from "./types";

/** A manager with nothing but what these methods read. */
function manager(): ComposeManager {
  return new ComposeManager({ windowOf: null } as unknown as ComposeHost);
}

describe("keeping the drafts of a window", () => {
  it("saves every registered composition", async () => {
    const mgr = manager();
    const saved: number[] = [];
    mgr.onSaver(1, async () => (saved.push(1), true));
    mgr.onSaver(2, async () => (saved.push(2), true));
    await mgr.saveAll(1000);
    expect(saved.sort()).toEqual([1, 2]);
    // A closed composition is no longer saved.
    mgr.onSaver(1, null);
    saved.length = 0;
    await mgr.saveAll(1000);
    expect(saved).toEqual([2]);
  });

  it("does not wait for a save past the limit", async () => {
    const mgr = manager();
    mgr.onSaver(1, () => new Promise(() => {}));
    const started = Date.now();
    await mgr.saveAll(30);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("opens the drafts kept locally when the app last stopped", async () => {
    const mgr = manager();
    api.draftCacheDrop.mockResolvedValue(undefined);
    const drafts: CachedDraft[] = [
      { key: "k1", account_id: "a", draft: emptyDraft({ name: "Me", email: "me@example.com" }), updated: 1 },
      { key: "k2", account_id: "a", draft: emptyDraft({ name: "Me", email: "me@example.com" }), updated: 2 },
    ];
    await mgr.restoreLocal(drafts);
    expect(mgr.windows).toHaveLength(2);
    // Each restored draft's local copy goes: it is a window now, not a file.
    expect(api.draftCacheDrop).toHaveBeenCalledWith("k1");
    expect(api.draftCacheDrop).toHaveBeenCalledWith("k2");
  });
});
