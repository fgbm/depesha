// STE-проверка текстов для агентов: правила письма из пилота 2026-10-12.
//
//   node scripts/ste-lint.mjs                 AGENTS.md (только разделы `<!-- ste -->`) и docs/agents/*.md
//   node scripts/ste-lint.mjs <файл> …        явные файлы (AGENTS.md по маркерам, остальное целиком)
//
// Предупреждение — предложение длиннее 25 слов. Ошибка — запрещённый синоним из `docs/glossary.md`
// (строка «Синонимы (запрещены):» под заголовком термина). Код и блоки кода не проверяются.
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

/** Проверка набора строк. `lineNumbers` — их номера в файле (1-based). */
export function lintLines(lines, lineNumbers, syns, file) {
  const findings = [];
  lines.forEach((line, i) => {
    const number = lineNumbers[i];
    for (const { term, synonym } of syns) {
      if (synonymRegex(synonym).test(line)) {
        findings.push({ file, line: number, kind: "error", message: `запрещённый синоним «${synonym}» (термин: ${term})` });
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

/** Проверка файла: `AGENTS.md` — только разделы `<!-- ste -->`, остальное целиком. */
export function lintFile(text, syns, file) {
  const { lines, fenced } = stripCode(text);
  const onlySte = file === AGENTS || file.endsWith(`/${AGENTS}`);
  const selected = onlySte ? steRegionLines(text) : lines.map((_, i) => i);
  const numbers = selected.map((i) => i + 1);
  const content = selected.map((i) => (fenced[i] ? "" : lines[i]));
  return lintLines(content, numbers, syns, file);
}

/** Файлы по умолчанию: `AGENTS.md` и всё в `docs/agents/`. */
export function defaultTargets(root = ROOT) {
  const targets = [join(root, AGENTS)];
  const dir = join(root, "docs", "agents");
  try {
    for (const name of readdirSync(dir)) if (name.endsWith(".md")) targets.push(join(dir, name));
  } catch {
    // Каталога нет: проверять нечего.
  }
  return targets;
}

export function run(targets, root = ROOT) {
  const glossary = readFileSync(join(root, GLOSSARY), "utf8");
  const syns = forbidden(parseGlossary(glossary));
  const findings = [];
  for (const path of targets) {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    findings.push(...lintFile(text, syns, path.startsWith(root) ? path.slice(root.length + 1) : path));
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
