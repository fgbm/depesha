// The eslint rule that keeps components off the AppStore proxies left for controller hosts (#140).
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS module of the eslint config, has no types
import { restrictedAppProxy } from "../../scripts/eslint-app-proxies.js";

function lint(code: string) {
  const linter = new Linter();
  const config = [{ files: ["**/*.ts"], languageOptions: { parser: tseslint.parser }, rules: { "no-restricted-syntax": restrictedAppProxy } }];
  return linter.verify(code, config, "x.ts").length;
}

describe("the app proxies are for controller hosts", () => {
  it.each(["app.toast('x')", "app.fail(e)", "app.reload()", "app.setView(v)", "app.tasksOpen = true", "app.wizard = null"])("rejects %s", (code) => {
    expect(lint(code)).toBe(1);
  });

  it.each(["app.ui.toast('x')", "app.selection.reload()", "app.ui.tasksOpen = true", "app.account(id)", "app.settings"])("lets %s pass", (code) => {
    expect(lint(code)).toBe(0);
  });
});
