import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderInfo, OutboxItem } from "./types";

const { api } = vi.hoisted(() => ({ api: { folders: vi.fn(), outbox: vi.fn(), accounts: vi.fn() } }));
vi.mock("./api", () => ({ api }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.0.0" }));

import { MailboxController } from "./mailboxes.svelte";

const folder = { account_id: "a", name: "INBOX" } as FolderInfo;
const failed = { id: 1, failed: true } as unknown as OutboxItem;

/** A promise settled by hand, to make one answer come before the other. */
function later<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe("the mailboxes at the start (#158)", () => {
  it("come in after the settings: the smart rows the plugins add are there before the tree", async () => {
    const settings = later<void>();
    api.accounts.mockResolvedValue([{ id: "a" }]);
    const boxes = new MailboxController({ ui: { fail: vi.fn() } });
    const read = boxes.loadAccounts(settings.promise);
    await Promise.resolve();
    await Promise.resolve();
    expect(boxes.accounts).toEqual([]);
    settings.resolve();
    await read;
    expect(boxes.accounts).toEqual([{ id: "a" }]);
  });

  it("come in at once without a settings read to wait for", async () => {
    api.accounts.mockResolvedValue([{ id: "a" }]);
    const boxes = new MailboxController({ ui: { fail: vi.fn() } });
    await boxes.loadAccounts();
    expect(boxes.accounts).toEqual([{ id: "a" }]);
  });
});

describe("the first read of the sidebar's data (#158)", () => {
  const fail = vi.fn();
  beforeEach(() => vi.clearAllMocks());

  it("puts the folders and the outbox in together: a failed letter's row does not come after the tree", async () => {
    const folders = later<FolderInfo[]>();
    const outbox = later<OutboxItem[]>();
    api.folders.mockReturnValue(folders.promise);
    api.outbox.mockReturnValue(outbox.promise);
    const boxes = new MailboxController({ ui: { fail } });
    const read = boxes.loadFoldersAndOutbox();
    folders.resolve([folder]);
    await Promise.resolve();
    await Promise.resolve();
    // The tree has come, the outbox has not: nothing is shown yet.
    expect(boxes.folders).toEqual([]);
    outbox.resolve([failed]);
    await read;
    expect(boxes.folders).toEqual([folder]);
    expect(boxes.outbox).toEqual([failed]);
  });

  it("tells a failing request and still shows the other", async () => {
    api.folders.mockRejectedValue(new Error("no folders"));
    api.outbox.mockResolvedValue([failed]);
    const boxes = new MailboxController({ ui: { fail } });
    await boxes.loadFoldersAndOutbox();
    expect(fail).toHaveBeenCalledTimes(1);
    expect(boxes.outbox).toEqual([failed]);
    expect(boxes.folders).toEqual([]);
  });
});
