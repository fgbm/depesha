// Guard of the live mockup: nothing of `src/demo/` may reach the production build.
//
//   node scripts/demo-guard.mjs                     source check only (fast)
//   node scripts/demo-guard.mjs --bundle            build the app (`vite build`) with a plugin
//                                                   that fails on any module inside `src/demo/`
//   node scripts/demo-guard.mjs --bundle --no-build reuse the ready `dist/` (fresh, built just
//                                                   before) instead of building again
//
// The source check fails if any file outside `src/demo/` imports from it: a relative path, a
// root-absolute one (`/src/demo/data`) or `import.meta.glob` over `src/demo/`. The demo
// backend, the variants and the «Вопросы» panel must stay behind the build-time aliases
// (`@tauri-apps/*` and `@demo/start`), which point at `src/demo/` in `demo` mode and at the
// no-op elsewhere.
//
// The bundle check is a Vite plugin, not a string marker: it fails the build on any module
// whose id is inside `src/demo/`, however it was reached. With `--no-build` the build is not
// repeated; instead the ready `dist/` must be newer than every source file, so a stale bundle
// cannot hide a leak.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const DEMO = join(ROOT, "src", "demo");

/** Every file with a name the check reads, under `dir`; `src/demo/` itself is skipped. */
function* sources(dir, skipDemo = true) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "dist-demo" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (skipDemo && resolve(path) === DEMO) continue;
      yield* sources(path, skipDemo);
    } else if (/\.(ts|svelte|mjs|js|html|css)$/.test(name) && !/\.test\./.test(name)) yield path;
  }
}

/** The module specifiers a source imports, `import.meta.glob` included. */
export function specifiers(text) {
  const out = [];
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bglob\s*\(\s*)["']([^"']+)["']/g)) out.push(m[1]);
  return out;
}

/** A specifier that points into `src/demo/` from `file`, whatever form it takes. */
export function leaksIntoDemo(file, spec, root = ROOT) {
  if (spec.startsWith("@demo/")) return false; // the alias: the demo entry in `demo` mode, a no-op otherwise
  if (/(^|\/)src\/demo(\/|$)/.test(spec)) return true;
  const demo = join(root, "src", "demo");
  const target = spec.startsWith("/") ? join(root, spec) : spec.startsWith(".") ? resolve(dirname(file), spec) : null;
  if (target === null) return false;
  return target === demo || target.startsWith(demo + sep);
}

/** The files outside `src/demo/` that import from it. */
export function sourceProblems(dirs = ["src", "plugins", "scripts", "e2e"], root = ROOT) {
  const problems = [];
  for (const dir of dirs) {
    const base = join(root, dir);
    try {
      readdirSync(base);
    } catch {
      // A directory the checkout does not have (e.g. no e2e/): nothing to check there.
      continue;
    }
    for (const file of sources(base)) {
      const text = readFileSync(file, "utf8");
      for (const spec of specifiers(text)) {
        if (leaksIntoDemo(file, spec, root)) problems.push(`${relative(root, file)}: импортирует «${spec}» из src/demo/`);
      }
    }
  }
  return problems;
}

/** A plugin that fails the build on any module inside `src/demo/`. */
export function leakGuard(root = ROOT) {
  const demo = join(root, "src", "demo");
  const inside = (id) => {
    const path = id.split("?")[0];
    return path === demo || path.startsWith(demo + sep);
  };
  return {
    name: "depesha-demo-leak-guard",
    enforce: "pre",
    load(id) {
      if (inside(id)) throw new Error(`живой макет в обычной сборке: ${relative(root, id)}`);
    },
  };
}

/** The newest modification time under `dirs`, for the freshness check of a reused `dist/`. */
function newestSource(dirs = ["src", "plugins"]) {
  let newest = 0;
  for (const dir of dirs) {
    const base = join(ROOT, dir);
    try {
      for (const file of sources(base, false)) newest = Math.max(newest, statSync(file).mtimeMs);
    } catch {
      // A directory the checkout does not have: it holds no source to compare with.
    }
  }
  for (const extra of ["index.html", "vite.config.ts", "package.json"]) {
    try {
      newest = Math.max(newest, statSync(join(ROOT, extra)).mtimeMs);
    } catch {
      // Not in this checkout: nothing to compare.
    }
  }
  return newest;
}

/** Builds the app with the leak guard; a leak makes Vite throw. */
async function buildGuarded() {
  await build({ configFile: join(ROOT, "vite.config.ts"), root: ROOT, logLevel: "silent", plugins: [leakGuard()] });
}

/** Reuses the ready `dist/`, refusing a bundle older than the sources it should have come from. */
function reuseDist() {
  const index = join(ROOT, "dist", "index.html");
  let built;
  try {
    built = statSync(index).mtimeMs;
  } catch {
    return [`dist/index.html нет: соберите (npm run build) или не передавайте --no-build`];
  }
  const newest = newestSource();
  return built < newest ? [`dist/ старше исходников: соберите заново (npm run build)`] : [];
}

async function main(argv) {
  const bundle = argv.includes("--bundle");
  const problems = sourceProblems();
  if (bundle) {
    if (argv.includes("--no-build")) problems.push(...reuseDist());
    else {
      try {
        await buildGuarded();
      } catch (e) {
        problems.push(String(e?.message ?? e));
      }
    }
  }
  if (problems.length) {
    console.error(`Живой макет протёк в прод-код:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("demo-guard: src/demo/ не попадает в прод-код и не импортируется извне");
}

// Run only when the script itself is started (a test imports the checks, it does not run them).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
