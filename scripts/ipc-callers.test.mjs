import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { check, handlerCommands, manifestCommands, manifestProblems, problemsOf } from "./ipc-callers.mjs";

const handler = `tauri::generate_handler![
    commands::alpha,
    // a comment, commands::ghost,
    #[cfg(feature = "e2e")]
    commands::beta,
    commands::gamma, drafts::delta,
    commands::last
])`;
const named = (...names) => names.map((name) => ({ name, e2e: false }));

describe("IPC callers guard", () => {
  it("reads the commands: cfg, two on a line, no comma after the last", () => {
    expect(handlerCommands(handler)).toEqual([
      { name: "alpha", e2e: false },
      { name: "beta", e2e: true },
      { name: "gamma", e2e: false },
      { name: "delta", e2e: false },
      { name: "last", e2e: false },
    ]);
  });

  it("fails on a command nobody calls", () => {
    expect(problemsOf(named("alpha", "gamma"), [`call("alpha")`], [], {})).toEqual([expect.stringContaining("gamma: no call")]);
  });

  it("counts invoke, call, backend, ctx.backend, a generic and a line break", () => {
    const app = [`invoke("a")`, `call<void>("b", { x })`, `ctx.backend<Record<string, number>>("c")`, `backend(\n  'd'\n)`];
    expect(problemsOf(named("a", "b", "c", "d"), app, [], {})).toEqual([]);
  });

  it("does not count a comment, another function or a longer name", () => {
    const app = [`// "gamma"`, `t("gamma")`, `call("gamma_more")`, `const s = "gamma";`];
    expect(problemsOf(named("gamma"), app, [], {})).toHaveLength(1);
  });

  it("counts invoke(driver, name) in e2e only", () => {
    expect(problemsOf(named("e2e_drop"), [], [`await invoke(d, "e2e_drop", {})`], {})).toEqual([expect.stringContaining("must stand under")]);
    expect(problemsOf(named("e2e_drop"), [`invoke(d, "e2e_drop")`], [], {})).toHaveLength(1);
  });

  it("wants a command called only from e2e behind cfg(feature = \"e2e\")", () => {
    const e2e = [`invoke("beta")`];
    expect(problemsOf([{ name: "beta", e2e: false }], [], e2e, {})).toEqual([expect.stringContaining("beta: called only from e2e/")]);
    expect(problemsOf([{ name: "beta", e2e: true }], [], e2e, {})).toEqual([]);
    expect(problemsOf([{ name: "beta", e2e: false }], [`call("beta")`], e2e, {})).toEqual([]);
  });

  it("lets a listed exception pass and flags a stale one", () => {
    expect(problemsOf(named("gamma"), [], [], { gamma: "why" })).toEqual([]);
    expect(problemsOf(named("gamma"), [`call("gamma")`], [], { gamma: "why" })).toHaveLength(1);
    expect(problemsOf(named("gamma"), [`call("gamma")`], [], { gone: "why" })).toHaveLength(1);
  });

  it("compares the handler with build.rs both ways", () => {
    const manifest = manifestCommands(`const COMMANDS: &[&str] = &[\n    "alpha",\n    "extra",\n];`);
    expect(manifest).toEqual(["alpha", "extra"]);
    expect(manifestProblems(named("alpha", "gamma"), manifest)).toEqual([
      expect.stringContaining("gamma: in generate_handler! but not in build.rs"),
      expect.stringContaining("extra: in build.rs COMMANDS but not in generate_handler!"),
    ]);
    expect(manifestProblems(named("alpha"), ["alpha"])).toEqual([]);
  });

  it("runs from check.sh --changed when the guard itself changes", () => {
    const sh = readFileSync(new URL("./check.sh", import.meta.url), "utf8");
    expect(sh).toContain("ipcguard=$(pick '^scripts/ipc-callers')");
    expect(sh).toMatch(/if \[\[ -n \$rust\$front\$e2e\$ipcguard \]\]; then\s+step "[^"]*"\s+node scripts\/ipc-callers\.mjs/);
  });

  it("holds on the real tree", () => {
    expect(check().problems).toEqual([]);
  });
});
