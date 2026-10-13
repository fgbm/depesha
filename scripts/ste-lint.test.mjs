// STE-проверка текстов для агентов: словарь, маркеры разделов, длина предложения, синонимы и пустые слова.
// Запуск: node --test scripts/ste-lint.test.mjs (в CI и в scripts/check.sh).

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { bannedWords, defaultTargets, forbidden, lintFile, lintLines, parseGlossary, sentences, steRegionLines, stripCode, stripQuotes, synonymRegex, valeOffLines, wordCount } from "./ste-lint.mjs";

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
    assert.deepEqual(terms.map((t) => t.term), ["курсор", "цепочка", "Не писать"]);
    assert.deepEqual(terms[0].synonyms, ["текущее письмо", "выделенное письмо"]);
    assert.deepEqual(terms[1].synonyms, ["беседа", "тред"]);
    assert.deepEqual(terms[2].synonyms, []);
  });

  it("разворачивает синонимы с термином", () => {
    const flat = forbidden(parseGlossary(glossary));
    assert.ok(flat.some((x) => x.term === "курсор" && x.synonym === "текущее письмо"));
    assert.equal(flat.length, 4);
  });
});

describe("bannedWords", () => {
  it("берёт слова из раздела «Не писать»", () => {
    assert.deepEqual(bannedWords(glossary), ["является", "осуществлять", "следует", "желательно", "Знай:", "Помни:", "Важно:"]);
  });

  it("не берёт слова вне раздела", () => {
    assert.deepEqual(bannedWords("## цепочка\n\n- Синонимы (запрещены): «беседа».\n"), []);
  });
});

describe("steRegionLines", () => {
  it("берёт только строки между маркерами", () => {
    const text = ["до", "<!-- ste -->", "внутри 1", "внутри 2", "<!-- /ste -->", "после"].join("\n");
    assert.deepEqual(steRegionLines(text), [2, 3]);
  });

  it("понимает несколько разделов", () => {
    const text = ["<!-- ste -->", "a", "<!-- /ste -->", "b", "<!-- ste -->", "c", "<!-- /ste -->"].join("\n");
    assert.deepEqual(steRegionLines(text), [1, 5]);
  });
});

describe("valeOffLines", () => {
  it("берёт строки между маркерами", () => {
    const text = ["до", "<!-- vale off -->", "внутри", "<!-- vale on -->", "после"].join("\n");
    assert.deepEqual([...valeOffLines(text)].sort((a, b) => a - b), [2]);
  });

  it("понимает несколько участков", () => {
    const text = ["a", "<!-- vale off -->", "b", "<!-- vale on -->", "c", "<!-- vale off -->", "d", "<!-- vale on -->"].join("\n");
    assert.deepEqual([...valeOffLines(text)].sort((a, b) => a - b), [2, 6]);
  });
});

describe("stripCode", () => {
  it("снимает встроенный код", () => {
    assert.equal(stripCode("зовут `variant()` тут").lines[0], "зовут   тут");
  });

  it("пропускает блок кода", () => {
    const { lines, fenced } = stripCode(["текст", "```", "код внутри", "```", "ещё"].join("\n"));
    assert.deepEqual(fenced, [false, true, true, true, false]);
    assert.equal(lines[2], "");
  });
});

describe("stripQuotes", () => {
  it("снимает текст в кавычках", () => {
    assert.equal(stripQuotes("пишем «следует» тут"), "пишем   тут");
  });
});

describe("sentences и wordCount", () => {
  it("делит по концам предложений", () => {
    assert.deepEqual(sentences("Первое. Второе! Третье?"), ["Первое.", "Второе!", "Третье?"]);
  });

  it("не делит по точке в числе и после строчной", () => {
    assert.deepEqual(sentences("Версия 0.8.3 вышла"), ["Версия 0.8.3 вышла"]);
    assert.deepEqual(sentences("см. ниже"), ["см. ниже"]);
  });

  it("считает слова", () => {
    assert.equal(wordCount("одно два, три!"), 3);
  });
});

