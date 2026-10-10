import type { Component } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry, type ComposeControl } from "../../plugin-host/registry.svelte";
const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
const colors = vi.hoisted(() => ({ map: {} as Record<string, string> }));
vi.mock("../store.svelte", async () => ({
  app: (await import("../testing")).appMock({
    ui: { confirm, fail: () => {}, toast: () => 0 },
    account: () => undefined,
    accountColor: (id) => colors.map[id] ?? "#000000",
    send: async () => {},
    closeCompose: () => {},
  }),
}));
import { emptyDraft } from "../compose";
import type { ComposeWindow } from "../composes.svelte";
import { ComposeSending, withArchive, type ComposeSendHost } from "./sending.svelte";
import type { ComposeContext, PluginContext } from "../../plugin-api";

const ctx = {} as PluginContext;

/** A control as the host would register one; it renders nothing here. */
const control = (slot: ComposeControl["slot"]): ComposeControl => ({
  component: (() => null) as unknown as Component<{ compose: ComposeContext; ctx: PluginContext }>,
  props: { ctx },
  slot,
});

/** A window writing from `account_id`, with nothing else the context reads. */
function win(accountId: string): ComposeWindow {
  return { id: 1, mode: "open", savedAt: null, local_id: "test", account_id: accountId, draft: emptyDraft({ name: "Me", email: "me@example.com" }), draft_id: null };
}

/** Only the parts the context reads; the rest would be the window's own. */
function host(w: ComposeWindow, mailboxColors: Record<string, string>): ComposeSendHost {
  colors.map = mailboxColors;
  return {
    win: w,
    format: { insertText: () => {} },
  } as unknown as ComposeSendHost;
}

afterEach(() => registry.removeOwner("tint"));

describe("the From slot of the compose window", () => {
  it("collects a plugin's control registered for the From row, and keeps the slots apart", () => {
    registry.add("composeControls", "tint", control("from"));
    registry.add("composeControls", "tint", control("footer"));
    const sending = new ComposeSending(host(win("a"), { a: "#3f7cc4" }));
    expect(sending.controls.filter((x) => x.slot === "from")).toHaveLength(1);
    // The other slots are collected as before: the From control does not leak into them.
    expect(sending.controls.filter((x) => !x.slot || x.slot === "footer")).toHaveLength(1);
  });
});

describe("the context of a compose window", () => {
  it("gives the colour of the chosen mailbox, and follows the choice", () => {
    const w = win("a");
    const sending = new ComposeSending(host(w, { a: "#3f7cc4", b: "#c77d1a" }));
    expect(sending.composeCtx.accountId()).toBe("a");
    expect(sending.composeCtx.accountColor()).toBe("#3f7cc4");

    // The user picks another mailbox in "From"; the getters read the window's own field.
    w.account_id = "b";
    expect(sending.composeCtx.accountId()).toBe("b");
    expect(sending.composeCtx.accountColor()).toBe("#c77d1a");
  });
});

describe("the importance of a letter (#72)", () => {
  it("is switched on and off between high and normal, and a new letter is normal", () => {
    const w = win("a");
    const sending = new ComposeSending(host(w, {}));
    expect(w.draft.importance ?? "normal").toBe("normal");
    sending.toggleImportance();
    expect(w.draft.importance).toBe("high");
    sending.toggleImportance();
    expect(w.draft.importance ?? "normal").toBe("normal");
  });

  it("leaves the draft as it was after on and off: no field is left to make it a changed one", () => {
    const w = win("a");
    const before = JSON.stringify(structuredClone(w.draft));
    const sending = new ComposeSending(host(w, {}));
    sending.toggleImportance();
    expect(JSON.stringify(structuredClone(w.draft))).not.toBe(before);
    sending.toggleImportance();
    expect(JSON.stringify(structuredClone(w.draft))).toBe(before);
    expect("importance" in w.draft).toBe(false);
  });

  it("is switched by Alt+P in the window", () => {
    const w = win("a");
    const sending = new ComposeSending(host(w, {}));
    let prevented = false;
    const e = { key: "p", code: "KeyP", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault: () => (prevented = true) };
    sending.onKey(e as unknown as KeyboardEvent);
    expect(prevented).toBe(true);
    expect(w.draft.importance).toBe("high");
  });
});

