#!/usr/bin/env node
// Каждый абзац и каждый пункт списка — одна строка, какой бы длинной она ни была.
// Перенос строки допустим только между блоками: заголовки, абзацы, пункты списка,
// таблицы, блоки кода. Внутри блоков кода, таблиц, HTML-блоков и строк цитаты
// (каждая со своим `>`) переносы допустимы. Строка `---` допустима только как
// граница YAML-frontmatter; жёсткий перенос двумя пробелами в конце строки —
// нарушение.
//
//   node scripts/md-onelines.mjs [файл…]          проверка: `файл:строка` на каждое
//                                                 нарушение, код выхода 1
//   node scripts/md-onelines.mjs --fix [файл…]    склеить продолжение с предыдущей
//                                                 строкой через один пробел
//   node scripts/md-onelines.mjs --stdin --name X проверить один документ из stdin
//
// Без списка файлов проверяются все `*.md` в git, кроме `node_modules` и
// `docs/internal/` (черновики). CHANGELOG от внешних инструментов в репозитории
// нет, поэтому такого исключения здесь тоже нет.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Пути, которые проверка не трогает: черновики и зависимости. */
const EXCLUDED = [/(^|\/)node_modules\//, /^docs\/internal\//];

const FENCE = /^(\s*)(`{3,}|~{3,})/;
const ATX = /^\s{0,3}#{1,6}(\s|$)/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])(\s|$)/;
const QUOTE = /^\s{0,3}>/;
const TABLE_ROW = /^\s*\|/;
const THEMATIC = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const DASHES = /^-{3,}$/;
const SETEXT_EQ = /^\s{0,3}=+\s*$/;
const HTML_COMMENT = /^\s*<!--/;
const HTML_START = /^\s*(?:<!DOCTYPE|<\?|<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s|\/?>|$))/;
const HARD_BREAK = /[ \t]{2,}$/;

/**
 * Разбор документа: `violations` — нарушения `{ line, reason }` (строка 1-based),
 * `joins` — номера строк (0-based), которые `--fix` склеивает с предыдущей,
 * `codeLike` — строки внутри блока кода или frontmatter (их `--fix` не трогает).
 */
export function analyze(text) {
  const lines = text.split("\n");
  const n = lines.length;
  const violations = [];
  const joins = new Set();
  const codeLike = new Set();

  // YAML-frontmatter: только в самом начале файла, только с закрывающей границей.
  let fmEnd = -1;
  if (lines[0] !== undefined && lines[0].trim() === "---") {
    for (let i = 1; i < n; i++) {
      const t = lines[i].trim();
      if (t === "---" || t === "...") {
        fmEnd = i;
        break;
      }
    }
  }

  // Таблица — не одиночная строка с `|`, а ряд из двух и больше строк подряд.
  const isRow = lines.map((l) => TABLE_ROW.test(l));
  const inTable = new Array(n).fill(false);
  for (let i = 0; i < n; ) {
    if (isRow[i]) {
      let j = i;
      while (j < n && isRow[j]) j++;
      if (j - i >= 2) for (let k = i; k < j; k++) inTable[k] = true;
      i = j;
    } else {
      i++;
    }
  }

  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let inHtml = false;
  let htmlClose = null;
  let prevKind = "blank";

  for (let i = 0; i < n; i++) {
    const raw = lines[i];
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const idx = i + 1;

    if (fmEnd >= 0 && i <= fmEnd) {
      codeLike.add(i);
      prevKind = "frontmatter";
      continue;
    }

    if (inFence) {
      codeLike.add(i);
      const m = FENCE.exec(line);
      if (m && m[2][0] === fenceChar && m[2].length >= fenceLen) inFence = false;
      prevKind = "fence";
      continue;
    }
    const open = FENCE.exec(line);
    if (open) {
      codeLike.add(i);
      inFence = true;
      fenceChar = open[2][0];
      fenceLen = open[2].length;
      prevKind = "fence";
      continue;
    }

    if (inHtml) {
      if (htmlClose !== null) {
        // Комментарий кончается на строке с `-->`, а не на пустой строке.
        if (line.includes(htmlClose)) inHtml = false;
        prevKind = "html";
      } else if (line.trim() === "") {
        inHtml = false;
        prevKind = "blank";
      } else {
        prevKind = "html";
      }
      continue;
    }
    if (line.trim() !== "" && HTML_COMMENT.test(line)) {
      if (!line.includes("-->")) {
        inHtml = true;
        htmlClose = "-->";
      }
      prevKind = "html";
      continue;
    }
    if (line.trim() !== "" && HTML_START.test(line)) {
      inHtml = true;
      htmlClose = null;
      prevKind = "html";
      continue;
    }

    if (line.trim() === "") {
      prevKind = "blank";
      continue;
    }

    if (inTable[i]) {
      prevKind = "table";
      continue;
    }

    // Жёсткий перенос: два пробела в конце строки, за которой идёт текст. Склейку делает
    // обычная логика продолжения ниже; здесь важно только назвать строку нарушением.
    if (HARD_BREAK.test(line) && i + 1 < n && lines[i + 1].trim() !== "") {
      violations.push({ line: idx, reason: "жёсткий перенос двумя пробелами" });
    }

    if (QUOTE.test(line)) {
      prevKind = "quote";
      continue;
    }
    if (ATX.test(line)) {
      prevKind = "heading";
      continue;
    }
    if (DASHES.test(line.trim())) {
      violations.push({ line: idx, reason: "строка --- вне frontmatter" });
      prevKind = "hr";
      continue;
    }
    if (THEMATIC.test(line)) {
      prevKind = "hr";
      continue;
    }
    if (SETEXT_EQ.test(line)) {
      prevKind = "heading";
      continue;
    }
    if (LIST.test(line)) {
      prevKind = "list";
      continue;
    }

    if (prevKind === "paragraph" || prevKind === "quote" || prevKind === "list") {
      violations.push({ line: idx, reason: "перенос строки внутри блока" });
      joins.add(i);
    }
    prevKind = "paragraph";
  }

  return { violations, joins, codeLike };
}

/** Документ с одним пробелом вместо переноса и без жёстких переносов. */
export function fix(text) {
  const lines = text.split("\n");
  const { joins, codeLike } = analyze(text);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (codeLike.has(i)) {
      out.push(raw);
      continue;
    }
    const line = raw.replace(/\s+$/, "");
    if (joins.has(i) && out.length > 0) out[out.length - 1] = `${out[out.length - 1].replace(/\s+$/, "")} ${line.trim()}`;
    else out.push(line);
  }
  return out.join("\n");
}

/** Все `*.md` в git, кроме исключённых. */
function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\0").filter(Boolean).filter((f) => !EXCLUDED.some((re) => re.test(f)));
}

function optionValue(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const fixMode = args.includes("--fix");

  if (args.includes("--stdin")) {
    const name = optionValue(args, "--name") ?? "<stdin>";
    const { violations } = analyze(readFileSync(0, "utf8"));
    for (const v of violations) console.log(`${name}:${v.line}`);
    process.exit(violations.length > 0 ? 1 : 0);
  }

  const files = args.filter((a) => !a.startsWith("--"));
  const targets = files.length > 0 ? files : trackedFiles();

  let bad = 0;
  for (const file of targets) {
    const text = readFileSync(file, "utf8");
    if (fixMode) {
      const fixed = fix(text);
      if (fixed !== text) writeFileSync(file, fixed);
      continue;
    }
    for (const v of analyze(text).violations) {
      console.log(`${file}:${v.line}`);
      bad++;
    }
  }
  process.exit(bad > 0 ? 1 : 0);
}

// Запускается только при прямом вызове: тест импортирует проверки, а не исполняет их.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
