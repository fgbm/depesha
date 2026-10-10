import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSnapshot, checkSnapshot, ENTRY, SNAPSHOT } from "./plugin-api-snapshot.mjs";

let dir;
const entry = () => join(dir, "index.ts");
const snapshot = () => join(dir, "api.d.ts");
const api = (extra = "") => `
export interface Row { id: number; secret?: string }
export function pick(rows: Row[], n = 1): Row | null { return rows[n] ?? null; }
${extra}`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plugin-api-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("plugin API snapshot", () => {
  it("passes when the API is as the snapshot says", () => {
    writeFileSync(entry(), api());
    writeFileSync(snapshot(), buildSnapshot(entry()));
    expect(checkSnapshot(entry(), snapshot())).toBeNull();
  });

  it("ignores bodies, comments and formatting", () => {
    writeFileSync(entry(), api());
    writeFileSync(snapshot(), buildSnapshot(entry()));
    writeFileSync(entry(), api().replace("rows[n] ?? null", "/* same */ rows.at(n) ?? null").replace("{ id: number;", "{\n  id: number; // the key\n "));
    expect(checkSnapshot(entry(), snapshot())).toBeNull();
  });

  it("fails on a changed signature and says what to do", () => {
    writeFileSync(entry(), api());
    writeFileSync(snapshot(), buildSnapshot(entry()));
    writeFileSync(entry(), api().replace("n = 1", "n = 1, loud = false"));
    const failure = checkSnapshot(entry(), snapshot());
    expect(failure).toContain("API плагинов изменился");
    expect(failure).toContain("npm run plugin-api:update");
    expect(failure).toContain("plugins/CHANGELOG.md");
    expect(failure).toContain("+export declare function pick(rows: Row[], n?: number, loud?: boolean)");
  });

  it("fails on a field of a type the API only reaches through another", () => {
    writeFileSync(entry(), `${api()}\nexport type Page = { rows: Hidden[] };\ninterface Hidden { a: string }\n`);
    writeFileSync(snapshot(), buildSnapshot(entry()));
    writeFileSync(entry(), `${api()}\nexport type Page = { rows: Hidden[] };\ninterface Hidden { a: string; b: number }\n`);
    expect(checkSnapshot(entry(), snapshot())).toContain("+    b: number;");
  });

  it("fails when there is no snapshot yet", () => {
    writeFileSync(entry(), api());
    expect(checkSnapshot(entry(), snapshot())).toContain("API плагинов изменился");
  });

  it("does not take a type from the body of a function", () => {
    writeFileSync(entry(), `export function f(): number {\n  interface Local { x: 1 }\n  const l: Local = { x: 1 };\n  return l.x;\n}\n`);
    const text = buildSnapshot(entry());
    expect(text).toContain("export declare function f(): number;");
    expect(text).not.toContain("Local");
  });

  it("refuses two different types of one name and says where they are", () => {
    writeFileSync(join(dir, "a.ts"), "export interface Item { a: string }\n");
    writeFileSync(join(dir, "b.ts"), "export interface Item { b: number }\n");
    writeFileSync(entry(), `import type { Item as A } from "./a";\nimport type { Item as B } from "./b";\nexport interface Page { a: A; b: B }\n`);
    expect(() => buildSnapshot(entry())).toThrow(/два разных «Item»: .*[ab]\.ts и .*[ab]\.ts/);
  });

  it("writes a type imported under another name by its own", () => {
    writeFileSync(join(dir, "row.ts"), "export interface Row { id: number }\n");
    writeFileSync(entry(), `import type { Row as P2 } from "./row";\nexport interface Page { rows: P2[] }\nexport declare const first: P2;\n`);
    const text = buildSnapshot(entry());
    expect(text).toContain("rows: Row[];");
    expect(text).toMatch(/^interface Row \{/m);
    expect(text).not.toContain("P2");
  });

  it("names the major version of svelte", () => {
    const major = /\d+/.exec(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).dependencies.svelte)[0];
    writeFileSync(entry(), api());
    expect(buildSnapshot(entry())).toContain(`// svelte major: ${major}`);
  });

  it("the committed snapshot is the API of the repository", () => {
    expect(checkSnapshot(ENTRY, SNAPSHOT)).toBeNull();
  });
});
