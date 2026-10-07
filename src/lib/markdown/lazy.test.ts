import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The Markdown editor (CodeMirror) is its own chunk, loaded when a Markdown letter is
// opened: nothing outside src/lib/markdown/ may import it, or the editor's code at all,
// statically. Types are free, they leave no code. scripts/frontend-bundle.sh checks the
// build itself.

const root = fileURLToPath(new URL("../../..", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

/** The modules a file imports with code: `import type` and `import("…")` are not among them. */
function staticImports(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/^\s*import\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm)) {
    if (!m[1]) out.push(m[2]);
  }
  return out;
}

describe("the Markdown editor stays out of the main chunk", () => {
  it("is imported statically from nowhere outside its folder", () => {
    const wrong: string[] = [];
    for (const file of [...files(join(root, "src")), ...files(join(root, "plugins"))]) {
      const rel = relative(root, file);
      if (rel.startsWith("src/lib/markdown/")) continue;
      for (const spec of staticImports(readFileSync(file, "utf8"))) {
        if (/^@(codemirror|lezer)\//.test(spec) || /(^|\/)markdown\/(?!types$)/.test(spec)) wrong.push(`${rel}: ${spec}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("keeps the syntax highlighter out of the main chunk too", () => {
    // syntax.ts serves the editor (from its own chunk) and the reader (loaded by import());
    // a static import anywhere else would pull it into the main chunk (decision on #45).
    const wrong: string[] = [];
    for (const file of [...files(join(root, "src")), ...files(join(root, "plugins"))]) {
      const rel = relative(root, file);
      if (rel.startsWith("src/lib/markdown/")) continue;
      for (const spec of staticImports(readFileSync(file, "utf8"))) {
        if (/(^|\/)syntax$/.test(spec)) wrong.push(`${rel}: ${spec}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("finds the imports it checks", () => {
    expect(staticImports('import { a } from "@codemirror/view";\nimport type { B } from "./markdown/field";\nimport "./x";')).toEqual([
      "@codemirror/view",
      "./x",
    ]);
  });
});
