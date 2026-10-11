// The guard of the live mockup must catch every way `src/demo/` could reach the app: a
// relative import, a root-absolute one (`/src/demo/data`), and `import.meta.glob`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { leaksIntoDemo, sourceProblems } from "./demo-guard.mjs";

const root = "/proj";

describe("leaksIntoDemo", () => {
  it("ловит импорт по корневому пути", () => {
    expect(leaksIntoDemo("/proj/src/main.ts", "/src/demo/data", root)).toBe(true);
  });

  it("ловит относительный путь в src/demo/", () => {
    expect(leaksIntoDemo("/proj/src/main.ts", "./demo/data", root)).toBe(true);
  });

  it("ловит путь из подпапки", () => {
    expect(leaksIntoDemo("/proj/src/lib/x.ts", "../demo/backend", root)).toBe(true);
  });

  it("не трогает алиас @demo/start", () => {
    expect(leaksIntoDemo("/proj/src/main.ts", "@demo/start", root)).toBe(false);
  });

  it("не трогает обычные импорты", () => {
    expect(leaksIntoDemo("/proj/src/main.ts", "./lib/api", root)).toBe(false);
    expect(leaksIntoDemo("/proj/src/main.ts", "svelte", root)).toBe(false);
  });
});

describe("sourceProblems", () => {
  const dir = mkdtempSync(join(tmpdir(), "demo-guard-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("видит корневой импорт и import.meta.glob", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "root.ts"), 'import { data } from "/src/demo/data";\n');
    writeFileSync(join(dir, "src", "glob.ts"), 'const m = import.meta.glob("./demo/*.ts");\n');
    writeFileSync(join(dir, "src", "ok.ts"), 'import { startDemo } from "@demo/start";\nimport { api } from "./lib/api";\n');
    const problems = sourceProblems(["src"], dir);
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain("root.ts");
    expect(problems.join("\n")).toContain("glob.ts");
  });
});
