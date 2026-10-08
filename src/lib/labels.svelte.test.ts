// A folder's properties (#71): the saved cache is shown at once, and the server is asked
// again only when that cache grew old — opening a folder is not a reason to call it.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));

import { labels } from "./labels.svelte";
import { api, resetFakes } from "./testing";
import type { FolderProps } from "./types";

const stored = new Map<string, string>();

function props(checked = Math.floor(Date.now() / 1000)): FolderProps {
  return { folder: "INBOX", display_name: "INBOX", owner: { kind: "mine" }, rights: null, labels_on_server: true, permanent: [], label_check: null, refused: null, checked };
}

beforeEach(() => {
  resetFakes();
  labels.props = {};
  stored.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  });
});

describe("a folder's properties", () => {
  it("are read once and shown from the cache after a restart, without asking again", async () => {
    api.folderProps.mockResolvedValue(props());
    await labels.loadProps("a", "INBOX");
    expect(api.folderProps).toHaveBeenCalledTimes(1);

    // A new session: the in-memory cache is gone, the saved one stays.
    labels.props = {};
    api.folderProps.mockClear();
    await labels.loadProps("a", "INBOX");
    expect(api.folderProps).not.toHaveBeenCalled();
    expect(labels.prop("a", "INBOX")?.display_name).toBe("INBOX");
  });

  it("are read from the server again once the saved cache grew old", async () => {
    // A saved copy from long ago: it is shown, but the server is asked to refresh it.
    stored.set("depesha.folderProps", JSON.stringify({ "a\u0000INBOX": props(0) }));
    api.folderProps.mockResolvedValue(props());
    labels.props = {};
    await labels.loadProps("a", "INBOX");
    expect(api.folderProps).toHaveBeenCalledTimes(1);
  });
});