describe("synonymRegex", () => {
  it("ловит синоним по границам букв", () => {
    assert.equal(synonymRegex("тред").test("тут тред и всё"), true);
    assert.equal(synonymRegex("тред").test("тредовый"), false);
  });
});

describe("lintLines", () => {
  it("ругается на синоним", () => {
    const findings = lintLines(["смотри беседа"], [7], rules, "x.md");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 7);
    assert.equal(findings[0].kind, "error");
    assert.ok(findings[0].message.includes("беседа"));
  });

  it("ругается на канцелярит", () => {
    const findings = lintLines(["это является делом"], [1], rules, "x.md");
    assert.equal(findings.length, 1);
    assert.ok(findings[0].message.includes("является"));
  });

  it("ругается на размытое указание", () => {
    const findings = lintLines(["следует сделать так"], [1], rules, "x.md");
    assert.ok(findings[0].message.includes("следует"));
  });

  it("ругается на пустое вступление", () => {
    const findings = lintLines(["Помни: сделай так"], [1], rules, "x.md");
    assert.ok(findings[0].message.includes("Помни:"));
  });

  it("не трогает пустое слово в кавычках", () => {
    assert.deepEqual(lintLines(["пишем «следует» в тексте"], [1], rules, "x.md"), []);
  });

  it("предупреждает о длинном предложении", () => {
    const long = "слово ".repeat(26).trim() + ".";
    const findings = lintLines([long], [1], rules, "x.md");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "warning");
  });

  it("молчит на коротком тексте без запретов", () => {
    assert.deepEqual(lintLines(["короткая строка"], [1], rules, "x.md"), []);
  });
});

describe("lintFile", () => {
  it("в AGENTS.md смотрит только разделы ste", () => {
    const text = ["беседа снаружи", "<!-- ste -->", "тред внутри", "<!-- /ste -->"].join("\n");
    const findings = lintFile(text, rules, "AGENTS.md");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 3);
  });

  it("другие файлы проверяет целиком", () => {
    const findings = lintFile("беседа и тред", rules, "docs/agents/coder-task.md");
    assert.equal(findings.length, 2);
  });

  it("не трогает пустое слово во встроенном коде", () => {
    assert.deepEqual(lintFile("текст `Помни:` тут", rules, "x.md"), []);
  });

  it("не трогает пустое слово в блоке кода", () => {
    assert.deepEqual(lintFile(["текст", "```", "Помни: внутри", "```"].join("\n"), rules, "x.md"), []);
  });

  it("пропускает участок между vale off и vale on", () => {
    const text = ["беседа снаружи", "<!-- vale off -->", "тред внутри", "<!-- vale on -->", "тред снаружи"].join("\n");
    const findings = lintFile(text, rules, "x.md");
    assert.deepEqual(findings.map((f) => f.line), [1, 5]);
  });
});

describe("настоящие файлы репозитория", () => {
  it("AGENTS.md и docs/agents/*.md чисты по словарю", () => {
    const real = readFileSync(join(root, "docs", "glossary.md"), "utf8");
    const live = { synonyms: forbidden(parseGlossary(real)), banned: bannedWords(real) };
    const agentDir = join(root, "docs", "agents");
    const targets = [join(root, "AGENTS.md"), ...readdirSync(agentDir).filter((n) => n.endsWith(".md")).map((n) => join(agentDir, n))];
    const findings = targets.flatMap((path) => {
      const rel = path.startsWith(root) ? path.slice(root.length + 1) : path;
      return lintFile(readFileSync(path, "utf8"), live, rel);
    });
    assert.deepEqual(findings, []);
  });

  it("по умолчанию берёт русские документы из охвата", () => {
    const targets = defaultTargets(root).map((p) => p.slice(root.length + 1));
    assert.ok(targets.includes("README.md"));
    assert.ok(targets.includes("docs/style/ru-technical.md"));
    assert.ok(targets.includes("design/references/yandex-mail.md"));
    assert.ok(targets.includes("e2e/README.md"));
    assert.ok(!targets.includes("docs/style/ste-en.md"));
    assert.ok(!targets.includes("docs/releases/0.8.3.md"));
  });
});
