// A picture pasted into a Markdown letter goes into the text, not into the attachments (#80).
import { describe, expect, it, vi } from "vitest";

vi.mock("svelte", () => ({ onMount: () => {} }));
const { fail, toast } = vi.hoisted(() => ({ fail: vi.fn(), toast: vi.fn() }));
vi.mock("../store.svelte", async () => ({ app: (await import("../testing")).appMock({ ui: { fail, toast }, settings: { image_max_px: 1600 } }) }));
vi.mock("../api", async (orig) => ({ ...(await orig<object>()), api: (await import("../testing")).api }));
vi.mock("../pictureInput", () => ({
  picturesFromBlobs: async () => [{ name: "a.png", mime: "image/png", base64: "AAAA", dataUrl: "data:image/png;base64,AAAA" }],
  picturesFromFiles: async (paths: string[]) => ({ found: [], refused: paths }),
  picturesHtml: async (found: unknown[]) => ({ html: "<img>", ready: found, tooBig: [], failed: [] }),
}));

import { api } from "../testing";
import { ComposeAttachments, type ComposeAttachHost } from "./attachments.svelte";

describe("pasted pictures", () => {
  it("go into the text of a Markdown letter", async () => {
    const insertPictures = vi.fn(() => true);
    const attachments: unknown[] = [];
    const host = {
      win: { draft: { attachments } },
      format: { format: "markdown", insertPictures },
    } as unknown as ComposeAttachHost;
    await new ComposeAttachments(host).pastedPictures([new Blob(["x"])]);
    expect(insertPictures).toHaveBeenCalledTimes(1);
    expect(attachments).toHaveLength(0);
  });
});

describe("a picture that cannot go into the text (#147)", () => {
  it("tells the error, not «attached as a file», when the file cannot be attached either", async () => {
    const boom = new Error("file gone");
    api.fileInfo.mockRejectedValue(boom);
    const attachments: unknown[] = [];
    fail.mockClear();
    toast.mockClear();
    const host = { win: { draft: { attachments } }, format: {} } as unknown as ComposeAttachHost;
    await new ComposeAttachments(host).insertPictureFiles(["/tmp/big.png"]);
    expect(attachments).toHaveLength(0);
    expect(fail).toHaveBeenCalledWith(boom, "big.png");
    expect(toast).not.toHaveBeenCalled();
  });
});
