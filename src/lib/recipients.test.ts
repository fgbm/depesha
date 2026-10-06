import { describe, expect, it } from "vitest";
import { FOLD_OVER, FOLD_SHOW, foldLine, foldsRecipients } from "./recipients";
import type { Addr } from "./types";

const people = (n: number, at = "example.com"): Addr[] =>
  Array.from({ length: n }, (_, i) => ({ name: `Person ${i + 1}`, email: `p${i + 1}@${at}` }));

describe("recipients in the header", () => {
  it("fold past the threshold of To and Cc together", () => {
    expect(foldsRecipients(people(FOLD_OVER), [])).toBe(false);
    expect(foldsRecipients(people(FOLD_OVER - 2), people(2))).toBe(false);
    expect(foldsRecipients(people(15), people(5))).toBe(true);
    expect(foldsRecipients(people(1), people(FOLD_OVER))).toBe(true);
  });

  it("a folded line names the first few and counts the rest", () => {
    const to = people(15);
    const { shown, more } = foldLine(to);
    expect(shown).toEqual(to.slice(0, FOLD_SHOW));
    expect(more).toBe(15 - FOLD_SHOW);
    expect(shown.length + more).toBe(to.length);
  });

  it("a short line of a folded header leaves nothing out", () => {
    const cc = people(2, "example.org");
    expect(foldLine(cc)).toEqual({ shown: cc, more: 0 });
  });
});
