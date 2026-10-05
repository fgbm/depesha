import { describe, expect, it } from "vitest";
import { after, secondsAfter } from "./due";

describe("reminder time", () => {
  // Friday, 2 October 2026, 15:30 local time.
  const friday = new Date(2026, 9, 2, 15, 30);

  it("counts working days over the weekend, at the same time of day", () => {
    const d = after(friday, 2, "workdays");
    expect([d.getDate(), d.getDay(), d.getHours(), d.getMinutes()]).toEqual([6, 2, 15, 30]);
    expect(after(friday, 1, "workdays").getDate()).toBe(5);
  });

  it("calendar days, hours and minutes as they are", () => {
    expect(after(friday, 2, "days").getDate()).toBe(4);
    expect(secondsAfter(friday, 90, "minutes")).toBe(5400);
    expect(secondsAfter(friday, 3, "hours")).toBe(10800);
  });
});
