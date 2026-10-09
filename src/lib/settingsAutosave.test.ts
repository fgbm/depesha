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
    expect(refused.canUndo()).toBe(false);
    expect(state.toasts).toEqual([]);
    expect(auto.canUndo()).toBe(false);
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

describe("writes that overlap", () => {
  /** A store that shows the change at once, as the real one does, and answers the backend a while later. */
  function slow() {
    const state = { settings: { k: 1 } as Record<string, unknown>, toasts: [] as string[] };
    const host: AutosaveHost = {
      settings: () => state.settings,
      patch: async (patch) => {
        state.settings = { ...state.settings, ...patch };
        await new Promise((r) => setTimeout(r, 50));
      },
      toast: (text) => state.toasts.push(text),
      dismiss: () => {},
    };
    return { state, auto: new SettingsAutosave(host) };
  }

  it("keep each its own entry: taking back goes to the value before the last one", async () => {
    const { state, auto } = slow();
    const a = auto.commit("k", { k: 2 }, "a");
    const b = auto.commit("k", { k: 3 }, "b");
    await vi.advanceTimersByTimeAsync(100);
    expect(await Promise.all([a, b])).toEqual([true, true]);
    const back = auto.undo();
    await vi.advanceTimersByTimeAsync(100);
    await back;
    expect(state.settings.k).toBe(2);
  });

  it("let a page that turns wait for them", async () => {
    const { state, auto } = slow();
    void auto.commit("k", { k: 2 }, "a");
    let done = false;
    void auto.settled().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(true);
    expect(state.settings.k).toBe(2);
  });
});

describe("taking back by page", () => {
  it("takes back only the changes of the page asked for", async () => {
    const { state, auto } = fixture({ a: 1, b: 1 });
    await auto.forPage("reading").commit("a", { a: 2 }, "a");
    await auto.forPage("writing").commit("b", { b: 2 }, "b");
    expect(auto.canUndo("reading")).toBe(true);
    expect(await auto.undo("reading")).toBe(true);
    expect(state.settings).toMatchObject({ a: 1, b: 2 });
    expect(await auto.undo("reading")).toBe(false);
    expect(auto.canUndo("writing")).toBe(true);
  });

  it("keeps the change in the stack when taking it back did not go through", async () => {
    const state = { settings: { a: 1 } as Record<string, unknown> };
    let refuse = false;
    const auto = new SettingsAutosave({
      settings: () => state.settings,
      patch: async (patch) => {
        if (!refuse) state.settings = { ...state.settings, ...patch };
      },
      toast: () => 0,
      dismiss: () => {},
    });
    await auto.commit("a", { a: 2 }, "a");
    refuse = true;
    expect(await auto.undo()).toBe(false);
    expect(auto.canUndo()).toBe(true);
    refuse = false;
    expect(await auto.undo()).toBe(true);
    expect(state.settings.a).toBe(1);
  });
});
