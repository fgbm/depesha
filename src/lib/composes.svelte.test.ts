// Keeping the drafts of a window when it goes (#71): every composition saves through the
// manager (each waited for at most a moment), and the drafts kept locally when the app last
// stopped open again as compositions.
import { describe, expect, it, vi } from "vitest";

vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));

import { ComposeManager, type ComposeHost } from "./composes.svelte";
import { bus } from "./bus";
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
    const offs = [
      bus.on("compose.save-all", (all) => all.add((saved.push(1), Promise.resolve(true)))),
      bus.on("compose.save-all", (all) => all.add((saved.push(2), Promise.resolve(true)))),
    ];
    try {
      await mgr.saveAll(1000);
      expect(saved.sort()).toEqual([1, 2]);
      // A closed composition is no longer saved.
      offs[0]();
      saved.length = 0;
      await mgr.saveAll(1000);
      expect(saved).toEqual([2]);
    } finally {
      offs.forEach((off) => off());
    }
  });

  it("does not wait for a save past the limit", async () => {
    const mgr = manager();
    const off = bus.on("compose.save-all", (all) => all.add(new Promise(() => {})));
    try {
      const started = Date.now();
      await mgr.saveAll(30);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      off();
    }
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

  it("keeps the server copy of a restored draft, so a save replaces it", async () => {
    const mgr = manager();
    api.draftCacheDrop.mockResolvedValue(undefined);
    const draft = emptyDraft({ name: "Me", email: "me@example.com" });
    await mgr.restoreLocal([{ key: "k1", account_id: "a", draft, draft_id: 42, draft_message_id: "m42@depesha.local", updated: 1 }]);
    expect(mgr.windows[0].draft_id).toBe(42);
    // The number alone may name another draft by now: the Message-ID goes with it (#92).
    expect(mgr.windows[0].draft_message_id).toBe("m42@depesha.local");
  });

  it("restores a copy written before the Message-ID was kept", async () => {
    const mgr = manager();
    api.draftCacheDrop.mockResolvedValue(undefined);
    const draft = emptyDraft({ name: "Me", email: "me@example.com" });
    await mgr.restoreLocal([{ key: "k1", account_id: "a", draft, draft_id: 42, updated: 1 }]);
    expect(mgr.windows[0].draft_id).toBe(42);
    expect(mgr.windows[0].draft_message_id).toBeNull();
  });
});

describe("the drafts the backend spares when Drafts are cleared (#74)", () => {
  it("reports a window opened on a server draft, and takes it back when the window closes", () => {
    const mgr = manager();
    api.draftOpen.mockClear();
    const draft = emptyDraft({ name: "Me", email: "me@example.com" });
    const id = mgr.open({ account_id: "a", draft, draft_id: 42 });
    const local = mgr.windows[0].local_id;
    expect(api.draftOpen).toHaveBeenCalledWith(local, 42, null);
    mgr.close(id);
    expect(api.draftOpen).toHaveBeenLastCalledWith(local, null);
  });

  it("gives the Message-ID of the draft it opens on, by which the backend finds it again", () => {
    const mgr = manager();
    api.draftOpen.mockClear();
    mgr.open({ account_id: "a", draft: emptyDraft({ name: "Me", email: "me@example.com" }), draft_id: 42, draft_message_id: "<x@depesha.local>" });
    expect(api.draftOpen).toHaveBeenCalledWith(mgr.windows[0].local_id, 42, "<x@depesha.local>");
  });

  it("tells the backend to forget the drafts of an earlier page when a page loads", () => {
    api.draftOpenReset.mockClear();
    manager();
    expect(api.draftOpenReset).toHaveBeenCalledTimes(1);
  });

  it("tells the backend a window without a server draft closed too, so a save on its way registers nothing", () => {
    const mgr = manager();
    api.draftOpen.mockClear();
    const id = mgr.open({ account_id: "a", draft: emptyDraft({ name: "Me", email: "me@example.com" }), draft_id: null });
    const local = mgr.windows[0].local_id;
    mgr.close(id);
    expect(api.draftOpen).toHaveBeenCalledTimes(1);
    expect(api.draftOpen).toHaveBeenCalledWith(local, null);
  });
});

describe("the «Sending…» toast", () => {
  it("counts the seconds down while it stays on the screen (#75)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000_000_000));
      const now = Date.now() / 1000;
      api.send.mockResolvedValue({ id: 1, at: now + 10 });
      const texts: string[] = [];
      const host = {
        windowOf: null,
        ui: {
          toast: (text: string) => (texts.push(text), 7),
          retext: (_id: number, text: string) => (texts.push(text), true),
        },
      } as unknown as ComposeHost;
      await new ComposeManager(host).send("a", emptyDraft({ name: "Me", email: "me@example.com" }), null, null, null, null);
      expect(texts[0]).toMatch(/10 seconds/);
      await vi.advanceTimersByTimeAsync(3000);
      expect(texts.at(-1)).toMatch(/7 seconds/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a local copy that cannot be dropped (#147)", () => {
  it("does not open a copy it cannot take out of the cache, so the copy does not multiply under a new key", async () => {
    const boom = new Error("disk locked");
    api.draftCacheDrop.mockRejectedValue(boom);
    const fail = vi.fn();
    const mgr = new ComposeManager({ windowOf: null, ui: { fail } } as unknown as ComposeHost);
    const draft = emptyDraft({ name: "Me", email: "me@example.com" });
    const copy = { key: "k1", account_id: "a", draft, draft_id: null, updated: 1 };
    await mgr.restoreLocal([copy]);
    await mgr.restoreLocal([copy]);
    expect(mgr.windows).toHaveLength(0);
    expect(api.draftCacheDrop).toHaveBeenCalledTimes(2);
    expect(fail).toHaveBeenCalledWith(boom, expect.any(String));
  });

  it("takes the copy out of the cache before the window opens", async () => {
    const mgr = manager();
    const seen: number[] = [];
    api.draftCacheDrop.mockImplementation(async () => void seen.push(mgr.windows.length));
    const draft = emptyDraft({ name: "Me", email: "me@example.com" });
    await mgr.restoreLocal([{ key: "k1", account_id: "a", draft, draft_id: null, updated: 1 }]);
    expect(seen).toEqual([0]);
    expect(mgr.windows).toHaveLength(1);
  });
});
