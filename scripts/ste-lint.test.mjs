// STE-проверка текстов для агентов: словарь, маркеры разделов, длина предложения, синонимы.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultTargets, forbidden, lintFile, lintLines, parseGlossary, sentences, steRegionLines, stripCode, synonymRegex, wordCount } from "./ste-lint.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");

const glossary = `
## курсор

- Определение: строка списка с фокусом.
- Синонимы (запрещены): «текущее письмо», «выделенное письмо».
- В коде: \`cursor\`.

## цепочка

- Синонимы (запрещены): «беседа», «тред».
`;

describe("parseGlossary", () => {
  it("берёт термин и синонимы", () => {
    const terms = parseGlossary(glossary);
    expect(terms.map((t) => t.term)).toEqual(["курсор", "цепочка"]);
    expect(terms[0].synonyms).toEqual(["текущее письмо", "выделенное письмо"]);
    expect(terms[1].synonyms).toEqual(["беседа", "тред"]);
  });

  it("разворачивает синонимы с термином", () => {
    const flat = forbidden(parseGlossary(glossary));
    expect(flat).toContainEqual({ term: "курсор", synonym: "текущее письмо" });
    expect(flat).toHaveLength(4);
  });
});

describe("steRegionLines", () => {
  it("берёт только строки между маркерами", () => {
    const text = ["до", "<!-- ste -->", "внутри 1", "внутри 2", "<!-- /ste -->", "после"].join("\n");
    expect(steRegionLines(text)).toEqual([2, 3]);
  });

  it("понимает несколько разделов", () => {
    const text = ["<!-- ste -->", "a", "<!-- /ste -->", "b", "<!-- ste -->", "c", "<!-- /ste -->"].join("\n");
    expect(steRegionLines(text)).toEqual([1, 5]);
  });
});

describe("stripCode", () => {
  it("снимает встроенный код", () => {
    expect(stripCode("зовут `variant()` тут").lines[0]).toBe("зовут   тут");
  });

  it("пропускает блок кода", () => {
    const { lines, fenced } = stripCode(["текст", "```", "код внутри", "```", "ещё"].join("\n"));
    expect(fenced).toEqual([false, true, true, true, false]);
    expect(lines[2]).toBe("");
  });
});

describe("sentences и wordCount", () => {
  it("делит по концам предложений", () => {
    expect(sentences("Первое. Второе! Третье?")).toEqual(["Первое.", "Второе!", "Третье?"]);
  });

  it("не делит по точке в числе и после строчной", () => {
    expect(sentences("Версия 0.8.3 вышла")).toEqual(["Версия 0.8.3 вышла"]);
    expect(sentences("см. ниже")).toEqual(["см. ниже"]);
  });

  it("считает слова", () => {
    expect(wordCount("одно два, три!")).toBe(3);
  });
});

describe("synonymRegex", () => {
  it("ловит синоним по границам букв", () => {
    expect(synonymRegex("тред").test("тут тред и всё")).toBe(true);
    expect(synonymRegex("тред").test("тредовый")).toBe(false);
  });
});

describe("lintLines", () => {
  const syns = forbidden(parseGlossary(glossary));

  it("ругается на синоним", () => {
    const findings = lintLines(["смотри беседа"], [7], syns, "x.md");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 7, kind: "error" });
    expect(findings[0].message).toContain("беседа");
  });

  it("предупреждает о длинном предложении", () => {
    const long = "слово ".repeat(26).trim() + ".";
    const findings = lintLines([long], [1], [], "x.md");
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("warning");
  });

  it("молчит на коротком тексте без синонимов", () => {
    expect(lintLines(["короткая строка"], [1], syns, "x.md")).toEqual([]);
  });
});

describe("lintFile", () => {
  const syns = forbidden(parseGlossary(glossary));

  it("в AGENTS.md смотрит только разделы ste", () => {
    const text = ["беседа снаружи", "<!-- ste -->", "тред внутри", "<!-- /ste -->"].join("\n");
    const findings = lintFile(text, syns, "AGENTS.md");
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(3);
  });

  it("другие файлы проверяет целиком", () => {
    const findings = lintFile("беседа и тред", syns, "docs/agents/coder-task.md");
    expect(findings).toHaveLength(2);
  });
});

describe("настоящие файлы репозитория", () => {
  it("AGENTS.md и docs/agents/*.md чисты по словарю", () => {
    const syns = forbidden(parseGlossary(readFileSync(join(root, "docs", "glossary.md"), "utf8")));
    const findings = defaultTargets(root).flatMap((path) => {
      const rel = path.startsWith(root) ? path.slice(root.length + 1) : path;
      return lintFile(readFileSync(path, "utf8"), syns, rel);
    });
    expect(findings).toEqual([]);
  });
});
