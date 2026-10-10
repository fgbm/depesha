import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiController } from "./ui.svelte";

// The toast «Undo» of «Stop waiting» (#98) is the only way back while the letters are held in
// their folder for 12 s (`UNDO_SECS` in the store): it must be gone before they leave.
const UNDO_SECS = 12;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the life of a toast with an action", () => {
  it("is shorter than the time the stop's return is held back, and nothing prolongs it", () => {
    const ui = new UiController();
    ui.toast("Не ждём ответа", false, { label: "Отменить", run: () => {} });
    vi.advanceTimersByTime(UNDO_SECS * 1000 - 1);
    expect(ui.toasts).toHaveLength(0);
  });
});
