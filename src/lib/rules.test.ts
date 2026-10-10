// The rules of extensions on new mail: a failing read of the mail is told, not swallowed (#147).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));

import { extensions } from "./extensions.svelte";
import { applyRules } from "./rules";
import { api, resetFakes } from "./testing";
import type { Extension } from "./types";

beforeEach(() => resetFakes());

describe("applyRules", () => {
  it("tells when the new mail cannot be read, and runs no rule", async () => {
    extensions.list = [{ id: "r", enabled: true, hooks: ["newMail"] } as unknown as Extension];
    api.messagesById.mockRejectedValue(new Error("mail unreadable"));
    const app = { folders: [], account: () => undefined, ui: { toast: vi.fn(), fail: vi.fn() }, selection: { reload: vi.fn() } };
    const newMail = vi.spyOn(extensions, "newMail");
    await applyRules(app as never, [1, 2]);
    expect(app.ui.fail).toHaveBeenCalledWith(expect.objectContaining({ message: "mail unreadable" }), expect.stringContaining("rules"));
    expect(newMail).not.toHaveBeenCalled();
  });
});
