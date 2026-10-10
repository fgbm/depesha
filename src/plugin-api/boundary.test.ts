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

const NAMED = /(?:import|export)[^"']*?from\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
const COMPUTED = /\bimport\(\s*(?!["'\s])/;

/** Every module a source names: `from`, a bare `import "x"`, `import("x")`; `?` marks a path that is not a literal. */
function imports(source: string): string[] {
  const named = [...source.matchAll(NAMED)].map((m) => m.slice(1).find(Boolean) ?? "");
  return COMPUTED.test(source) ? [...named, "?"] : named;
}

/** What is wrong with the import `spec` of `file` (a file under `root`), or null. */
function wrong(root: string, file: string, spec: string): string | null {
  if (ALLOWED.some((re) => re.test(spec))) return null;
  if (spec === "?") return "import() with a path that is not a literal";
  if (!spec.startsWith(".")) return spec;
  const plugin = relative(root, file).split(/[\\/]/)[0];
  const target = relative(root, resolve(dirname(file), spec));
  // index.ts at the root lists the plugins, each in its own folder; a plugin stays inside its own.
  if (plugin === "index.ts" ? !target.startsWith("..") : target.split(/[\\/]/)[0] === plugin) return null;
  return spec;
}

function bad(root: string, files: Record<string, string>): string[] {
  return Object.entries(files).flatMap(([name, source]) =>
    imports(source).flatMap((spec) => {
      const why = wrong(root, join(root, name), spec);
      return why ? [`${name}: ${why}`] : [];
    }),
  );
}

describe("plugin boundary", () => {
  it("plugins import only the contract and their own files", () => {
    const sources = Object.fromEntries(files(ROOT).map((file) => [relative(ROOT, file), readFileSync(file, "utf-8")]));
    expect(bad(ROOT, sources)).toEqual([]);
  });

  it("finds the plugins it guards", () => {
    expect(files(ROOT).length).toBeGreaterThan(10);
  });

  describe("ways round it", () => {
    const root = "/r/plugins";
    const one = (source: string, name = "snooze/a.ts") => bad(root, { [name]: source });

    it("lets through the contract, the plugin's own files and a literal dynamic import of them", () => {
      expect(one('import { when } from "@depesha/plugin-api";\nimport "./b";\nimport x from "./sub/c";\nconst l = () => import("./later");')).toEqual([]);
      expect(one('import "./../snooze/b";')).toEqual([]);
      expect(one('import "./snooze";', "index.ts")).toEqual([]);
    });

    it("catches an import for its side effect", () => {
      expect(one('import "../../src/lib/i18n.svelte";')).toEqual(["snooze/a.ts: ../../src/lib/i18n.svelte"]);
      expect(one('import "lodash";')).toEqual(["snooze/a.ts: lodash"]);
    });

    it("catches a path that winds out through ./../..", () => {
      expect(one('import { t } from "./../../src/lib/format";')).toEqual(["snooze/a.ts: ./../../src/lib/format"]);
      expect(one('export * from "././../../src/lib/format";')).toEqual(["snooze/a.ts: ././../../src/lib/format"]);
    });

    it("catches another plugin's files", () => {
      expect(one('import { due } from "../followups/due";')).toEqual(["snooze/a.ts: ../followups/due"]);
      expect(one('import "./../followups/due";')).toEqual(["snooze/a.ts: ./../followups/due"]);
      expect(one('const l = () => import("../followups/due");')).toEqual(["snooze/a.ts: ../followups/due"]);
    });

    it("catches a way out of plugins/ from the root index", () => {
      expect(one('import { t } from "../src/lib/format";', "index.ts")).toEqual(["index.ts: ../src/lib/format"]);
    });

    it("catches a dynamic import by a computed path", () => {
      expect(one("const l = (n: string) => import(n);")).toEqual(["snooze/a.ts: import() with a path that is not a literal"]);
      expect(one("const l = (n: string) => import(`./${n}`);")).toEqual(["snooze/a.ts: import() with a path that is not a literal"]);
    });
  });
});
