import { describe, expect, it } from "vitest";
import { choiceMode, dependentRuns, moveCursor, parseWhole, rowKeyAction, stepChoice, stepClock, stepWhole } from "./settingsRows";

describe("the rule for «choose one of several» (#102, 1.1 А)", () => {
  it("draws up to three short options as segments", () => {
    expect(choiceMode(["Как в системе", "English", "Русский"])).toBe("seg");
    expect(choiceMode(["Обычный текст", "HTML", "Markdown"])).toBe("seg");
    expect(choiceMode(["Вкл", "Выкл"])).toBe("seg");
  });

  it("draws three options longer than forty letters in all as a list", () => {
    expect(choiceMode(["Не запускать", "Запускать с окном", "Запускать в фоне"])).toBe("drop");
  });

  it("draws more than three options as a list however short they are", () => {
    expect(choiceMode(["а", "б", "в", "г"])).toBe("drop");
  });

  it("counts letters, not bytes", () => {
    // 3 × 13 letters = 39: still segments, though far more than 40 bytes in UTF-8.
    expect(choiceMode(["Тринадцать бук", "Тринадцать бук", "Тринадцать бук"].map((s) => s.slice(0, 13)))).toBe("seg");
  });
});

describe("a typed whole number", () => {
  const spec = { min: 200, max: 8000, step: 100 };

  it("takes a number within the limits", () => {
    expect(parseWhole("1600", spec)).toBe(1600);
    expect(parseWhole(" 200 ", spec)).toBe(200);
  });

  it("refuses what is out of the limits, not a whole number or empty", () => {
    expect(parseWhole("99999", spec)).toBeNull();
    expect(parseWhole("199", spec)).toBeNull();
    expect(parseWhole("16.5", spec)).toBeNull();
    expect(parseWhole("1e3", spec)).toBeNull();
    expect(parseWhole("-5", spec)).toBeNull();
    expect(parseWhole("", spec)).toBeNull();
  });

  it("steps by the spec's step, ten of them with Shift, and stops at the limits", () => {
    expect(stepWhole(1600, 1, spec)).toBe(1700);
    expect(stepWhole(1600, -1, spec, true)).toBe(600);
    expect(stepWhole(7950, 1, spec)).toBe(8000);
    expect(stepWhole(250, -1, spec)).toBe(200);
  });
});

describe("a time of day", () => {
  it("steps by a quarter of an hour and goes round the clock", () => {
    expect(stepClock("9:00", 1)).toBe("9:15");
    expect(stepClock("9:00", -1)).toBe("8:45");
    expect(stepClock("23:50", 1)).toBe("0:05");
    expect(stepClock("0:00", -1)).toBe("23:45");
  });

  it("gives nothing for a text that is not a time", () => {
    expect(stepClock("25:99", 1)).toBeNull();
  });
});

describe("stepping through the options", () => {
  it("holds at the ends", () => {
    expect(stepChoice(["a", "b", "c"], "a", -1)).toBe("a");
    expect(stepChoice(["a", "b", "c"], "c", 1)).toBe("c");
    expect(stepChoice(["a", "b", "c"], "b", 1)).toBe("c");
  });

  it("starts from the first when the value is not among them", () => {
    expect(stepChoice(["a", "b"], "z", 1)).toBe("b");
  });
});

describe("the keys on a row (#102, 4.1, 4.2)", () => {
  it("walks the rows with the arrows, Home and End", () => {
    expect(rowKeyAction("toggle", { key: "ArrowDown" })).toEqual({ type: "move", to: "next" });
    expect(rowKeyAction("choice", { key: "ArrowUp" })).toEqual({ type: "move", to: "prev" });
    expect(rowKeyAction("number", { key: "Home" })).toEqual({ type: "move", to: "first" });
    expect(rowKeyAction("number", { key: "End" })).toEqual({ type: "move", to: "last" });
  });

  it("changes the value with ← and →", () => {
    expect(rowKeyAction("choice", { key: "ArrowRight" })).toEqual({ type: "step", dir: 1, big: false });
    expect(rowKeyAction("number", { key: "ArrowLeft", shiftKey: true })).toEqual({ type: "step", dir: -1, big: true });
    expect(rowKeyAction("toggle", { key: "ArrowRight" })).toEqual({ type: "set", on: true });
    expect(rowKeyAction("toggle", { key: "ArrowLeft" })).toEqual({ type: "set", on: false });
  });

  it("opens or enters a value with Enter, and flips a switch with Enter or Space", () => {
    expect(rowKeyAction("choice", { key: "Enter" })).toEqual({ type: "enter" });
    expect(rowKeyAction("number", { key: "Enter" })).toEqual({ type: "enter" });
    expect(rowKeyAction("folder", { key: "Enter" })).toEqual({ type: "enter" });
    expect(rowKeyAction("toggle", { key: "Enter" })).toEqual({ type: "toggle" });
    expect(rowKeyAction("toggle", { key: " " })).toEqual({ type: "toggle" });
    expect(rowKeyAction("action", { key: " " })).toEqual({ type: "enter" });
  });

  it("follows a link with → and clears a folder with Delete", () => {
    expect(rowKeyAction("link", { key: "ArrowRight" })).toEqual({ type: "enter" });
    expect(rowKeyAction("link", { key: "ArrowLeft" })).toBeNull();
    expect(rowKeyAction("folder", { key: "Delete" })).toEqual({ type: "clear" });
    expect(rowKeyAction("number", { key: "Delete" })).toBeNull();
  });

  it("switches a weekday with its number", () => {
    expect(rowKeyAction("days", { key: "3" })).toEqual({ type: "day", n: 3 });
    expect(rowKeyAction("days", { key: "8" })).toBeNull();
    expect(rowKeyAction("number", { key: "3" })).toBeNull();
  });

  it("leaves the keys of the window alone: Alt+←, Ctrl+PgDn, Ctrl+Z", () => {
    expect(rowKeyAction("choice", { key: "ArrowLeft", altKey: true })).toBeNull();
    expect(rowKeyAction("choice", { key: "PageDown", ctrlKey: true })).toBeNull();
    expect(rowKeyAction("toggle", { key: "z", ctrlKey: true })).toBeNull();
  });
});

describe("the cursor over the rows", () => {
  it("stops at the ends", () => {
    expect(moveCursor(5, 0, "prev")).toBe(0);
    expect(moveCursor(5, 4, "next")).toBe(4);
    expect(moveCursor(5, 2, "next")).toBe(3);
    expect(moveCursor(5, 2, "first")).toBe(0);
    expect(moveCursor(5, 2, "last")).toBe(4);
  });

  it("has nowhere to go on an empty page", () => {
    expect(moveCursor(0, 0, "next")).toBe(-1);
  });
});

describe("rows that depend on a switch (#102, the strip at the left)", () => {
  const r = (id: string, dep = false) => ({ id, dep });

  it("gathers the rows that follow one another into a single run", () => {
    const out = dependentRuns([r("warn"), r("levels", true), r("repeat", true), r("own", true), r("other")]);
    expect(out.map((x) => (x.run ? x.rows.map((y) => y.id) : x.row.id))).toEqual(["warn", ["levels", "repeat", "own"], "other"]);
  });

  it("makes a new run after a row that does not depend", () => {
    const out = dependentRuns([r("a"), r("b", true), r("c"), r("d", true)]);
    expect(out.filter((x) => x.run)).toHaveLength(2);
  });

  it("leaves a page with no dependent rows as it is", () => {
    expect(dependentRuns([r("a"), r("b")]).every((x) => !x.run)).toBe(true);
    expect(dependentRuns([])).toEqual([]);
  });
});
