import { afterEach, describe, expect, it, vi } from "vitest";
import { registry } from "../plugin-host/registry.svelte";
import { extensions } from "./extensions.svelte";
import { emptyDraft } from "./compose";
import { sendWarnings } from "./sendChecks";

afterEach(() => {
  registry.removeOwner("broken");
  registry.removeOwner("careful");
  vi.restoreAllMocks();
});

describe("warnings before sending", () => {
  it("come from every check that works, the extensions' last", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    registry.add("sendChecks", "broken", () => {
      throw new Error("bug");
    });
    registry.add("sendChecks", "careful", (_draft, email) => [`no attachment (${email})`]);
    vi.spyOn(extensions, "beforeSend").mockResolvedValue(["Ext: big file"]);
    const found = await sendWarnings(emptyDraft({ name: "Me", email: "me@example.com" }), "me@example.com");
    expect(found).toEqual(["no attachment (me@example.com)", "Ext: big file"]);
    expect(logged).toHaveBeenCalled();
  });
});
