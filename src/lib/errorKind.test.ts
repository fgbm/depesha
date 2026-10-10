// The kinds of error the frontend knows are the kinds the backend has (#142).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ERROR_KINDS } from "./types";

describe("ErrorKind", () => {
  it("lists the same codes as the backend enum", () => {
    const source = readFileSync("crates/depesha-core/src/error.rs", "utf8");
    const body = source.split("pub const fn as_str(self)")[1]?.split("\n        }\n")[0] ?? "";
    const rust = [...body.matchAll(/Self::\w+ => "([a-z-]+)"/g)].map((m) => m[1]);
    expect(rust.length).toBeGreaterThan(0);
    expect([...ERROR_KINDS].sort()).toEqual([...rust].sort());
  });
});
