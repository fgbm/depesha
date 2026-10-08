// Moving through the list with the keys (#71): a held `j` must go on to the next letter
// at once, not wait for the previous one to open and then open the same letter again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { AppStore } from "./store.svelte";
import { api, deferred, flush, opened, resetFakes, row, rows } from "./testing";
import type { OpenedMessage } from "./types";

beforeEach(() => resetFakes());
afterEach(() => vi.useRealTimers());

describe("moving through the list", () => {
  it("goes on with every key while a letter is still opening", async () => {
    api.messages.mockResolvedValue(rows(1, 30));
    api.open.mockImplementation(async (id: number) => opened(row(id)));
    const s = new AppStore();
    await s.setView({ kind: "folder", account_id: "a", folder: "INBOX" });
    await s.select(1);
    expect(s.opened?.row.id).toBe(1);

    // Every open from now on hangs: the reader keeps showing letter 1 meanwhile.
    api.open.mockClear();
    const pending = deferred<OpenedMessage>();
    api.open.mockReturnValue(pending.promise);
    vi.useFakeTimers();
    for (let i = 0; i < 30; i++) s.move(1);
    vi.advanceTimersByTime(200);
    await flush();

    expect([...s.selected]).toEqual([30]);
    expect(api.open.mock.calls.length).toBeLessThanOrEqual(2);
    expect(api.open).toHaveBeenLastCalledWith(30, false, expect.any(Number));
  });

  it("syncs only the folder the clicks stopped on", async () => {
    api.messages.mockResolvedValue([]);
    api.folders.mockResolvedValue([
      { account_id: "a", name: "INBOX", role: "inbox" },
      { account_id: "a", name: "Archive", role: "archive" },
    ] as never);
    const s = new AppStore();
    vi.useFakeTimers();
    await s.setView({ kind: "folder", account_id: "a", folder: "Archive" });
    await s.setView({ kind: "folder", account_id: "a", folder: "INBOX" });
    await s.setView({ kind: "folder", account_id: "a", folder: "Archive" });
    expect(api.syncNow).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    await flush();
    expect(api.syncNow).toHaveBeenCalledTimes(1);
    expect(api.syncNow).toHaveBeenCalledWith("a", "Archive");
  });
});

describe("archiving through the list", () => {
  it("takes the next letter with every key while the previous one is still opening", async () => {
    api.messages.mockResolvedValue(rows(1, 30));
    api.open.mockImplementation(async (id: number) => opened(row(id)));
    api.thread.mockResolvedValue([]);
    const s = new AppStore();
    await s.setView({ kind: "folder", account_id: "a", folder: "INBOX" });
    await s.select(1);

    api.open.mockClear();
    api.setFlag.mockClear();
    const pending = deferred<OpenedMessage>();
    api.open.mockReturnValue(pending.promise);
    const gone = new Set<number>();
    api.archive.mockImplementation(async (ids: number[]) => {
      for (const id of ids) gone.add(id);
      return [{ account_id: "a", from: "INBOX", to: "Archive", message_ids: ids.map(String) }];
    });
    api.messages.mockImplementation(async () => rows(1, 30).filter((m) => !gone.has(m.id)));
    vi.useFakeTimers();

    for (let n = 1; n <= 20; n++) {
      void s.archive();
      expect(s.messages.map((m) => m.id)).not.toContain(n);
      expect([...s.selected]).toEqual([n + 1]);
    }
    expect(gone.size).toBe(0);
    await flush();
    expect([...gone]).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

    vi.advanceTimersByTime(200);
    await flush();
    expect(api.open.mock.calls.length).toBeLessThanOrEqual(2);
    expect(api.open).toHaveBeenLastCalledWith(21, false, expect.any(Number));
    // Archived letters are marked read by the move, not by a flag between the moves:
    // that flag would split the series. Letters we only passed are not marked either.
    const acted = api.setFlag.mock.calls.filter(([, change]) => change?.flag === "seen").flatMap(([ids]) => ids);
    expect(acted).toEqual([]);
    pending.resolve(opened(row(21)));
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();
    const marked = api.setFlag.mock.calls.filter(([, change]) => change?.flag === "seen").flatMap(([ids]) => ids);
    // Stopping opens 21 and marks it; nothing past it.
    expect(marked).toEqual([21]);
  });
});
