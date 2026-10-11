// A file of a window that closed since can no longer go (#115): the window takes it off the
// letter and keeps a notice that outlives every save, so the letter does not go out without it
// unnoticed.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("svelte", async (orig) => ({ ...(await orig<object>()), onDestroy: () => {} }));
vi.mock("../api", async (orig) => ({ ...(await orig<object>()), api: (await import("../testing")).api }));
const { send, confirm } = vi.hoisted(() => ({ send: vi.fn(), confirm: vi.fn(async (_: unknown) => true) }));
vi.mock("../store.svelte", async () => ({
  app: (await import("../testing")).appMock({
    ui: { confirm, fail: () => {}, toast: () => 0 },
    mailboxes: { account: () => undefined },
    compose: { send, close: () => {} },
  }),
}));
vi.mock("../hints.svelte", () => ({ hints: { recordSend: async () => {} } }));

import { dropLostFiles, isNotChosen, lostNotice, sendWithoutQuestion, settleLostFiles } from "./lostFiles";
import { emptyDraft } from "../compose";
import type { ComposeWindow } from "../composes.svelte";
import { i18n } from "../i18n.svelte";
import { ComposeAutosave, type ComposeAutosaveHost } from "./autosave.svelte";
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

function windowWith(...files: [string, string][]): ComposeWindow {
  return { id: 1, mode: "open", savedAt: null, local_id: "t", account_id: "a", draft: draftWith(...files), draft_id: null } as unknown as ComposeWindow;
}

/** The backend refuses the file at `gone`, takes the rest. */
function refuse(gone: string) {
  api.fileInfo.mockImplementation(async (path: string) => {
    if (path === gone) throw notChosen;
    return { path, name: "ok", size: 1 };
  });
}

beforeEach(() => {
  i18n.lang = "ru";
  vi.clearAllMocks();
  api.fileInfo.mockReset();
  confirm.mockReset();
  confirm.mockResolvedValue(true);
  send.mockReset();
});

describe("the files a closed window left behind", () => {
  it("takes the file off, notes its name, and leaves the others", async () => {
    refuse("/gone/счёт.pdf");
    const w = windowWith(["/gone/счёт.pdf", "счёт.pdf"], ["/fine/план.txt", "план.txt"]);
    expect(await dropLostFiles(w)).toBe(true);
    expect(w.draft.attachments.map((a) => (a.kind === "file" ? a.name : ""))).toEqual(["план.txt"]);
    expect(w.lostFiles).toEqual(["счёт.pdf"]);
    expect(lostNotice(w)).toBe("Файл «счёт.pdf» нужно прикрепить заново");
  });

  it("speaks English in the English interface", async () => {
    i18n.lang = "en";
    api.fileInfo.mockRejectedValue(notChosen);
    const w = windowWith(["/gone/a.pdf", "a.pdf"]);
    await dropLostFiles(w);
    expect(lostNotice(w)).toBe("File “a.pdf” must be attached again");
    expect(sendWithoutQuestion(w)).toBe("Send without the file “a.pdf”?");
  });

  it("touches nothing when no file is to blame", async () => {
    api.fileInfo.mockRejectedValue({ kind: "io", message: "no such file" });
    const w = windowWith(["/x/a.pdf", "a.pdf"]);
    expect(await dropLostFiles(w)).toBe(false);
    expect(w.draft.attachments).toHaveLength(1);
    expect(w.lostFiles).toBeUndefined();
    expect(isNotChosen({ kind: "io" })).toBe(false);
    expect(isNotChosen(notChosen)).toBe(true);
  });

  it("is told apart no more once the file is attached again", async () => {
    refuse("/gone/счёт.pdf");
    const w = windowWith(["/gone/счёт.pdf", "счёт.pdf"]);
    await dropLostFiles(w);
    settleLostFiles(w);
    expect(w.lostFiles).toEqual(["счёт.pdf"]);
    w.draft.attachments.push({ kind: "file", path: "/new/счёт.pdf", name: "счёт.pdf", size: 5 });
    settleLostFiles(w);
    expect(w.lostFiles).toEqual([]);
    expect(lostNotice(w)).toBe("");
    expect(sendWithoutQuestion(w)).toBe("");
  });
});

describe("the notice and the saves", () => {
  it("is not cleared by the next successful save of the draft", async () => {
    refuse("/gone/счёт.pdf");
    const w = windowWith(["/gone/счёт.pdf", "счёт.pdf"]);
    w.unsaved = true;
    const errors: string[] = [];
    const host: ComposeAutosaveHost = { win: w, setError: (m) => errors.push(m), clearError: () => errors.push("cleared") };
    const autosave = new ComposeAutosave(host);
    api.draftCachePut.mockResolvedValue(undefined);
    api.draftSave.mockRejectedValueOnce(notChosen);
    expect(await autosave.save(true)).toBe(false);
    expect(w.lostFiles).toEqual(["счёт.pdf"]);
    expect(errors).toEqual([]);
    // The next save goes through, without the file: the error line is cleared, the notice stays.
    api.draftSave.mockResolvedValue({ id: 7, message_id: "m7@depesha.local" });
    w.draft.subject = "Счёт";
    expect(await autosave.save(true)).toBe(true);
    expect(errors).toContain("cleared");
    expect(w.lostFiles).toEqual(["счёт.pdf"]);
  });
});

describe("a send while a file is lost", () => {
  function sending(w: ComposeWindow) {
    const host = {
      win: w,
      autosave: { cancel: () => {}, settled: async () => {}, forgetLocal: async () => {} },
      commitAll: () => true,
      setError: () => {},
      clearError: () => {},
    } as unknown as ComposeSendHost;
    return new ComposeSending(host);
  }

  it("asks whether to send without the file, and does not send on «no»", async () => {
    const w = windowWith();
    w.lostFiles = ["счёт.pdf"];
    confirm.mockResolvedValue(false);
    await sending(w).send(null, true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatchObject({ text: "Отправить без файла «счёт.pdf»?" });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends on «yes»", async () => {
    const w = windowWith();
    w.lostFiles = ["счёт.pdf"];
    send.mockResolvedValue(undefined);
    await sending(w).send(null, true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("asks nothing when no file is lost", async () => {
    send.mockResolvedValue(undefined);
    await sending(windowWith()).send(null, true);
    expect(confirm).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("when the backend refuses a file, notes it, shows no error line and does not close the window", async () => {
    refuse("/gone/счёт.pdf");
    send.mockRejectedValue(notChosen);
    const w = windowWith(["/gone/счёт.pdf", "счёт.pdf"]);
    const errors: string[] = [];
    const host = {
      win: w,
      autosave: { cancel: () => {}, settled: async () => {}, forgetLocal: async () => {} },
      commitAll: () => true,
      setError: (m: string) => errors.push(m),
      clearError: () => {},
    } as unknown as ComposeSendHost;
    await new ComposeSending(host).send(null, true);
    expect(w.lostFiles).toEqual(["счёт.pdf"]);
    expect(w.draft.attachments).toEqual([]);
    expect(errors).toEqual([]);
  });
});
