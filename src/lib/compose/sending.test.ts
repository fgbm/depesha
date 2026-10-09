import type { Component } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import { registry, type ComposeControl } from "../../plugin-host/registry.svelte";
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
function host(w: ComposeWindow, colors: Record<string, string>): ComposeSendHost {
  return {
    win: w,
    accountColor: (id: string) => colors[id] ?? "#000000",
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
