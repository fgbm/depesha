// The hints of #69 at work: what a detector counts, and where a hint is offered. The
// decisions of frame 16 are pure and tested in hints.test.ts; here the runtime is checked —
// a suggestion is a quiet line in a window, never a toast, and the send-format one waits
// for the next letter to that person instead of appearing right after sending.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./store.svelte", () => ({ app: { settings: { hints: true }, toast: () => {}, fail: () => {} } }));

import { hints } from "./hints.svelte";
import { peopleBook } from "./peopleBook.svelte";
import { blankPerson } from "./people";
import { api } from "./testing";
import type { ComposeDraft } from "./types";

const draft = (format: ComposeDraft["format"], email: string): ComposeDraft =>
  ({ format, to: [{ name: null, email }] }) as ComposeDraft;

beforeEach(() => {
  hints.states = [];
  hints.counters = {};
  hints.active = null;
  peopleBook.list = [];
  vi.clearAllMocks();
  api.hints.mockResolvedValue([]);
  api.hintCounts.mockResolvedValue([{ id: "send-format", subject: "ivan@x", n: 2, at: 1 }]);
  api.countHint.mockResolvedValue(2);
});

describe("where a hint is offered", () => {
  it("has no toast at all: every suggestion is a quiet line in a window", () => {
    expect((hints as unknown as Record<string, unknown>).toast).toBeUndefined();
  });

  it("offers the send-format hint as a line once its count is reached", () => {
    hints.counters = { "send-format": { "ivan@x": 2 } };
    const h = hints.sendFormatHint("ivan@x", "Иван");
    expect(h?.id).toBe("send-format");
    expect(h?.who).toBe("Иван");
    // Asking does not show it: the window puts it on its own line and counts the showing.
    expect(hints.active).toBeNull();
  });

  it("does not offer it before the count is reached", () => {
    hints.counters = { "send-format": { "ivan@x": 1 } };
    expect(hints.sendFormatHint("ivan@x", "Иван")).toBeNull();
  });
});

describe("the send-format detector", () => {
  it("counts a Markdown letter sent, and shows nothing after sending", async () => {
    await hints.recordSend(draft("markdown", "ivan@x"));
    expect(api.countHint).toHaveBeenCalledWith("send-format", "ivan@x", expect.any(Number));
    expect(hints.counters["send-format"]["ivan@x"]).toBe(2);
    // The suggestion waits for the next letter: nothing appears right after sending.
    expect(hints.active).toBeNull();
  });

  it("counts nothing for a letter not written in Markdown", async () => {
    await hints.recordSend(draft("html", "ivan@x"));
    expect(api.countHint).not.toHaveBeenCalled();
  });

  it("counts nothing for a person who already has a rule", async () => {
    peopleBook.list = [{ ...blankPerson("ivan@x"), send_format: "markdown" }];
    await hints.recordSend(draft("markdown", "ivan@x"));
    expect(api.countHint).not.toHaveBeenCalled();
  });
});
