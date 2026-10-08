import { describe, expect, it } from "vitest";
import { copyFileName, stuckId, stuckOf, stuckTasks } from "./stuckCopies";
import type { Task } from "./types";

const task = (key: string, kind: Task["kind"], account_id = "a"): Task => ({
  key,
  kind,
  account_id,
  label: "x",
  done: 0,
  total: 0,
  state: "failed",
  started: 1,
});

describe("copies of sent letters the server refuses (#88)", () => {
  it("reads the copy's id from the task's key", () => {
    expect(stuckId(task("stuck-copy:42", "stuck-copy"))).toBe(42);
    expect(stuckId(task("send:42", "send"))).toBeNull();
  });

  it("picks the held copies out of the tasks, per mailbox", () => {
    const tasks = [task("stuck-copy:1", "stuck-copy", "a"), task("stuck-copy:2", "stuck-copy", "b"), task("sync:a", "sync")];
    expect(stuckTasks(tasks).map((x) => x.key)).toEqual(["stuck-copy:1", "stuck-copy:2"]);
    expect(stuckOf(tasks, "b").map((x) => x.key)).toEqual(["stuck-copy:2"]);
    expect(stuckOf(tasks, "c")).toEqual([]);
  });

  it("names the saved file after the subject, without what a file system refuses", () => {
    expect(copyFileName("Договор, правки")).toBe("Договор, правки.eml");
    expect(copyFileName('Re: a/b\\c?"d"')).toBe("Re a b c d.eml");
    expect(copyFileName("")).toBe("message.eml");
  });
});
