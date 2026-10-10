import type { MessageRow } from "@depesha/plugin-api";
import { describe, expect, it } from "vitest";
import { letter, wait } from "./fixtures";
import { awaitable, stateOf, waitOf, whoOf } from "./wait";

describe("where a wait stands", () => {
  it("waiting, overdue past the deadline, answered or closed", () => {
    expect(stateOf(wait(), 499)).toBe("waiting");
    expect(stateOf(wait(), 500)).toBe("overdue");
    // A reminder before the deadline is not the deadline.
    expect(stateOf(wait({ due: 400, deadline: 900 }), 600)).toBe("waiting");
    expect(stateOf(wait({ status: "answered" }), 10_000)).toBe("answered");
    expect(stateOf(wait({ status: "closed" }), 10_000)).toBe("closed");
  });

  it("a letter waiting in the folder without a reminder has no deadline to miss", () => {
    expect(stateOf(wait({ due: 0, deadline: 0, park: "parked" }), 10_000_000)).toBe("waiting");
  });

  it("rows of an older backend have only the reminder's time", () => {
    const row = { ...letter(null), followup: undefined, followup_due: 700 } as unknown as MessageRow;
    expect(waitOf(row)).toMatchObject({ status: "waiting", due: 700, deadline: 700 });
    expect(waitOf(letter(null))).toBeNull();
  });

  it("an answer is awaited from a recipient of To or Cc, each once, by the name the letter gives", () => {
    const a = (email: string, name: string | null = null) => ({ name, email });
    expect(awaitable([a("Ivan@Example.org", "Иван"), a("boss@example.org")], [a("ivan@example.org"), a(" ")])).toEqual([
      a("ivan@example.org", "Иван"),
      a("boss@example.org"),
    ]);
    expect(whoOf(letter(null), "ivan@example.org")).toBe("Иван Петров");
    expect(whoOf(letter(null), "nobody@example.org")).toBe("nobody@example.org");
  });
});
