// «Вернуть формат» after the recipient rule took the letter over (#44): the snapshot is put
// back whole only while the letter is still exactly as the rule left it. Typing or attaching
// something since the switch means a restore would throw that work away, so the return is an
// ordinary format change instead.
import { describe, expect, it } from "vitest";

import { ruleReturnPlan } from "./format.svelte";
import type { ComposeDraft } from "../types";

const draft = { format: "plain", text: "", to: [], cc: [], bcc: [], attachments: [] } as unknown as ComposeDraft;
const snapshot = JSON.stringify(draft);

describe("returning to the mailbox's format", () => {
  it("puts the snapshot back when the letter was not touched", () => {
    expect(ruleReturnPlan(draft, snapshot, snapshot)).toBe("restore");
  });

  it("takes the ordinary way back once the letter changed", () => {
    const typed = JSON.stringify({ ...draft, text: "hello" });
    expect(ruleReturnPlan(draft, snapshot, typed)).toBe("switch");
    const attached = JSON.stringify({ ...draft, attachments: [{ kind: "file", path: "/tmp/a", name: "a", size: 1 }] });
    expect(ruleReturnPlan(draft, snapshot, attached)).toBe("switch");
  });

  it("has no snapshot to put back when the rule never switched", () => {
    expect(ruleReturnPlan(null, null, snapshot)).toBe("switch");
    expect(ruleReturnPlan(draft, null, snapshot)).toBe("switch");
  });
});
