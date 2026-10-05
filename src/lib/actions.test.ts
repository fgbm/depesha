import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { AppStore } from "./store.svelte";
import { t } from "./i18n.svelte";
import { api, deferred, flush, resetFakes, row } from "./testing";
import type { MessageRow } from "./types";

const ids = (s: AppStore) => s.messages.map((m) => m.id);

/** The inbox with five rows; the first three are conversations of two letters. */
async function inbox() {
  const list = [1, 2, 3, 4, 5].map((id) => row(id, { thread_count: id <= 3 ? 2 : 1 }));
  api.messages.mockResolvedValue(list);
  const s = new AppStore();
  await s.setView({ kind: "folder", account_id: "a", folder: "INBOX" });
  return s;
}

beforeEach(() => resetFakes());

describe("an action", () => {
  it("takes the rows out before asking about their conversations", async () => {
    const s = await inbox();
    const pending = deferred<MessageRow[]>();
    api.thread.mockReturnValue(pending.promise);
    void s.archive([1]);
    expect(ids(s)).not.toContain(1);
    expect(api.thread).toHaveBeenCalledWith(1);
    expect(api.archive).not.toHaveBeenCalled();
  });

  it("asks about every conversation at once", async () => {
    const s = await inbox();
    api.thread.mockReturnValue(new Promise(() => {}));
    void s.archive([1, 2, 3]);
    await flush();
    for (const id of [1, 2, 3]) expect(api.thread).toHaveBeenCalledWith(id);
  });

  it("applies to the whole conversation of a row", async () => {
    const s = await inbox();
    api.thread.mockImplementation(async (id: number) => [row(id), row(id + 100), row(id + 200, { folder: "Sent" })]);
    await s.archive([1]);
    expect(api.archive).toHaveBeenCalledWith(expect.arrayContaining([1, 101]));
    expect(api.archive.mock.calls[0][0]).not.toContain(201);
  });

  it.each([
    ["the conversation cannot be read", () => api.thread.mockRejectedValue({ kind: "other", message: "cache broken" })],
    ["the server refuses", () => api.archive.mockRejectedValue({ kind: "other", message: "cache broken" })],
  ])("that fails because %s is told, and the app goes on", async (_, breakIt) => {
    const s = await inbox();
    breakIt();
    await expect(s.archive([1])).resolves.toBeUndefined();
    expect(s.toasts.some((x) => x.error && x.text === `${t("err.archive")}: cache broken`)).toBe(true);
    expect(ids(s)).toEqual([1, 2, 3, 4, 5]);
    expect(s.list.leaving.size).toBe(0);
    await expect(s.undo()).resolves.toBeUndefined();
    expect(api.undo).not.toHaveBeenCalled();
  });

  it("whose run throws at once does not reject either", async () => {
    const s = await inbox();
    const run = () => {
      throw new Error("plugin bug");
    };
    await expect(s.perform("Done", [4], run, "Plugin")).resolves.toBeUndefined();
    expect(ids(s)).toContain(4);
    expect(s.busy).toBe(0);
  });
});

describe("undo", () => {
  it("takes back the last action that went through", async () => {
    const s = await inbox();
    await s.archive([4]);
    const moved = s.lastUndo?.moved;
    expect(moved?.[0].message_ids).toEqual(["4"]);
    await s.undo();
    expect(api.undo).toHaveBeenCalledWith(moved);
    expect(s.lastUndo).toBeNull();
  });

  it("pressed while the action is on its way waits for it", async () => {
    const s = await inbox();
    const answer = deferred<{ account_id: string; from: string; to: string; message_ids: string[] }[]>();
    api.archive.mockReturnValue(answer.promise);
    void s.archive([4]);
    const undone = s.undo();
    answer.resolve([{ account_id: "a", from: "INBOX", to: "Archive", message_ids: ["4"] }]);
    await undone;
    expect(api.undo).toHaveBeenCalledTimes(1);
  });

  it("after a failed action waits for it and does nothing", async () => {
    const s = await inbox();
    const answer = deferred<never>();
    api.archive.mockReturnValue(answer.promise);
    void s.archive([4]);
    const undone = s.undo();
    answer.reject({ kind: "other", message: "offline" });
    await expect(undone).resolves.toBeUndefined();
    await expect(s.undo()).resolves.toBeUndefined();
    expect(api.undo).not.toHaveBeenCalled();
  });
});
