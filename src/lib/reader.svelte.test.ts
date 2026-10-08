// Marking a letter read (#71): a letter counts as read only once it was shown a while;
// letters flitted through with the keys are left unread.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { AppStore } from "./store.svelte";
import { api, flush, opened, resetFakes, row, rows } from "./testing";

/** Letters the backend was told were read. */
const markedSeen = () => api.setFlag.mock.calls.filter(([, change]) => change?.flag === "seen").flatMap(([ids]) => ids as number[]);

beforeEach(() => resetFakes());
afterEach(() => vi.useRealTimers());

describe("marking a letter read", () => {
  it("waits until the letter was shown a while, and leaves flitted-through letters unread", async () => {
    api.messages.mockResolvedValue(rows(1, 5));
    api.open.mockImplementation(async (id: number) => opened(row(id)));
    api.thread.mockResolvedValue([]);
    const s = new AppStore();
    await s.setView({ kind: "folder", account_id: "a", folder: "INBOX" });

    vi.useFakeTimers();
    void s.open(1);
    await flush();
    vi.advanceTimersByTime(300);
    void s.open(2);
    await flush();
    vi.advanceTimersByTime(300);
    void s.open(3);
    await flush();
    vi.advanceTimersByTime(300);
    // Nothing was shown long enough yet.
    expect(markedSeen()).toEqual([]);

    vi.advanceTimersByTime(900);
    await flush();
    expect(markedSeen()).toEqual([3]);
  });
});
