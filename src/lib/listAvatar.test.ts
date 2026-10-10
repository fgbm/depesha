import { describe, expect, it } from "vitest";
import { mayAskLogo, rowAvatar } from "./listAvatar";
import type { Addr, MessageRow } from "./types";

const a = (email: string): Addr => ({ name: null, email });
const row = (over: Partial<MessageRow>): MessageRow =>
  ({ from: a("ozon@ozon.example"), to: [a("me@x"), a("kate@x")], id: 7, thread_voices: [], dmarc: false, ...over }) as unknown as MessageRow;
const mine = new Set(["me@x"]);

describe("where a logo may be asked for (#108)", () => {
  it("is nowhere in Spam and Trash", () => {
    expect(mayAskLogo("junk")).toBe(false);
    expect(mayAskLogo("trash")).toBe(false);
    for (const role of ["inbox", "sent", "archive", "drafts", null, undefined] as const) expect(mayAskLogo(role)).toBe(true);
  });
});

describe("whose picture a row wears (#108)", () => {
  it("is the sender's, with the verdict of the letter", () => {
    expect(rowAvatar(row({ dmarc: true }), false, mine)).toEqual({ addr: a("ozon@ozon.example"), brand: true, id: 7 });
    expect(rowAvatar(row({}), false, mine).brand).toBe(false);
  });

  it("is the first recipient in my own letters, and never a logo", () => {
    expect(rowAvatar(row({ dmarc: true }), true, mine)).toEqual({ addr: a("me@x"), brand: false, id: 7 });
    expect(rowAvatar(row({ to: [] }), true, mine).addr).toBeNull();
  });

  it("is the last writer who is not me in a conversation", () => {
    const voices = [
      { from: a("ivan@x"), dmarc: true, id: 11 },
      { from: a("me@x"), dmarc: false, id: 12 },
    ];
    expect(rowAvatar(row({ thread_voices: voices }), false, mine)).toEqual({ addr: a("ivan@x"), brand: true, id: 11 });
    const three = [{ from: a("ivan@x"), dmarc: false, id: 1 }, { from: a("kate@x"), dmarc: true, id: 2 }, { from: a("me@x"), dmarc: false, id: 3 }];
    expect(rowAvatar(row({ thread_voices: three }), false, mine).addr).toEqual(a("kate@x"));
  });

  it("falls back to the last writer when every writer is me, and compares addresses without case", () => {
    const own = [{ from: a("Me@X"), dmarc: false, id: 1 }, { from: a("me@x"), dmarc: false, id: 2 }];
    expect(rowAvatar(row({ thread_voices: own }), false, mine).addr).toEqual(a("me@x"));
    const mixed = [{ from: a("ivan@x"), dmarc: false, id: 1 }, { from: a("ME@x"), dmarc: false, id: 2 }];
    expect(rowAvatar(row({ thread_voices: mixed }), false, mine).addr).toEqual(a("ivan@x"));
  });

  it("uses the row's own sender when the list is not grouped", () => {
    expect(rowAvatar(row({ thread_voices: undefined }), false, mine).addr).toEqual(a("ozon@ozon.example"));
  });
});
