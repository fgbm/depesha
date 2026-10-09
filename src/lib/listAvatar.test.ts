import { describe, expect, it } from "vitest";
import { rowAvatar } from "./listAvatar";
import type { Addr, MessageRow } from "./types";

const a = (email: string): Addr => ({ name: null, email });
const row = (over: Partial<MessageRow>): MessageRow =>
  ({ from: a("ozon@ozon.example"), to: [a("me@x"), a("kate@x")], thread_voices: [], dmarc: false, ...over }) as unknown as MessageRow;
const mine = new Set(["me@x"]);

describe("whose picture a row wears (#108)", () => {
  it("is the sender's, with the verdict of the letter", () => {
    expect(rowAvatar(row({ dmarc: true }), false, mine)).toEqual({ addr: a("ozon@ozon.example"), brand: true });
    expect(rowAvatar(row({}), false, mine).brand).toBe(false);
  });

  it("is the first recipient in my own letters, and never a logo", () => {
    expect(rowAvatar(row({ dmarc: true }), true, mine)).toEqual({ addr: a("me@x"), brand: false });
    expect(rowAvatar(row({ to: [] }), true, mine).addr).toBeNull();
  });

  it("is the last writer who is not me in a conversation", () => {
    const voices = [
      { from: a("ivan@x"), dmarc: true },
      { from: a("me@x"), dmarc: false },
    ];
    expect(rowAvatar(row({ thread_voices: voices }), false, mine)).toEqual({ addr: a("ivan@x"), brand: true });
    const three = [{ from: a("ivan@x"), dmarc: false }, { from: a("kate@x"), dmarc: true }, { from: a("me@x"), dmarc: false }];
    expect(rowAvatar(row({ thread_voices: three }), false, mine).addr).toEqual(a("kate@x"));
  });

  it("falls back to the last writer when every writer is me, and compares addresses without case", () => {
    const own = [{ from: a("Me@X"), dmarc: false }, { from: a("me@x"), dmarc: false }];
    expect(rowAvatar(row({ thread_voices: own }), false, mine).addr).toEqual(a("me@x"));
    const mixed = [{ from: a("ivan@x"), dmarc: false }, { from: a("ME@x"), dmarc: false }];
    expect(rowAvatar(row({ thread_voices: mixed }), false, mine).addr).toEqual(a("ivan@x"));
  });

  it("uses the row's own sender when the list is not grouped", () => {
    expect(rowAvatar(row({ thread_voices: undefined }), false, mine).addr).toEqual(a("ozon@ozon.example"));
  });
});
