/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Built-in plugins may import only the plugin contract, Svelte, icons and their own
// files. Anything else ties a plugin to the core's insides and blocks moving it to its
// own repository.
const ROOT = fileURLToPath(new URL("../../plugins", import.meta.url));
const ALLOWED = [/^@depesha\/plugin-api$/, /^svelte(\/|$)/, /^@lucide\/svelte\/icons\//];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "community" ? [] : files(path);
    return /\.(ts|svelte)$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

function imports(source: string): string[] {
  return [...source.matchAll(/(?:import|export)[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(
    (m) => m[1] ?? m[2],
  );
}

describe("plugin boundary", () => {
  it("plugins import only the contract and their own files", () => {
    const bad: string[] = [];
    for (const file of files(ROOT)) {
      const plugin = relative(ROOT, file).split(/[\\/]/)[0];
      for (const spec of imports(readFileSync(file, "utf-8"))) {
        if (ALLOWED.some((re) => re.test(spec))) continue;
        if (spec.startsWith(".")) {
          const target = relative(ROOT, resolve(dirname(file), spec));
          // index.ts at the root lists the plugins; a plugin stays inside its own folder.
          if (plugin === "index.ts" || target.split(/[\\/]/)[0] === plugin) continue;
        }
        bad.push(`${relative(ROOT, file)}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("finds the plugins it guards", () => {
    expect(files(ROOT).length).toBeGreaterThan(10);
  });
});
