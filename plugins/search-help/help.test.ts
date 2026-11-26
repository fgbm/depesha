import { describe, expect, it } from "vitest";
import { EXAMPLES, filterExamples, filterOperators, operatorText } from "./help";

describe("the search help", () => {
  it("writes an operator the way the language spells it", () => {
    const larger = filterOperators("больше", "ru")[0];
    expect(operatorText(larger, "ru")).toBe("больше:25М");
    const larger_en = filterOperators("larger", "en")[0];
    expect(operatorText(larger_en, "en")).toBe("larger:25M");
  });

  it("finds an operator by its Russian word, English word or explanation", () => {
    expect(filterOperators("влож", "ru").map((o) => o.id)).toEqual(["attachment"]);
    expect(filterOperators("attachment", "ru").map((o) => o.id)).toEqual(["attachment"]);
    expect(filterOperators("дата", "ru").map((o) => o.id)).toEqual([]);
    expect(filterOperators("больше", "ru").length).toBe(1);
  });

  it("keeps every example when nothing is typed and narrows by its words", () => {
    expect(filterExamples("", "ru")).toEqual(EXAMPLES);
    expect(filterExamples("счёт", "ru").map((e) => e.id)).toEqual(["invoices"]);
    expect(filterExamples("older:", "en").map((e) => e.id)).toEqual(["old-large"]);
  });

  it("shows every operator for an empty query", () => {
    expect(filterOperators("", "ru").length).toBeGreaterThan(10);
  });
});
