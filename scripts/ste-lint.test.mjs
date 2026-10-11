// STE-проверка текстов для агентов: словарь, маркеры разделов, длина предложения, синонимы и пустые слова.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bannedWords, defaultTargets, forbidden, lintFile, lintLines, parseGlossary, sentences, steRegionLines, stripCode, stripQuotes, synonymRegex, wordCount } from "./ste-lint.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");

const glossary = `
## курсор

- Определение: строка списка с фокусом.
- Синонимы (запрещены): «текущее письмо», «выделенное письмо».
- В коде: \`cursor\`.

## цепочка

- Синонимы (запрещены): «беседа», «тред».

## Не писать

Пустые слова. Ошибка, как у запрещённого синонима. Слово в кавычках, в коде и в блоке кода не проверяется.

- Канцелярит: «является», «осуществлять».
- Размытые указания: «следует», «желательно».
- Пустые вступления: «Знай:», «Помни:», «Важно:».
`;

const rules = { synonyms: forbidden(parseGlossary(glossary)), banned: bannedWords(glossary) };

describe("parseGlossary", () => {
  it("берёт термин и синонимы", () => {
    const terms = parseGlossary(glossary);
    expect(terms.map((t) => t.term)).toEqual(["курсор", "цепочка", "Не писать"]);
    expect(terms[0].synonyms).toEqual(["текущее письмо", "выделенное письмо"]);
    expect(terms[1].synonyms).toEqual(["беседа", "тред"]);
    expect(terms[2].synonyms).toEqual([]);
  });

  it("разворачивает синонимы с термином", () => {
    const flat = forbidden(parseGlossary(glossary));
    expect(flat).toContainEqual({ term: "курсор", synonym: "текущее письмо" });
    expect(flat).toHaveLength(4);
  });
});

describe("bannedWords", () => {
  it("берёт слова из раздела «Не писать»", () => {
    expect(bannedWords(glossary)).toEqual(["является", "осуществлять", "следует", "желательно", "Знай:", "Помни:", "Важно:"]);
  });

  it("не берёт слова вне раздела", () => {
    expect(bannedWords("## цепочка\n\n- Синонимы (запрещены): «беседа».\n")).toEqual([]);
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

describe("stripQuotes", () => {
  it("снимает текст в кавычках", () => {
    expect(stripQuotes("пишем «следует» тут")).toBe("пишем   тут");
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
  it("ругается на синоним", () => {
    const findings = lintLines(["смотри беседа"], [7], rules, "x.md");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 7, kind: "error" });
    expect(findings[0].message).toContain("беседа");
  });

  it("ругается на канцелярит", () => {
    const findings = lintLines(["это является делом"], [1], rules, "x.md");
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("является");
  });

  it("ругается на размытое указание", () => {
    const findings = lintLines(["следует сделать так"], [1], rules, "x.md");
    expect(findings[0].message).toContain("следует");
  });

  it("ругается на пустое вступление", () => {
    const findings = lintLines(["Помни: сделай так"], [1], rules, "x.md");
    expect(findings[0].message).toContain("Помни:");
  });

  it("не трогает пустое слово в кавычках", () => {
    expect(lintLines(["пишем «следует» в тексте"], [1], rules, "x.md")).toEqual([]);
  });

  it("предупреждает о длинном предложении", () => {
    const long = "слово ".repeat(26).trim() + ".";
    const findings = lintLines([long], [1], rules, "x.md");
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("warning");
  });

  it("молчит на коротком тексте без запретов", () => {
    expect(lintLines(["короткая строка"], [1], rules, "x.md")).toEqual([]);
  });
});

describe("lintFile", () => {
  it("в AGENTS.md смотрит только разделы ste", () => {
    const text = ["беседа снаружи", "<!-- ste -->", "тред внутри", "<!-- /ste -->"].join("\n");
    const findings = lintFile(text, rules, "AGENTS.md");
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(3);
  });

  it("другие файлы проверяет целиком", () => {
    const findings = lintFile("беседа и тред", rules, "docs/agents/coder-task.md");
    expect(findings).toHaveLength(2);
  });

  it("не трогает пустое слово во встроенном коде", () => {
    expect(lintFile("текст `Помни:` тут", rules, "x.md")).toEqual([]);
  });

  it("не трогает пустое слово в блоке кода", () => {
    expect(lintFile(["текст", "```", "Помни: внутри", "```"].join("\n"), rules, "x.md")).toEqual([]);
  });
});

describe("настоящие файлы репозитория", () => {
  it("AGENTS.md и docs/agents/*.md чисты по словарю", () => {
    const real = readFileSync(join(root, "docs", "glossary.md"), "utf8");
    const live = { synonyms: forbidden(parseGlossary(real)), banned: bannedWords(real) };
    const findings = defaultTargets(root).flatMap((path) => {
      const rel = path.startsWith(root) ? path.slice(root.length + 1) : path;
      return lintFile(readFileSync(path, "utf8"), live, rel);
    });
    expect(findings).toEqual([]);
  });
});
