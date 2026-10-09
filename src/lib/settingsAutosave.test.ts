import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsAutosave, type AutosaveHost } from "./settingsAutosave.svelte";

/** A host that keeps the settings in memory, as the store does, and records the toasts. */
function fixture(initial: Record<string, unknown>) {
  const state = { settings: { ...initial }, toasts: [] as { id: number; text: string; action?: { label: string; run: () => void } }[], dismissed: [] as number[], patches: [] as Record<string, unknown>[] };
  let seq = 0;
  const host: AutosaveHost = {
    settings: () => state.settings,
    patch: async (patch) => {
      state.patches.push(patch);
      state.settings = { ...state.settings, ...patch };
    },
    toast: (text, action) => {
      const id = ++seq;
      state.toasts.push({ id, text, action });
      return id;
    },
    dismiss: (id) => state.dismissed.push(id),
  };
  return { state, auto: new SettingsAutosave(host) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("saving a setting at once (#102, 1.7 Б)", () => {
  it("writes only the keys that changed, marks the row «saved» and offers to undo", async () => {
    const { state, auto } = fixture({ threads: true, theme: "paper" });
    await auto.commit("threads", { threads: false }, "Собирать переписку: вкл → выкл");
    expect(state.patches).toEqual([{ threads: false }]);
    expect(auto.marks.threads).toBe("saved");
    expect(state.toasts[0].text).toBe("Собирать переписку: вкл → выкл");
    expect(state.toasts[0].action?.label).toBeTruthy();
  });

  it("does nothing, and says nothing, when the value is the same", async () => {
    const { state, auto } = fixture({ threads: true });
    await auto.commit("threads", { threads: true }, "x");
    expect(state.patches).toEqual([]);
    expect(state.toasts).toEqual([]);
    expect(auto.marks.threads).toBeUndefined();
  });

  it("clears the mark after a moment", async () => {
    const { auto } = fixture({ threads: true });
    await auto.commit("threads", { threads: false }, "x");
    vi.advanceTimersByTime(2300);
    expect(auto.marks.threads).toBeUndefined();
  });

  it("compares lists and objects by value", async () => {
    const { state, auto } = fixture({ work_days: [1, 2, 3] });
    await auto.commit("work_days", { work_days: [1, 2, 3] }, "x");
    expect(state.patches).toEqual([]);
    await auto.commit("work_days", { work_days: [1, 2] }, "x");
    expect(state.patches).toEqual([{ work_days: [1, 2] }]);
  });

  it("keeps one toast: the new change takes the place of the old", async () => {
    const { state, auto } = fixture({ a: 1, b: 1 });
    await auto.commit("a", { a: 2 }, "a");
    await auto.commit("b", { b: 2 }, "b");
    expect(state.dismissed).toEqual([1]);
  });
});

describe("a write the backend refuses", () => {
  it("is not said to be saved and is not offered to be taken back", async () => {
    const { state, auto } = fixture({ attachments_dir: "" });
    // The store reads the settings again after a refusal: the window shows what is saved.
    const host: AutosaveHost = {
      settings: () => state.settings,
      patch: async () => {},
      toast: (text) => state.toasts.push({ id: 9, text }),
      dismiss: () => {},
    };
    const refused = new SettingsAutosave(host);
    expect(await refused.commit("attachments_dir", { attachments_dir: "/etc" }, "x")).toBe(false);
    expect(refused.marks.attachments_dir).toBeUndefined();
    expect(refused.canUndo).toBe(false);
    expect(state.toasts).toEqual([]);
    expect(auto.canUndo).toBe(false);
  });
});

describe("taking the last change back", () => {
  it("restores what the keys were, marks the row and tells so", async () => {
    const { state, auto } = fixture({ threads: true });
    await auto.commit("threads", { threads: false }, "x", "Цепочки");
    expect(await auto.undo()).toBe(true);
    expect(state.settings.threads).toBe(true);
    expect(auto.marks.threads).toBe("undone");
    expect(state.toasts.at(-1)?.text).toContain("Цепочки");
    expect(state.toasts.at(-1)?.action).toBeUndefined();
  });

  it("goes back one change at a time, newest first", async () => {
    const { state, auto } = fixture({ a: 1, b: 1 });
    await auto.commit("a", { a: 2 }, "a");
    await auto.commit("b", { b: 2 }, "b");
    await auto.undo();
    expect(state.settings).toMatchObject({ a: 2, b: 1 });
    await auto.undo();
    expect(state.settings).toMatchObject({ a: 1, b: 1 });
    expect(await auto.undo()).toBe(false);
  });

  it("restores every key of a change that wrote several (a theme and what goes with it)", async () => {
    const { state, auto } = fixture({ close_action: "ask", background_without_tray: false });
    await auto.commit("close_action", { close_action: "background", background_without_tray: true }, "x");
    await auto.undo();
    expect(state.settings).toMatchObject({ close_action: "ask", background_without_tray: false });
  });

  it("is what the toast's button does", async () => {
    const { state, auto } = fixture({ threads: true });
    await auto.commit("threads", { threads: false }, "x");
    state.toasts[0].action?.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.settings.threads).toBe(true);
  });

  it("is not itself something to undo", async () => {
    const { auto } = fixture({ threads: true });
    await auto.commit("threads", { threads: false }, "x");
    await auto.undo();
    expect(await auto.undo()).toBe(false);
  });
});
