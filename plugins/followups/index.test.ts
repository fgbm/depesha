import { describe, expect, it, vi } from "vitest";
import type { KeyBinding, OpenedMessage, PluginContext, RowAction } from "@depesha/plugin-api";
import { letter, sayIn, wait } from "./fixtures";
import { registerStop } from "./stop";

/** A context that keeps the key and the menu item of the plugin; its backend takes every command. */
function fakeContext(opened: OpenedMessage | null) {
  const keys: KeyBinding[] = [];
  const actions: RowAction[] = [];
  const backend = vi.fn(async (command: string): Promise<unknown> => (command === "followup_cancel" ? 1_800_000_000 : command === "followup_resume" ? true : undefined));
  const reload = vi.fn();
  const toast = vi.fn();
  const offerUndo = vi.fn();
  const say = sayIn("ru");
  const ctx = {
    ...say,
    backend,
    toast,
    fail: vi.fn(),
    mail: { opened: () => opened, reload, offerUndo, viewing: () => false },
    ui: {
      keybinding: (b: KeyBinding) => keys.push(b),
      rowAction: (a: RowAction) => actions.push(a),
    },
  } as unknown as PluginContext;
  registerStop(ctx);
  return { keys, actions, backend, reload, toast, offerUndo };
}

const opened = (status: "waiting" | "closed") => ({ row: letter(wait({ status })) }) as OpenedMessage;

describe("«Stop waiting» on the key shared with bringing snoozed mail back (#93)", () => {
  it("runs on a letter that is still waited for, and not on a closed wait or no letter", () => {
    expect(fakeContext(opened("waiting")).keys.find((k) => k.id === "core.release")?.when?.()).toBe(true);
    expect(fakeContext(opened("closed")).keys.find((k) => k.id === "core.release")?.when?.()).toBe(false);
    expect(fakeContext(null).keys.find((k) => k.id === "core.release")?.when?.()).toBe(false);
  });

  it("cancels the wait of the opened letter", async () => {
    const msg = opened("waiting");
    const { keys, backend, reload } = fakeContext(msg);
    keys.find((k) => k.id === "core.release")!.run();
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    expect(backend).toHaveBeenCalledWith("followup_cancel", { id: msg.row.id });
  });

  it("is an item of the context menu for rows that are waited for", async () => {
    const { actions, backend } = fakeContext(null);
    const item = actions.find((a) => a.id === "followups.stop")!;
    expect(item.command).toBe("core.release");
    expect(item.when?.([1], [letter(wait())])).toBe(true);
    expect(item.when?.([1], [letter(wait({ status: "answered" }))])).toBe(false);
    item.run?.([7]);
    expect(backend).toHaveBeenCalledWith("followup_cancel", { id: 7 });
  });
});

describe("«Stop waiting» tells so and can be taken back, as «Bring back now» can (#98)", () => {
  it("offers the undo (so that «z» takes it back) with the subject", async () => {
    const msg = opened("waiting");
    const { keys, offerUndo, toast } = fakeContext(msg);
    keys.find((k) => k.id === "core.release")!.run();
    await vi.waitFor(() => expect(offerUndo).toHaveBeenCalled());
    expect(offerUndo.mock.calls[0][0]).toBe(`Не ждём ответа: ${msg.row.subject}`);
    expect(toast).not.toHaveBeenCalled();
  });

  it("takes the wait back with the moment it was closed at, and reloads the list", async () => {
    const { keys, offerUndo, backend, reload } = fakeContext(opened("waiting"));
    keys.find((k) => k.id === "core.release")!.run();
    await vi.waitFor(() => expect(offerUndo).toHaveBeenCalled());
    reload.mockClear();
    void offerUndo.mock.calls[0][1]();
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    expect(backend).toHaveBeenCalledWith("followup_resume", { id: expect.any(Number), ended: 1_800_000_000 });
  });

  it("lets the undo finish when the backend takes the wait back, and fails it when it cannot", async () => {
    const { keys, offerUndo, backend } = fakeContext(opened("waiting"));
    keys.find((k) => k.id === "core.release")!.run();
    await vi.waitFor(() => expect(offerUndo).toHaveBeenCalled());
    await expect(offerUndo.mock.calls[0][1]()).resolves.toBeUndefined();
    backend.mockImplementation(async (command: string) => (command === "followup_resume" ? false : undefined));
    await expect(offerUndo.mock.calls[0][1]()).rejects.toThrow();
  });

  it("says nothing when the wait had ended meanwhile", async () => {
    const { keys, toast, offerUndo, backend, reload } = fakeContext(opened("waiting"));
    backend.mockImplementation(async () => null);
    keys.find((k) => k.id === "core.release")!.run();
    await vi.waitFor(() => expect(backend).toHaveBeenCalledWith("followup_cancel", { id: expect.any(Number) }));
    await new Promise((r) => setTimeout(r, 20));
    expect(toast).not.toHaveBeenCalled();
    expect(offerUndo).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
  });

  it("says so, once, when many rows are stopped, and tells when an undo is too late", async () => {
    const { actions, toast, offerUndo, backend } = fakeContext(null);
    const item = actions.find((a) => a.id === "followups.stop")!;
    item.when?.([7, 8], [{ ...letter(wait()), id: 7, subject: "Один" }, { ...letter(wait()), id: 8, subject: "Два" }]);
    item.run?.([7, 8]);
    await vi.waitFor(() => expect(offerUndo).toHaveBeenCalled());
    expect(offerUndo).toHaveBeenCalledTimes(1);
    expect(offerUndo.mock.calls[0][0]).toBe("Не ждём ответа: 2 письма");
    backend.mockImplementation(async () => false);
    // Too late: the undo throws, so that the app tells it once as a failed undo (not «Undone», not twice).
    await expect(offerUndo.mock.calls[0][1]()).rejects.toThrow("Не удалось вернуть: ожидание уже изменилось");
    expect(toast).not.toHaveBeenCalled();
    // A backend error is passed on as it is, and told by the app, not by the plugin.
    backend.mockImplementation(async () => {
      throw new Error("нет связи");
    });
    await expect(offerUndo.mock.calls[0][1]()).rejects.toThrow("нет связи");
    expect(toast).not.toHaveBeenCalled();
  });
});
