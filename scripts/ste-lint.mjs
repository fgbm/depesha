// STE-проверка текстов для агентов: правила письма из пилота 2026-10-12.
//
//   node scripts/ste-lint.mjs                 русские документы из охвата styles/DepeshaRU (mirror .vale.ini)
//   node scripts/ste-lint.mjs <файл> …        явные файлы (AGENTS.md по маркерам, остальное целиком)
//
// Предупреждение — предложение длиннее 25 слов. Ошибка — запрещённый синоним из `docs/glossary.md`
// (строка «Синонимы (запрещены):» под заголовком термина) или пустое слово из раздела «Не писать».
// Код и блоки кода не проверяются; пустое слово в кавычках «…» тоже не проверяется.
// Участки между `<!-- vale off -->` и `<!-- vale on -->` пропускаются.
// Код возврата — 1, если есть ошибки; предупреждения не роняют проверку.

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const AGENTS = "AGENTS.md";
const GLOSSARY = join("docs", "glossary.md");
const MAX_WORDS = 25;

/** Словарь терминов: `[{term, synonyms}]` из строк «Синонимы (запрещены):». */
export function parseGlossary(text) {
  const terms = [];
  let current = null;
  for (const line of text.split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = { term: heading[1], synonyms: [] };
      terms.push(current);
      continue;
    }
    const m = line.match(/Синонимы \(запрещены\)\s*:\s*(.*)$/);
    if (m && current) {
      for (const syn of m[1].matchAll(/[«"`]([^«»"`]+)[»"`]/g)) {
        const s = syn[1].trim();
        if (s) current.synonyms.push(s);
      }
    }
  }
  return terms;
}

/** Плоский список запрещённых синонимов с их терминами. */
export function forbidden(terms) {
  return terms.flatMap((t) => t.synonyms.map((synonym) => ({ term: t.term, synonym })));
}

