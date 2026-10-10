import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("the committed snapshot is the API of the repository", () => {
    expect(checkSnapshot(ENTRY, SNAPSHOT)).toBeNull();
  });
});
