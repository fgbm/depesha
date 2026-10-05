import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, PluginContext, View } from "@depesha/plugin-api";
import { sayIn } from "./fixtures";
import { followups } from "./state.svelte";
import { registerView } from "./view";

/** A context that keeps what the view registers and answers the counters. */
function fakeContext(counters: { followups: number; followups_closed: number }) {
  const got: { view?: View; command?: Command; onCounters?: () => void } = {};
  const settings: Record<string, unknown> = {};
  const ctx = {
    ...sayIn("ru"),
    backend: vi.fn(async () => counters),
    onBackend: (event: string, run: () => void) => event === "counters-changed" && (got.onCounters = run),
    settings: { get: <T,>(key: string, fallback: T) => (key in settings ? (settings[key] as T) : fallback), set: (k: string, v: unknown) => (settings[k] = v) },
    mail: { reload: vi.fn(), scheduleReload: vi.fn(), viewing: () => true, showView: vi.fn() },
    ui: { view: (v: View) => (got.view = v), command: (c: Command) => (got.command = c) },
  } as unknown as PluginContext;
  return { ctx, got };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  followups.count = 0;
  followups.closed = 0;
  followups.tab = "active";
});

describe("the Waiting for reply view", () => {
  it("switches between Active and Closed over its list", async () => {
    const { ctx, got } = fakeContext({ followups: 5, followups_closed: 2 });
    registerView(ctx);
    await settle();
    const v = got.view!;
    expect(v.query()).toEqual({ followups_only: true, threads: false, followup_status: "active" });
    expect(v.tabs!.options()).toEqual([
      { id: "active", title: "Активные", count: 5 },
      { id: "closed", title: "Закрытые" },
    ]);
    v.tabs!.select("closed");
    expect(v.tabs!.current()).toBe("closed");
    expect(v.query().followup_status).toBe("closed");
    expect(ctx.mail.reload).toHaveBeenCalled();
    expect(v.empty()).toContain("90 дней");
  });

  it("stays in the sidebar while a closed wait is kept, its badge the active ones", async () => {
    const counters = { followups: 0, followups_closed: 1 };
    const { ctx, got } = fakeContext(counters);
    registerView(ctx);
    await settle();
    expect(got.view!.count()).toBe(0);
    expect(got.view!.shown!()).toBe(true);
    counters.followups_closed = 0;
    got.onCounters!();
    await settle();
    expect(got.view!.shown!()).toBe(false);
  });

  it("a burst of counters changes reloads the open list once, debounced", async () => {
    const { ctx, got } = fakeContext({ followups: 3, followups_closed: 0 });
    registerView(ctx);
    await settle();
    // A full sync changes folders one after another: each event waits, none reloads at once.
    got.onCounters!();
    got.onCounters!();
    got.onCounters!();
    expect(ctx.mail.scheduleReload).toHaveBeenCalledTimes(3);
    expect(ctx.mail.reload).not.toHaveBeenCalled();
    // The counters still refresh on every event: only the list waits out the burst.
    expect(ctx.backend).toHaveBeenCalledTimes(4);
  });

  it("the palette opens the closed ones", async () => {
    const { ctx, got } = fakeContext({ followups: 1, followups_closed: 1 });
    registerView(ctx);
    got.command!.run();
    expect(followups.tab).toBe("closed");
    expect(ctx.mail.showView).toHaveBeenCalledWith("followups");
  });
});
