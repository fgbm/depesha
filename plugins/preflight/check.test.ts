import { describe, expect, it } from "vitest";
import { ownText, preflight } from "./check";

const me = { name: "Иван", email: "ivan@corp.example" };
const draft = (over: Record<string, unknown> = {}) => ({
  from: me, to: [], cc: [], bcc: [], subject: "", text: "", in_reply_to: null, references: [], attachments: [], ...over,
});

describe("preflight", () => {
  it("catches a forgotten attachment, but not in the quote or the signature", () => {
    const d = draft({ to: [{ name: null, email: "a@corp.example" }], subject: "x", text: "Счёт во вложении." });
    expect(preflight(d, me.email).map((w) => w.kind)).toEqual(["attachment"]);
    expect(preflight({ ...d, text: "Спасибо!\n\n01.10.2026 10:00, Пётр пишет:\n> прилагаю счёт" }, me.email)).toEqual([]);
    expect(preflight({ ...d, text: "Thanks!\n\nOn 1 Oct, Bob wrote:\n> the file is attached" }, me.email)).toEqual([]);
    expect(preflight({ ...d, text: "The file is attached." }, me.email).map((w) => w.kind)).toEqual(["attachment"]);
    expect(ownText("Привет\n\n-- \nИван, прилагаю всегда")).toBe("Привет");
  });

  it("warns when colleagues and outsiders share a letter", () => {
    const d = draft({ subject: "x", to: [{ name: null, email: "boss@corp.example" }], cc: [{ name: null, email: "partner@other.example" }] });
    expect(preflight(d, me.email)).toEqual([{ kind: "external", n: 0, domains: "other.example" }]);
    // Personal mailboxes: everyone is "external", that is normal.
    expect(preflight(d, "me@gmail.com")).toEqual([]);
  });

  it("counts recipients and notices an empty subject", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ name: null, email: `u${i}@corp.example` }));
    expect(preflight(draft({ to: many }), me.email).map((w) => [w.kind, w.n])).toEqual([["many", 11], ["subject", 0]]);
  });
});
