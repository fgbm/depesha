// Guard of the live mockup: nothing of `src/demo/` may reach the production build.
//
//   node scripts/demo-guard.mjs            source check only (fast)
//   node scripts/demo-guard.mjs --bundle   build the app (`vite build`) and check the bundle too
//
// The source check fails if any file outside `src/demo/` imports from `src/demo/`: the demo
// backend, the variants and the «Вопросы» panel must stay behind the build-time aliases
// (`@tauri-apps/*` and `@demo/start`), which point at `src/demo/` in `demo` mode and at the
// no-op elsewhere. The bundle check builds the app the way Tauri does and fails if a demo
// marker (the demo backend's own words, the demo version) is anywhere in `dist/`.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const DEMO = join(ROOT, "src/demo");

/** Every `.ts`/`.svelte`/`.mjs` under `dir`, `src/demo/` aside. */
function* sources(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "dist-demo" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (resolve(path) === DEMO) continue;
      yield* sources(path);
    } else if (/\.(ts|svelte|mjs|js|html|css)$/.test(name)) yield path;
  }
}

/** The module specifiers a source imports. */
function specifiers(text) {
  const out = [];
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)) out.push(m[1]);
  return out;
}

/** A specifier that resolves into `src/demo/` from `file`. */
function leaksIntoDemo(file, spec) {
  if (spec.startsWith("@demo/")) return false; // the alias: the demo entry in `demo` mode, a no-op otherwise
  if (!spec.startsWith(".")) return false;
  const target = resolve(join(file, ".."), spec);
  return target === DEMO || target.startsWith(DEMO + "/");
}

function sourceProblems() {
  const problems = [];
  for (const dir of ["src", "plugins", "scripts", "e2e"]) {
    const base = join(ROOT, dir);
    try {
      readdirSync(base);
    } catch {
      // A directory the checkout does not have (e.g. no e2e/): nothing to check there.
      continue;
    }
    for (const file of sources(base)) {
      const text = readFileSync(file, "utf8");
      for (const spec of specifiers(text)) {
        if (leaksIntoDemo(file, spec)) problems.push(`${relative(ROOT, file)}: импортирует «${spec}» из src/demo/`);
      }
    }
  }
  return problems;
}

/** The strings only the demo carries; their presence in `dist/` means the demo leaked in. */
const MARKERS = ["0.8.3-demo", "demo backend"];

function bundleProblems() {
  execFileSync("npx", ["vite", "build", "--logLevel", "error"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
  const dist = join(ROOT, "dist");
  const problems = [];
  for (const file of sources(dist)) {
    if (!/\.(js|html)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const marker of MARKERS) if (text.includes(marker)) problems.push(`${relative(ROOT, file)}: содержит «${marker}» — демо попало в обычную сборку`);
  }
  return problems;
}

const problems = sourceProblems();
if (process.argv.includes("--bundle")) problems.push(...bundleProblems());
if (problems.length) {
  console.error(`Живой макет протёк в прод-код:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("demo-guard: src/demo/ не попадает в прод-код и не импортируется извне");
