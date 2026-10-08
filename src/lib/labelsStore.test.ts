import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));

import { labels } from "./labels.svelte";
import { i18n } from "./i18n.svelte";
import { api } from "./testing";

beforeEach(() => {
  i18n.lang = "ru";
  labels.all = {};
  labels.counts = {};
  api.labelRename.mockResolvedValue({ name: "Счёты", keyword: "depesha-scheta", color: "#d0573f" });
  api.labels.mockResolvedValue([]);
  api.labelCounts.mockResolvedValue([]);
  api.labelStrip.mockResolvedValue(undefined);
});

describe("the labels store (#42)", () => {
  it("renames by name and keeps the keyword the letters carry", async () => {
    const out = await labels.rename("a", "Счета", "Счёты");
    expect(api.labelRename).toHaveBeenCalledWith("a", "Счета", "Счёты");
    expect(out?.keyword).toBe("depesha-scheta");
  });

  it("deleting strips the keyword on the server and refreshes the list", async () => {
    await labels.strip("a", "Счета");
    expect(api.labelStrip).toHaveBeenCalledWith("a", "Счета");
    expect(api.labelCounts).toHaveBeenCalledWith("a");
  });

  it("keeps the per-keyword counts the list shows as «≈N»", async () => {
    api.labelCounts.mockResolvedValue([{ keyword: "depesha-scheta", count: 5 }]);
    await labels.loadCounts("a");
    expect(labels.count("a", "depesha-scheta")).toBe(5);
    expect(labels.count("a", "нет такой")).toBe(0);
  });
});
