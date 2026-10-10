// The eslint rule depesha/no-silent-catch (#147): it catches a swallowed error and lets a commented one pass.
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS module of the eslint config, has no types
import silentCatch from "../../scripts/eslint-silent-catch.js";

function lint(code: string) {
  const linter = new Linter();
  const config = [{ files: ["**/*.ts"], languageOptions: { parser: tseslint.parser }, plugins: { depesha: silentCatch }, rules: { "depesha/no-silent-catch": "error" as const } }];
  return linter.verify(code, config, "x.ts").length;
}

describe("no-silent-catch", () => {
  it.each([
    ["an empty catch", "try { f(); } catch (e) {}"],
    ["a catch without the error", "try { f(); } catch { return 1; }"],
    ["an empty .catch handler", "p.catch(() => {});"],
    ["a .catch that ignores the error", "p.catch(() => []);"],
    ["an empty .catch handler with a parameter", "p.catch((e) => {});"],
  ])("rejects %s", (_name, code) => {
    expect(lint(code)).toBe(1);
  });

  it.each([
    ["a comment inside the catch", "try { f(); } catch {\n  // why\n  g();\n}"],
    ["a comment on the line above .catch", "// why\np.catch(() => {});"],
    ["a comment after .catch", "p.catch(() => {}); // why"],
    ["an inline comment in the handler", "p.catch(() => { /* why */ });"],
    ["a handler that uses the error", "p.catch((e) => app.fail(e));"],
    ["a catch that uses the error", "try { f(); } catch (e) { app.fail(e); }"],
  ])("lets pass %s", (_name, code) => {
    expect(lint(code)).toBe(0);
  });
});
