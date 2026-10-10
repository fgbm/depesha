// A mailbox's connection: what is checked against the server before it is saved,
// and the one line that stands for it while the fields are folded.

import { t } from "./i18n.svelte";
import type { Account, AccountStatus, OAuthProvider, Security, ServerConfig } from "./types";

function sameServer(a: ServerConfig, b: ServerConfig): boolean {
  return (
    a.host.trim() === b.host.trim() &&
    Number(a.port) === Number(b.port) &&
    a.security === b.security &&
    (a.trusted_cert ?? "") === (b.trusted_cert ?? "")
  );
}

function authOf(a: Account): string {
  return a.auth?.kind === "oauth" ? `oauth:${a.auth.provider}` : "password";
}

/**
 * Whether saving `after` over `before` needs a login first: something the server sees
 * changed, or a new password or browser sign-in waits to be saved. Names, the signature,
 * the folder and the sent copy do not reach the login.
 */
export function connectionChanged(before: Account, after: Account, password: string, grant: string | null): boolean {
  if (password || grant) return true;
  if (after.username.trim() !== before.username.trim() || authOf(after) !== authOf(before)) return true;
  if (!!after.ews !== !!before.ews) return true;
  if (after.ews && before.ews) {
    return after.ews.url.trim() !== before.ews.url.trim() || (after.ews.trusted_cert ?? "") !== (before.ews.trusted_cert ?? "");
  }
  return !sameServer(after.imap, before.imap) || !sameServer(after.smtp, before.smtp);
}

export function securityLabel(s: Security): string {
  return s === "tls" ? "SSL/TLS" : s === "starttls" ? "STARTTLS" : t("wizard.noEncryption");
}

function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host || url.trim();
  } catch {
    // Not a URL: shown as typed.
    return url.trim();
  }
}

/** «IMAP host:993, SSL/TLS · SMTP host:465, SSL/TLS · password sign-in», or the Exchange address. */
export function connectionSummary(a: Account, providerTitle: (p: OAuthProvider) => string): string {
  if (a.ews) return ["Exchange Web Services", hostOf(a.ews.url), t("account.loginAs", { login: a.username.trim() || a.email })].join(" · ");
  const server = (proto: string, s: ServerConfig) => `${proto} ${s.host.trim()}:${s.port}, ${securityLabel(s.security)}`;
  const login = a.auth?.kind === "oauth" ? t("account.byProvider", { provider: providerTitle(a.auth.provider) }) : t("account.byPassword");
  return [server("IMAP", a.imap), server("SMTP", a.smtp), login].join(" · ");
}

/** The state beside the summary: what the mailbox's connection is doing now. */
export function connectionState(status: AccountStatus | null): { state: AccountStatus["state"]; text: string } | null {
  if (!status) return null;
  const text = {
    online: t("account.online"),
    connecting: t("status.connecting"),
    error: t("account.failing"),
    paused: t("account.paused"),
  }[status.state];
  return { state: status.state, text };
}
