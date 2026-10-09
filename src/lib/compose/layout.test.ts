import { describe, expect, it } from "vitest";
import { MIN_BODY_PX, mailboxName, visibleChips } from "./layout";

describe("the one-line strip of attachments (#103, 2.1 А)", () => {
  it("shows nothing without files", () => {
    expect(visibleChips(640, 0)).toBe(0);
  });

  it("shows all files that fit and hides the rest behind «+N»", () => {
    expect(visibleChips(900, 2)).toBe(2);
    expect(visibleChips(640, 8)).toBeLessThan(8);
    expect(visibleChips(640, 8)).toBeGreaterThanOrEqual(2);
  });

  it("keeps at least one file in sight, however narrow the window", () => {
    expect(visibleChips(200, 5)).toBe(1);
  });

  it("never shows more than there are", () => {
    expect(visibleChips(2000, 3)).toBe(3);
  });
});

describe("the text of the letter (#103, 2.2 Б)", () => {
  it("is guaranteed 160 px", () => {
    expect(MIN_BODY_PX).toBe(160);
  });
});

describe("the mailbox in the title (#103, 1.1 Б)", () => {
  it("goes by its label", () => {
    expect(mailboxName({ label: " Работа ", email: "anna@example.com" })).toBe("Работа");
  });

  it("goes by the part of the address before «@» without one", () => {
    expect(mailboxName({ label: "", email: "anna@example.com" })).toBe("anna");
    expect(mailboxName({ email: "anna@example.com" })).toBe("anna");
  });
});
