import { describe, expect, it, vi } from "vitest";
import type { KeyBinding, OpenedMessage, PluginContext, RowAction } from "@depesha/plugin-api";
import { letter, sayIn, wait } from "./fixtures";
import { registerStop } from "./stop";

/** A context that keeps the key and the menu item of the plugin; its backend takes every command. */
function fakeContext(opened: OpenedMessage | null) {
  const keys: KeyBinding[] = [];
  const actions: RowAction[] = [];
  const backend = vi.fn(async () => undefined);
  const reload = vi.fn();
  const say = sayIn("ru");
  const ctx = {
    ...say,
    backend,
    mail: { opened: () => opened, reload, viewing: () => false },
    ui: {
      keybinding: (b: KeyBinding) => keys.push(b),
      rowAction: (a: RowAction) => actions.push(a),
    },
  } as unknown as PluginContext;
  registerStop(ctx);
  return { keys, actions, backend, reload };
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
