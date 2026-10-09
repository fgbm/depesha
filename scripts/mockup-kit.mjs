#!/usr/bin/env node
// Вставляет набор design/mockups/_kit (панель «Ответы») в HTML-макеты.
// Вставка лежит между <!-- mockup-kit:start --> и <!-- mockup-kit:end -->; при повторном запуске заменяется.
// Использование: node scripts/mockup-kit.mjs design/mockups/0.8.0/*.html
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const START = "<!-- mockup-kit:start -->";
const END = "<!-- mockup-kit:end -->";
const kit = join(dirname(fileURLToPath(import.meta.url)), "..", "design", "mockups", "_kit");

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Использование: node scripts/mockup-kit.mjs <макет.html>...");
  process.exit(2);
}

const css = readFileSync(join(kit, "answers.css"), "utf8").trimEnd();
const js = readFileSync(join(kit, "answers.js"), "utf8").trimEnd();
if (/<\/script/i.test(js)) throw new Error("answers.js не должен содержать закрывающий тег script");
const block = `${START}\n<style>\n${css}\n</style>\n<script>\n${js}\n</script>\n${END}`;

let failed = false;
for (const file of files) {
  const html = readFileSync(file, "utf8");
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  let out;
  if (a >= 0 && b > a) {
    out = html.slice(0, a) + block + html.slice(b + END.length);
  } else if (a < 0 && b < 0) {
    const at = html.lastIndexOf("</body>");
    if (at < 0) {
      console.error(`${file}: нет </body>`);
      failed = true;
      continue;
    }
    out = html.slice(0, at) + block + "\n" + html.slice(at);
  } else {
    console.error(`${file}: маркеры начала и конца не парные`);
    failed = true;
    continue;
  }
  if (out !== html) writeFileSync(file, out);
  console.log(`${file}: ${out === html ? "без изменений" : "обновлён"}`);
}
process.exit(failed ? 1 : 0);
