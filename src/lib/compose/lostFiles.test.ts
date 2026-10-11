// A file of a window that closed since can no longer go (#115): the window tells which one must
// be attached again, and takes it off the letter.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", async (orig) => ({ ...(await orig<object>()), api: (await import("../testing")).api }));
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../store.svelte", async () => ({
  app: (await import("../testing")).appMock({
    ui: { confirm: async () => true, fail: () => {}, toast: () => 0 },
    mailboxes: { account: () => undefined },
    compose: { send, close: () => {} },
  }),
}));
vi.mock("../hints.svelte", () => ({ hints: { recordSend: async () => {} } }));

import { dropLostFiles, isNotChosen } from "./lostFiles";
import { emptyDraft } from "../compose";
import { i18n } from "../i18n.svelte";
import { ComposeSending, type ComposeSendHost } from "./sending.svelte";
import { api } from "../testing";
import type { ComposeDraft } from "../types";

const notChosen = { kind: "not-chosen", message: "this file was not chosen to attach; add it again" };

function draftWith(...files: [string, string][]): ComposeDraft {
  const d = emptyDraft({ name: "Me", email: "me@example.com" });
  d.to = [{ name: null, email: "you@example.com" }];
  d.attachments = files.map(([path, name]) => ({ kind: "file", path, name, size: 5 }));
  return d;
}

beforeEach(() => {
  i18n.lang = "ru";
  api.fileInfo.mockReset();
  send.mockReset();
});

describe("the files a closed window left behind", () => {
  it("names the file that must be attached again and takes it off, the others stay", async () => {
    api.fileInfo.mockImplementation(async (path: string) => {
      if (path === "/gone/счёт.pdf") throw notChosen;
      return { path, name: "ok", size: 1 };
    });
    const d = draftWith(["/gone/счёт.pdf", "счёт.pdf"], ["/fine/план.txt", "план.txt"]);
    expect(await dropLostFiles(d)).toBe("Файл «счёт.pdf» нужно прикрепить заново");
    expect(d.attachments.map((a) => (a.kind === "file" ? a.name : ""))).toEqual(["план.txt"]);
  });

  it("speaks English in the English interface", async () => {
    i18n.lang = "en";
    api.fileInfo.mockRejectedValue(notChosen);
    expect(await dropLostFiles(draftWith(["/gone/a.pdf", "a.pdf"]))).toBe("File “a.pdf” must be attached again");
  });

  it("says nothing when no file is to blame, and does not take a file off for another trouble", async () => {
    api.fileInfo.mockRejectedValue({ kind: "io", message: "no such file" });
    const d = draftWith(["/x/a.pdf", "a.pdf"]);
    expect(await dropLostFiles(d)).toBeNull();
    expect(d.attachments).toHaveLength(1);
    expect(isNotChosen({ kind: "io" })).toBe(false);
    expect(isNotChosen(notChosen)).toBe(true);
  });
});

describe("a send that the backend refuses for such a file", () => {
  it("shows which file to attach again, takes it off the letter, and does not close the window", async () => {
    api.fileInfo.mockImplementation(async (path: string) => {
      if (path === "/gone/счёт.pdf") throw notChosen;
      return { path, name: "ok", size: 1 };
    });
    send.mockRejectedValue(notChosen);
    const win = { id: 1, mode: "open", savedAt: null, local_id: "t", account_id: "a", draft: draftWith(["/gone/счёт.pdf", "счёт.pdf"]), draft_id: null };
    const errors: string[] = [];
    const host = {
      win,
      autosave: { cancel: () => {}, settled: async () => {}, forgetLocal: async () => {} },
      commitAll: () => true,
      setError: (m: string) => errors.push(m),
      clearError: () => {},
    } as unknown as ComposeSendHost;
    await new ComposeSending(host).send(null, true);
    expect(errors).toEqual(["Файл «счёт.pdf» нужно прикрепить заново"]);
    expect(win.draft.attachments).toEqual([]);
  });
});
