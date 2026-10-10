import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import QuickReply from "./QuickReply.svelte";

describe("the quick answer", () => {
  it("prints no key on the Send button: Ctrl+Enter works, but forms do not show keys", () => {
    const state = { quick: { all: false, draft: { to: [], cc: [] } }, text: "Привет", busy: false } as never;
    const { body } = render(QuickReply, { props: { state, manyRecipients: false } });
    expect(body).toContain("btn primary");
    expect(body).not.toContain("<kbd");
  });
});
