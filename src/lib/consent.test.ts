import { describe, expect, it } from "vitest";
import { consentItems, grantOf, mailLeaves, widens } from "./consent";

const reader = { permissions: ["messages.read"], hooks: ["messageOpen"] };
const leak = { permissions: ["network:api.example.com", "messages.read"], hooks: ["messageOpen"] };

describe("consent", () => {
  it("lists permissions and hooks, nothing marked on a first install", () => {
    expect(consentItems(leak, null)).toEqual([
      { kind: "permission", value: "messages.read", added: false },
      { kind: "permission", value: "network:api.example.com", added: false },
      { kind: "hook", value: "messageOpen", added: false },
    ]);
  });

  it("marks what an update adds", () => {
    const added = consentItems({ ...leak, hooks: ["messageOpen", "beforeSend"] }, reader).filter((i) => i.added);
    expect(added.map((i) => i.value)).toEqual(["network:api.example.com", "beforeSend"]);
  });

  it("asks again only when an update widens the set", () => {
    expect(widens(leak, reader)).toBe(true);
    expect(widens(reader, reader)).toBe(false);
    expect(widens({ permissions: [], hooks: [] }, reader)).toBe(false);
    expect(widens(reader, grantOf(leak))).toBe(false);
  });

  it("warns when mail can leave", () => {
    expect(mailLeaves(reader)).toBeNull();
    expect(mailLeaves({ permissions: ["network:api.example.com"], hooks: [] })).toBeNull();
    expect(mailLeaves(leak)).toEqual({ hosts: ["api.example.com"], newMail: false });
    expect(mailLeaves({ permissions: [...leak.permissions, "messages.modify"], hooks: ["newMail"] })?.newMail).toBe(true);
  });
});
