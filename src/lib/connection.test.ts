import { beforeEach, describe, expect, it } from "vitest";
import { connectionChanged, connectionState, connectionSummary } from "./connection";
import { i18n } from "./i18n.svelte";
import type { Account } from "./types";

const base: Account = {
  id: "a",
  label: "Work",
  color: "",
  display_name: "Jane",
  email: "jane@example.com",
  username: "jane@example.com",
  imap: { host: "imap.example.com", port: 993, security: "tls" },
  smtp: { host: "smtp.example.com", port: 465, security: "tls" },
  save_sent_copy: true,
  signature: "",
  attachments_dir: "",
};
const edit = (patch: Partial<Account>): Account => ({ ...structuredClone(base), ...patch });
const title = (p: string) => ({ google: "Google", yandex: "Yandex", microsoft: "Microsoft" })[p] ?? p;

beforeEach(() => {
  i18n.lang = "en";
});

describe("whether saving needs a login first", () => {
  it("not for names, colour, signature, folder or the sent copy", () => {
    const after = edit({ label: "Home", color: "#3f7cc4", display_name: "J", signature: "--\nJ", attachments_dir: "/tmp", save_sent_copy: false });
    expect(connectionChanged(base, after, "", null)).toBe(false);
  });

  it("not for spaces around a host or a port typed as text", () => {
    const after = edit({ imap: { host: " imap.example.com ", port: "993" as unknown as number, security: "tls" } });
    expect(connectionChanged(base, after, "", null)).toBe(false);
  });

  it("for a server's host, port, encryption or trusted certificate", () => {
    expect(connectionChanged(base, edit({ smtp: { ...base.smtp, port: 587 } }), "", null)).toBe(true);
    expect(connectionChanged(base, edit({ imap: { ...base.imap, host: "mail.example.com" } }), "", null)).toBe(true);
    expect(connectionChanged(base, edit({ smtp: { ...base.smtp, security: "starttls" } }), "", null)).toBe(true);
    expect(connectionChanged(base, edit({ imap: { ...base.imap, trusted_cert: "ab" } }), "", null)).toBe(true);
  });

  it("for the login, a typed password or a new browser sign-in", () => {
    expect(connectionChanged(base, edit({ username: "CONTOSO\\jane" }), "", null)).toBe(true);
    expect(connectionChanged(base, edit({}), "secret", null)).toBe(true);
    expect(connectionChanged(base, edit({ auth: { kind: "oauth", provider: "google" } }), "", "grant-1")).toBe(true);
  });

  it("for another way to sign in", () => {
    expect(connectionChanged(base, edit({ auth: { kind: "oauth", provider: "google" } }), "", null)).toBe(true);
    // A password account with `auth` spelled out is the same account.
    expect(connectionChanged(base, edit({ auth: { kind: "password" } }), "", null)).toBe(false);
  });

  it("for Exchange: its address and certificate, not the IMAP fields it does not use", () => {
    const ews = edit({ ews: { url: "https://mail.example.com/EWS/Exchange.asmx" } });
    expect(connectionChanged(ews, { ...ews, imap: { ...ews.imap, port: 143 } }, "", null)).toBe(false);
    expect(connectionChanged(ews, { ...ews, ews: { url: "https://ex.example.com/EWS/Exchange.asmx" } }, "", null)).toBe(true);
    expect(connectionChanged(ews, { ...ews, ews: { ...ews.ews!, trusted_cert: "cd" } }, "", null)).toBe(true);
    expect(connectionChanged(base, ews, "", null)).toBe(true);
  });
});

describe("the connection's line", () => {
  it("names both servers and the sign-in", () => {
    expect(connectionSummary(base, title)).toBe("IMAP imap.example.com:993, SSL/TLS · SMTP smtp.example.com:465, SSL/TLS · password sign-in");
    const oauth = edit({ auth: { kind: "oauth", provider: "google" }, smtp: { ...base.smtp, port: 587, security: "starttls" } });
    expect(connectionSummary(oauth, title)).toBe("IMAP imap.example.com:993, SSL/TLS · SMTP smtp.example.com:587, STARTTLS · signed in with Google");
  });

  it("for Exchange, its host and the login", () => {
    const ews = edit({ username: "CONTOSO\\jane", ews: { url: "https://mail.example.com/EWS/Exchange.asmx" } });
    expect(connectionSummary(ews, title)).toBe("Exchange Web Services · mail.example.com · login CONTOSO\\jane");
  });

  it("follows the language", () => {
    i18n.lang = "ru";
    expect(connectionSummary(base, title)).toContain("вход по паролю");
  });

  it("says what the connection is doing", () => {
    expect(connectionState(null)).toBeNull();
    expect(connectionState({ state: "online" })).toEqual({ state: "online", text: "connected" });
    expect(connectionState({ state: "error", error: { kind: "network", message: "x" } })?.state).toBe("error");
  });
});