describe("the Alt keys of the window (#103)", () => {
  const alt = (key: string, code: string) => ({ key, code, ctrlKey: false, shiftKey: false, altKey: true, metaKey: false, preventDefault: () => {} }) as unknown as KeyboardEvent;

  it("opens the part of the letter its key stands for", () => {
    const opened: string[] = [];
    const sending = new ComposeSending({ ...host(win("a"), {}), openPart: (p: string) => opened.push(p) } as unknown as ComposeSendHost);
    sending.onKey(alt("c", "KeyC"));
    sending.onKey(alt("m", "KeyM"));
    sending.onKey(alt("f", "KeyF"));
    sending.onKey(alt(".", "Period"));
    expect(opened).toEqual(["cc", "from", "format", "more"]);
  });

  it("hands «out of the inbox» and the reminder to the plugin that has them, and lets the key go without one", () => {
    registry.add("composeControls", "one", control("line"));
    const sending = new ComposeSending({ ...host(win("a"), {}), openPart: () => {} } as unknown as ComposeSendHost);
    let prevented = 0;
    const press = (key: string, code: string) => sending.onKey({ ...alt(key, code), preventDefault: () => prevented++ } as KeyboardEvent);
    press("r", "KeyR");
    expect(prevented).toBe(0);
    const ran: string[] = [];
    const [one] = sending.controls.map((c) => sending.contextFor(c));
    const stop = one.onAction("remind", () => ran.push("remind"));
    one.onAction("park", () => ran.push("park"));
    press("r", "KeyR");
    press("i", "KeyI");
    expect(ran).toEqual(["remind", "park"]);
    expect(prevented).toBe(2);
    stop();
    press("r", "KeyR");
    expect(ran).toEqual(["remind", "park"]);
    registry.removeOwner("one");
  });
});

describe("one owner for each Alt key of a plugin (#103)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses, with a warning, a second plugin that asks for a key another answers, and lets the owner ask again", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registry.add("composeControls", "one", control("line"));
    registry.add("composeControls", "two", control("line"));
    const sending = new ComposeSending(host(win("a"), {}));
    const [one, two] = sending.controls.map((c) => sending.contextFor(c));
    expect(sending.contextFor(sending.controls[0])).toBe(one);
    const ran: string[] = [];
    one.onAction("remind", () => ran.push("one"));
    expect(() => two.onAction("remind", () => ran.push("two"))).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    // The refused one has nothing to stop: the owner's answer stays.
    two.onAction("remind", () => {})();
    sending.onKey({ key: "r", code: "KeyR", altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, preventDefault: () => {} } as KeyboardEvent);
    expect(ran).toEqual(["one"]);
    const stop = one.onAction("remind", () => {});
    stop();
    two.onAction("remind", () => {});
    expect(warn).toHaveBeenCalledTimes(2);
    registry.removeOwner("one");
    registry.removeOwner("two");
  });

  it("refuses a caller without a name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sending = new ComposeSending(host(win("a"), {}));
    sending.composeCtx.onAction("park", () => {})();
    expect(warn).toHaveBeenCalled();
  });
});

describe("the box «out of the inbox» of an answer (#106)", () => {
  it("with «Без напоминания» asks to archive and makes no wait", () => {
    const plan = withArchive(null, true);
    expect(plan).toEqual({ deadline_secs: 0, repeat_secs: 0, expect: "", kind: "", archive: true });
    expect(plan?.park).toBeUndefined();
  });

  it("keeps the wait the user chose, and the mailbox's default when the box was not touched", () => {
    const wait = { deadline_secs: 3_600, repeat_secs: 0, expect: "", kind: "Через час" };
    expect(withArchive(wait, false)).toEqual({ ...wait, archive: false });
    expect(withArchive(wait, null)).toBe(wait);
    expect(withArchive(null, null)).toBeNull();
  });
});

describe("the local copy of a letter that left or was discarded (#147)", () => {
  function sendingHost() {
    const w = win("a");
    w.draft.to = [{ name: null, email: "you@example.com" }];
    const forgetLocal = vi.fn(async () => {});
    const h = {
      win: w,
      autosave: { cancel: () => {}, settled: async () => {}, forgetLocal },
      commitAll: () => true,
      clearError: () => {},
      setError: () => {},
      format: { insertText: () => {} },
    } as unknown as ComposeSendHost;
    return { sending: new ComposeSending(h), forgetLocal };
  }

  it("is dropped with the reason «sent» after a send", async () => {
    const { sending, forgetLocal } = sendingHost();
    await sending.send(null, true);
    expect(forgetLocal).toHaveBeenCalledWith("sent");
  });

  it("is dropped with the reason «discard» after «Delete»", async () => {
    const { sending, forgetLocal } = sendingHost();
    await sending.discard();
    expect(forgetLocal).toHaveBeenCalledWith("discard");
  });
});
