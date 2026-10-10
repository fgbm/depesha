import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { exited, groupAlive, killGroup } from "./procs.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("killGroup", () => {
  it("kills the child of the leader too, which kill() alone would leave", async () => {
    // The leader starts a grandchild and prints its pid.
    const leader = spawn("sh", ["-c", "sleep 60 & echo $!; wait"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const grandchild = Number(await new Promise((r) => leader.stdout.once("data", (b) => r(String(b).trim()))));
    expect(() => process.kill(grandchild, 0)).not.toThrow();
    expect(groupAlive(leader)).toBe(true);
    expect(killGroup(leader)).toBe(true);
    await exited(leader);
    await sleep(100);
    expect(groupAlive(leader)).toBe(false);
    expect(() => process.kill(grandchild, 0)).toThrow(/ESRCH/);
  });

  it("answers false for a group that is gone, without throwing", async () => {
    const p = spawn("true", [], { detached: true, stdio: "ignore" });
    await exited(p);
    await sleep(50);
    expect(killGroup(p)).toBe(false);
    expect(killGroup(undefined)).toBe(false);
  });
});

describe("exited", () => {
  it("resolves for a process that has already exited", async () => {
    const p = spawn("true", [], { stdio: "ignore" });
    await exited(p);
    await expect(exited(p)).resolves.toBeUndefined();
  });
});
