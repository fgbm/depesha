import { describe, expect, it } from "vitest";
import type { Text } from "@depesha/plugin-api";
import { confirmation, type Plan } from "./confirm";

const t = (text: Text, params: Record<string, string | number> = {}) =>
  text.en.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));

const mail = (foreign: boolean): Plan => ({
  way: { kind: "mail", to: "someone@example.org", subject: "Hello", text: "Any text" },
  from: "me@example.net",
  foreign,
});

describe("unsubscribe confirmation", () => {
  it("shows the letter as it will be sent, and from which mailbox", () => {
    const b = confirmation(t, "Shop", mail(false), null);
    expect(b.text).toContain("me@example.net");
    expect(b.details).toEqual([
      { label: "To", value: "someone@example.org" },
      { label: "Subject", value: "Hello" },
      { label: "Text", value: "Any text" },
    ]);
    expect(b.text).not.toContain("not on the sender's domain");
    expect(b.tone).toBe("info");
  });

  it("marks an address of another organization than the sender's", () => {
    const b = confirmation(t, "Shop", mail(true), null);
    expect(b.text).toContain("not on the sender's domain");
    expect(b.tone).toBe("warn");
  });

  it("names the way: one click with its host, a page with its address", () => {
    expect(confirmation(t, "Shop", { way: { kind: "one-click", host: "shop.example" }, from: "", foreign: false }, null).text).toContain(
      "in one click? Depesha will send a request to shop.example",
    );
    expect(confirmation(t, "Shop", { way: { kind: "link", url: "https://shop.example/u" }, from: "", foreign: false }, null).text).toContain(
      "https://shop.example/u",
    );
  });

  it("says why one click did not work before offering a letter", () => {
    expect(confirmation(t, "Shop", mail(false), "refused").text).toMatch(/^One-click unsubscribe did not work: refused\. Unsubscribe/);
  });
});
