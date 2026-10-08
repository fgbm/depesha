// When a draft goes to the server (#71): not on every pause, but at most once a minute,
// and at once when the window closes or the user saves by hand. A crash can lose the
// last minute of typing — there is no local draft store to fall back on.
import { describe, expect, it } from "vitest";

import { SERVER_SAVE_MS, serverDue } from "./autosave.svelte";

describe("a draft on its way to the server", () => {
  it("is due once a minute, and at once when forced", () => {
    expect(SERVER_SAVE_MS).toBe(60_000);
    // Never saved yet: the first save goes.
    expect(serverDue(0, 1_000, false)).toBe(true);
    // Saved a moment ago: held back.
    expect(serverDue(1_000, 1_000 + SERVER_SAVE_MS - 1, false)).toBe(false);
    // The minute is up: it goes.
    expect(serverDue(1_000, 1_000 + SERVER_SAVE_MS, false)).toBe(true);
    // Closing the window or saving by hand: it goes at once.
    expect(serverDue(1_000, 1_000, true)).toBe(true);
  });
});
