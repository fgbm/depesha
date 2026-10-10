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
    ["a catch that does not use the error", "try { f(); } catch (e) { return 1; }"],
    ["an empty .catch handler", "p.catch(() => {});"],
    ["a .catch that ignores the error", "p.catch(() => []);"],
    ["an empty .catch handler with a parameter", "p.catch((e) => {});"],
    ["a .catch that does not use its parameter", "p.catch((e) => null);"],
    ["the second argument of .then", "p.then(ok, () => {});"],
    ["a bracket .catch", 'p["catch"](() => {});'],
    ["noop", "p.catch(noop);"],
    ["console.error: nobody sees the console of the built app", "p.catch(console.error);"],
    ["a comment on the last line of the try block", "try {\n  f();\n  // why\n} catch {}"],
    ["a comment on the last line of the try block, catch with a parameter", "try {\n  f();\n  // why\n} catch (e) {\n  return 1;\n}"],
    ["an empty comment inside", "p.catch(() => { /**/ });"],
    ["a comment after the statement", "p.catch(() => {}); // why"],
    ["the trailing comment of the previous statement", "f(); // why\np.catch(() => {});"],
    ["a comment separated by a blank line", "// why\n\np.catch(() => {});"],
    ["a comment in front of the catch keyword of another try", "// why\ntry { f(); } finally { g(); }\ntry { f(); } catch {}"],
  ])("rejects %s", (_name, code) => {
    expect(lint(code)).toBe(1);
  });

  it.each([
    ["a comment inside the catch", "try { f(); } catch {\n  // why\n  g();\n}"],
    ["a comment on the line above .catch", "// why\np.catch(() => {});"],
    ["a comment above a chained .catch", "p\n  .then(f)\n  // why\n  .catch(() => {});"],
    ["an inline comment in the handler", "p.catch(() => { /* why */ });"],
    ["a comment inside the second argument of .then", "p.then(ok, () => {\n  // why\n});"],
    ["a comment above the handler on its own line", "p.then(\n  ok,\n  // why\n  () => null,\n);"],
    ["a handler that uses the error", "p.catch((e) => app.fail(e));"],
    ["a catch that uses the error", "try { f(); } catch (e) { app.fail(e); }"],
    ["a .then with a handler that uses the error", "p.then(ok, (e) => app.fail(e));"],
  ])("lets pass %s", (_name, code) => {
    expect(lint(code)).toBe(0);
  });
});
