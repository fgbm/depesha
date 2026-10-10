import { describe, expect, it } from "vitest";
import { check, handlerCommands, staleExceptions, uncalled } from "./ipc-callers.mjs";

const handler = `tauri::generate_handler![
    commands::alpha,
    // a comment
    #[cfg(feature = "e2e")]
    commands::beta,
    commands::gamma,
])`;

describe("IPC callers guard", () => {
  it("reads the commands out of generate_handler!, behind cfg too", () => {
    expect(handlerCommands(handler)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("fails on a command nobody calls", () => {
    const texts = [`call("alpha")`, `backend('beta')`];
    expect(uncalled(["alpha", "beta", "gamma"], texts, {})).toEqual(["gamma"]);
  });

  it("does not take a name inside a longer name for a call", () => {
    expect(uncalled(["alpha"], [`call("alpha_more")`], {})).toEqual(["alpha"]);
  });

  it("lets a listed exception pass and flags a stale one", () => {
    expect(uncalled(["gamma"], [], { gamma: "why" })).toEqual([]);
    expect(staleExceptions(["gamma"], [`call("gamma")`], { gamma: "why" })).toEqual(["gamma"]);
    expect(staleExceptions(["gamma"], [], { gone: "why" })).toEqual(["gone"]);
  });

  it("holds on the real tree", () => {
    expect(check().problems).toEqual([]);
  });
});
