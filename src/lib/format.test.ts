import { describe, expect, it } from "vitest";
import { initials } from "./format";

describe("the initials of an avatar", () => {
  it("takes two letters of the name", () => {
    expect(initials({ name: "Ольга Смирнова", email: "olga@example.org" })).toBe("ОС");
    expect(initials({ name: "Иван", email: "ivan@example.org" })).toBe("И");
  });

  it("skips the punctuation a name may be wrapped in", () => {
    // The quotes some programs wrap the whole name in are not letters.
    expect(initials({ name: '"Avalon через Booking.com"', email: "avalon@booking.com" })).toBe("AB");
    expect(initials({ name: "'FADIN Alexey'", email: "fadin@example.org" })).toBe("FA");
    expect(initials({ name: '"Рыжков, Дмитрий Евгеньевич"', email: "ryzhkov@example.org" })).toBe("РЕ");
  });

  it("takes a digit as an initial, and falls back to the address", () => {
    expect(initials({ name: "3-й цех", email: "shop@example.org" })).toBe("3Ц");
    // A name of signs alone is no name: the address's first letter stands in.
    expect(initials({ name: '"', email: "olga@example.org" })).toBe("O");
    expect(initials({ name: "", email: "olga@example.org" })).toBe("O");
    expect(initials(null)).toBe("?");
  });
});
