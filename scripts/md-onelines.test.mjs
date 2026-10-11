// Проверка правила «одна строка на абзац и пункт списка»: что она ловит, что
// пропускает и как `--fix` склеивает продолжение.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { analyze, fix } from "./md-onelines.mjs";

const SCRIPT = fileURLToPath(new URL("./md-onelines.mjs", import.meta.url));
const doc = (...lines) => lines.join("\n");
const linesOf = (text) => analyze(text).violations.map((v) => v.line);

describe("analyze ловит нарушения", () => {
  it("перенос внутри абзаца", () => {
    expect(linesOf(doc("Первый абзац", "продолжение абзаца"))).toEqual([2]);
  });

  it("продолжение пункта списка с отступом", () => {
    expect(linesOf(doc("- пункт", "  продолжение пункта"))).toEqual([2]);
  });

  it("ленивое продолжение пункта без отступа", () => {
    expect(linesOf(doc("- пункт", "продолжение"))).toEqual([2]);
  });

  it("перенос внутри нумерованного пункта", () => {
    expect(linesOf(doc("1. пункт", "   ещё"))).toEqual([2]);
  });

  it("строка цитаты без > — продолжение", () => {
    expect(linesOf(doc("> цитата", "продолжение"))).toEqual([2]);
  });

  it("жёсткий перенос двумя пробелами в конце строки", () => {
    // Две строки нарушения: сама строка с пробелами и продолжение, которое к ней склеится.
    expect(linesOf(doc("Абзац  ", "с переносом"))).toEqual([1, 2]);
  });

  it("строка --- вне frontmatter", () => {
    expect(linesOf(doc("Абзац", "", "---", "", "Ещё абзац"))).toEqual([3]);
  });

  it("несколько продолжений подряд", () => {
    expect(linesOf(doc("Абзац", "раз", "два"))).toEqual([2, 3]);
  });
});

describe("analyze пропускает допустимое", () => {
  it("одна строка — один абзац", () => {
    expect(linesOf(doc("Абзац один.", "", "Абзац два."))).toEqual([]);
  });

  it("вложенный пункт — отдельный пункт", () => {
    expect(linesOf(doc("- пункт", "  - вложенный", "- второй"))).toEqual([]);
  });

  it("цитата, где у каждой строки свой >", () => {
    expect(linesOf(doc("> первая", "> вторая"))).toEqual([]);
  });

  it("заголовок и следующий за ним абзац — разные блоки", () => {
    expect(linesOf(doc("# Заголовок", "Абзац"))).toEqual([]);
  });

  it("список и следующий абзац через пустую строку", () => {
    expect(linesOf(doc("- пункт", "", "Абзац"))).toEqual([]);
  });

  it("блок кода с ``` — переносы внутри допустимы", () => {
    expect(linesOf(doc("Текст", "", "```js", "a", "b", "```"))).toEqual([]);
  });

  it("блок кода с ~~~ — переносы внутри допустимы", () => {
    expect(linesOf(doc("~~~", "a", "b", "~~~"))).toEqual([]);
  });

  it("таблица из нескольких строк", () => {
    expect(linesOf(doc("| a | b |", "| --- | --- |", "| c | d |"))).toEqual([]);
  });

  it("HTML-блок переносится по строкам", () => {
    expect(linesOf(doc("<!--", "строка", "-->", "", "Текст"))).toEqual([]);
  });

  it("однострочный комментарий не съедает следующий абзац", () => {
    // Комментарий кончается на `-->`; абзац после него проверяется как обычно.
    expect(linesOf(doc("<!-- note -->", "Абзац", "продолжение"))).toEqual([3]);
  });

  it("frontmatter с границами ---", () => {
    expect(linesOf(doc("---", "name: Задача", "about: текст", "---", "", "Текст"))).toEqual([]);
  });

  it("строка --- внутри блока кода — это содержимое", () => {
    expect(linesOf(doc("```", "---", "---", "```"))).toEqual([]);
  });

  it("одиночный пробел в конце строки — не жёсткий перенос", () => {
    expect(linesOf(doc("Абзац ", "", "Ещё"))).toEqual([]);
  });
});

describe("fix склеивает продолжение одним пробелом", () => {
  it("абзац", () => {
    expect(fix(doc("Абзац", "продолжение", "", "Второй"))).toBe(doc("Абзац продолжение", "", "Второй"));
  });

  it("пункт списка", () => {
    expect(fix(doc("- пункт", "  продолжение", "", "- второй"))).toBe(doc("- пункт продолжение", "", "- второй"));
  });

  it("жёсткий перенос", () => {
    expect(fix(doc("Абзац  ", "с переносом"))).toBe("Абзац с переносом");
  });

  it("блок кода не трогает", () => {
    const text = doc("Текст", "", "```js", "a", "b", "```");
    expect(fix(text)).toBe(text);
  });

  it("вложенные пункты и таблицу не трогает", () => {
    const text = doc("- пункт", "  - вложенный", "", "| a | b |", "| --- | --- |");
    expect(fix(text)).toBe(text);
  });

  it("несколько продолжений подряд", () => {
    expect(fix(doc("Абзац", "раз", "два"))).toBe("Абзац раз два");
  });

  it("сохраняет завершающий перевод строки", () => {
    expect(fix(doc("Абзац", "продолжение") + "\n")).toBe("Абзац продолжение\n");
  });
});

describe("запуск из командной строки", () => {
  const dir = mkdtempSync(join(tmpdir(), "md-onelines-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("печатает файл:строка и выходит с кодом 1", () => {
    const file = join(dir, "bad.md");
    writeFileSync(file, doc("Абзац", "продолжение"));
    const run = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stdout.trim()).toBe(`${file}:2`);
  });

  it("чистый файл — код 0 и пустой вывод", () => {
    const file = join(dir, "good.md");
    writeFileSync(file, doc("Абзац один.", "", "Абзац два."));
    const run = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  it("--fix переписывает файл", () => {
    const file = join(dir, "fix.md");
    writeFileSync(file, doc("- пункт", "  продолжение"));
    const run = spawnSync(process.execPath, [SCRIPT, "--fix", file], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("- пункт продолжение");
  });

  it("--stdin проверяет документ из потока", () => {
    const run = spawnSync(process.execPath, [SCRIPT, "--stdin", "--name", "x.md"], {
      input: doc("Абзац", "продолжение"),
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stdout.trim()).toBe("x.md:2");
  });
});
