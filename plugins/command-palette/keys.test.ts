import { describe, expect, it } from "vitest";
import type { Command } from "@depesha/plugin-api";
import { editTarget } from "./keys";

const cmd = (id: string, title: string): Command => ({ id, title: () => title, run: () => {} });
const commands = [cmd("core.compose", "Compose"), cmd("core.archive", "Done: move to the archive")];

describe("Alt+Enter in the palette", () => {
  it("edits the highlighted command instead of running it", () => {
    expect(editTarget({ key: "Enter", altKey: true }, commands, 1)?.id).toBe("core.archive");
  });

  it("leaves a plain Enter to the command itself", () => {
    expect(editTarget({ key: "Enter", altKey: false }, commands, 1)).toBeUndefined();
  });

  it("says nothing for a command that is not there", () => {
    expect(editTarget({ key: "Enter", altKey: true }, [], 0)).toBeUndefined();
  });
});