/** Пустые слова из раздела «Не писать»: кавычки «…» в пунктах списка. */
export function bannedWords(text) {
  const out = [];
  let inSection = false;
  for (const line of text.split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      inSection = heading[1].trim() === "Не писать";
      continue;
    }
    if (!inSection || !/^\s*[-*+]\s/.test(line)) continue;
    for (const m of line.matchAll(/«([^»]+)»/g)) {
      const s = m[1].trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/** Номера строк (0-based) между `<!-- ste -->` и `<!-- /ste -->`; сами маркеры не входят. */
export function steRegionLines(text) {
  const inside = [];
  let open = false;
  text.split("\n").forEach((line, i) => {
    if (line.includes("<!-- ste -->")) {
      open = true;
      return;
    }
    if (line.includes("<!-- /ste -->")) {
      open = false;
      return;
    }
    if (open) inside.push(i);
  });
  return inside;
}

/** Номера строк (0-based) между `<!-- vale off -->` и `<!-- vale on -->`; сами маркеры не входят. */
export function valeOffLines(text) {
  const inside = new Set();
  let off = false;
  text.split("\n").forEach((line, i) => {
    if (line.includes("<!-- vale off -->")) {
      off = true;
      return;
    }
    if (line.includes("<!-- vale on -->")) {
      off = false;
      return;
    }
    if (off) inside.add(i);
  });
  return inside;
}

/** Строки без встроенного кода (`…`) и признак «строка внутри блока кода» (` ``` `). */
export function stripCode(text) {
  const lines = [];
  const fenced = [];
  let inFence = false;
  for (const raw of text.split("\n")) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      lines.push("");
      fenced.push(true);
      continue;
    }
    fenced.push(inFence);
    lines.push(inFence ? "" : raw.replace(/`[^`]*`/g, " "));
  }
  return { lines, fenced };
}

/** Предложения строки: точка, «!», «?» или «…» перед пробелом и заглавной буквой или цифрой. */
export function sentences(line) {
  return line.split(/(?<=[.!?…])\s+(?=[«"(]?[\p{Lu}0-9])/u).filter((s) => s.trim());
}

/** Число слов: последовательности букв и цифр. */
export function wordCount(text) {
  return (text.match(/[\p{L}\p{N}]+/gu) || []).length;
}

/** Регулярное выражение синонима: по границам букв, без учёта регистра. */
export function synonymRegex(synonym) {
  const escaped = synonym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, "giu");
}

/** Строка без текста в кавычках «…»: пустое слово в кавычках не проверяется. */
export function stripQuotes(line) {
  return line.replace(/«[^»]*»/g, " ");
}

/** Проверка набора строк. `rules` — `{ synonyms, banned }`, `lineNumbers` — номера строк (1-based). */
export function lintLines(lines, lineNumbers, rules, file) {
  const { synonyms = [], banned = [] } = rules;
  const findings = [];
  lines.forEach((line, i) => {
    const number = lineNumbers[i];
    for (const { term, synonym } of synonyms) {
      if (synonymRegex(synonym).test(line)) {
        findings.push({ file, line: number, kind: "error", message: `запрещённый синоним «${synonym}» (термин: ${term})` });
      }
    }
    const unquoted = stripQuotes(line);
    for (const word of banned) {
      if (synonymRegex(word).test(unquoted)) {
        findings.push({ file, line: number, kind: "error", message: `пустое слово «${word}» (раздел «Не писать»)` });
      }
    }
    for (const sentence of sentences(line)) {
      const words = wordCount(sentence);
      if (words > MAX_WORDS) {
        findings.push({ file, line: number, kind: "warning", message: `предложение из ${words} слов (> ${MAX_WORDS})` });
      }
    }
  });
  return findings;
}

/** Проверка файла: `AGENTS.md` — только разделы `<!-- ste -->`, остальное целиком; `<!-- vale off -->` пропускается. */
export function lintFile(text, rules, file) {
  const { lines, fenced } = stripCode(text);
  const onlySte = file === AGENTS || file.endsWith(`/${AGENTS}`);
  const off = valeOffLines(text);
  const selected = (onlySte ? steRegionLines(text) : lines.map((_, i) => i)).filter((i) => !off.has(i));
  const numbers = selected.map((i) => i + 1);
  const content = selected.map((i) => (fenced[i] ? "" : lines[i]));
  return lintLines(content, numbers, rules, file);
}

/** Файлы по умолчанию: русские документы из охвата styles/DepeshaRU (mirror .vale.ini), кроме самого словаря. */
export function defaultTargets(root = ROOT) {
  const targets = [
    join(root, AGENTS),
    join(root, "README.md"),
    join(root, "e2e", "README.md"),
    join(root, "design", "mockups", "README.md"),
    join(root, "docs", "style", "ru-technical.md"),
  ];
  // docs/glossary.md — сам словарь: он перечисляет запрещённые слова и синонимы, проверять его этими же словами нельзя.
  const skip = new Set(["glossary.md"]);
  for (const dir of [join(root, "docs"), join(root, "docs", "agents"), join(root, "design", "references")]) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md") && !skip.has(entry.name)) targets.push(join(dir, entry.name));
      }
    } catch {
      // Каталога нет: проверять нечего.
    }
  }
  return targets;
}

export function run(targets, root = ROOT) {
  const glossary = readFileSync(join(root, GLOSSARY), "utf8");
  const rules = { synonyms: forbidden(parseGlossary(glossary)), banned: bannedWords(glossary) };
  const findings = [];
  for (const path of targets) {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    findings.push(...lintFile(text, rules, path.startsWith(root) ? path.slice(root.length + 1) : path));
  }
  return findings;
}

function main(argv) {
  const targets = argv.length ? argv.map((p) => resolve(p)) : defaultTargets();
  const findings = run(targets);
  const errors = findings.filter((f) => f.kind === "error");
  const warnings = findings.filter((f) => f.kind === "warning");
  for (const f of findings) console.log(`${f.file}:${f.line}: ${f.kind === "error" ? "ошибка" : "предупреждение"}: ${f.message}`);
  console.log(`ste-lint: файлов ${targets.length}, ошибок ${errors.length}, предупреждений ${warnings.length}`);
  process.exit(errors.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
