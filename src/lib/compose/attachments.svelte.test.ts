// A picture pasted into a Markdown letter goes into the text, not into the attachments (#80).
import { describe, expect, it, vi } from "vitest";

vi.mock("svelte", () => ({ onMount: () => {} }));
vi.mock("../api", async (orig) => ({ ...(await orig<object>()), api: (await import("../testing")).api }));
vi.mock("../pictureInput", () => ({
  picturesFromBlobs: async () => [{ name: "a.png", mime: "image/png", base64: "AAAA", dataUrl: "data:image/png;base64,AAAA" }],
  picturesHtml: async (found: unknown[]) => ({ html: "<img>", ready: found, tooBig: [], failed: [] }),
}));

import { ComposeAttachments, type ComposeAttachHost } from "./attachments.svelte";

describe("pasted pictures", () => {
  it("go into the text of a Markdown letter", async () => {
    const insertPictures = vi.fn(() => true);
    const attachments: unknown[] = [];
    const host = {
      win: { draft: { attachments } },
      format: { format: "markdown", insertPictures },
      imageMaxPx: () => 1600,
      fail: (e: unknown) => {
        throw e;
      },
    } as unknown as ComposeAttachHost;
    await new ComposeAttachments(host).pastedPictures([new Blob(["x"])]);
    expect(insertPictures).toHaveBeenCalledTimes(1);
    expect(attachments).toHaveLength(0);
  });
});
