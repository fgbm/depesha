// A mailbox being set up or edited: the fields, the detection and sign-in steps, the
// check against the server and the save. The wizard (a new mailbox) and the mailbox's
// page in the settings both drive one of these; their fields are shared components.

import { app } from "./store.svelte";
import { api, asError } from "./api";
import { t } from "./i18n.svelte";
import { connectionChanged } from "./connection";
import type { Account, BodyFormat, CmdError, OAuthProvider, OAuthProviderView, Security, ServerConfig, Signature, Waiting } from "./types";

const DEFAULT_PORT: Record<"imap" | "smtp", Record<Security, number>> = {
  imap: { tls: 993, starttls: 143, plain: 143 },
  smtp: { tls: 465, starttls: 587, plain: 25 },
};

/** Mail domains whose provider wants OAuth rather than a password. */
export function oauthFor(address: string): OAuthProvider | null {
  const domain = address.split("@")[1]?.trim().toLowerCase() ?? "";
  if (["gmail.com", "googlemail.com"].includes(domain)) return "google";
  if (["yandex.ru", "ya.ru", "yandex.com", "yandex.by", "yandex.kz", "narod.ru"].includes(domain)) return "yandex";
  if (["outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.ru", "hotmail.ru", "live.ru"].includes(domain)) return "microsoft";
  return null;
}

/**
 * The own limit typed in GB ("4", "2,5", "5 120" as the app shows sizes) in MB; 0 when
 * empty or not a number. Digit groups may be split by any space, the no-break ones too.
 */
export function limitMb(gb: string): number {
  const n = Number(gb.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1024) : 0;
}

export function fingerprint(sha: string): string {
  return sha.toUpperCase().match(/.{1,2}/g)?.join(":") ?? sha;
}

export class AccountForm {
  /** The mailbox being edited; none while a new one is set up. */
  readonly existing: Account | null;
  /** Saved or removed. */
  private readonly done: () => void;
  /** The mailbox as it was opened, to tell whether anything was changed since. */
  private readonly initial: string;

  /** `imap`: password over IMAP and SMTP; `oauth`: browser sign-in; `ews`: Exchange Web Services. */
  mode = $state<"imap" | "oauth" | "ews">("imap");
  provider = $state<OAuthProvider | null>(null);
  /** A browser sign-in not saved yet. */
  grant = $state<string | null>(null);
  providers = $state<OAuthProviderView[]>([]);
  /** The provider whose sign-in page is open in the browser; the form waits for it. */
  waitingFor = $state<OAuthProvider | null>(null);
  get waitingBrowser(): boolean {
    return this.waitingFor !== null;
  }
  /** The sign-in under way, so a click on another provider can end it first. */
  private attempt: Promise<void> | null = null;
  private attempts = 0;
  ewsUrl = $state("");
  ewsCert = $state<string | undefined>(undefined);
  ewsServer = $state("");

  step = $state<"start" | "settings">("start");
  label = $state("");
  color = $state("");
  name = $state("");
  email = $state("");
  password = $state("");
  username = $state("");
  imap = $state<ServerConfig>({ host: "", port: 993, security: "tls" });
  smtp = $state<ServerConfig>({ host: "", port: 587, security: "starttls" });
  saveSent = $state(true);
  /** The mailbox's signatures in order, and the ids of the default one for new letters
   * and for replies and forwards (lib/signatures.ts). */
  signatures = $state<Signature[]>([]);
  defaultSignature = $state<string | null>(null);
  replySignature = $state<string | null>(null);
  /** How new letters from this mailbox are written; "" takes the format from the settings. */
  composeFormat = $state<BodyFormat | "">("");
  attachmentsDir = $state("");
  /** The inbox as a queue: an answer takes the letter to wait in a folder until the reply. */
  waiting = $state<Waiting>({ park: false, folder: "", stop_to_archive: false });
  /** Warn when the mailbox fills up. */
  quotaWarn = $state(true);
  /** The own limit for the warnings in GB as typed; empty takes the server's quota. */
  quotaLimitGb = $state("");
  source = $state("");
  notes = $state<string[]>([]);
  busy = $state(false);
  status = $state("");
  error = $state<CmdError | null>(null);
  errorProto = $state<"IMAP" | "SMTP" | "EWS" | null>(null);

  readonly suggested = $derived(this.mode === "imap" ? oauthFor(this.email) : null);
  /** Only providers with an OAuth client in this build or in Preferences get a button. */
  readonly available = $derived(this.providers.filter((p) => p.configured).map((p) => p.provider));
  readonly authHint = $derived(
    this.error?.kind === "auth" && this.mode !== "oauth" && !this.username.includes("\\")
      ? this.mode === "ews"
        ? t("wizard.ewsAuthHint")
        : t("wizard.authHint")
      : "",
  );

  constructor(existing: Account | null, done: () => void) {
    this.existing = existing;
    this.done = done;
    const e = existing;
    if (e) {
      this.mode = e.ews ? "ews" : e.auth?.kind === "oauth" ? "oauth" : "imap";
      this.provider = e.auth?.kind === "oauth" ? e.auth.provider : null;
      this.ewsUrl = e.ews?.url ?? "";
      this.ewsCert = e.ews?.trusted_cert;
      this.step = "settings";
      this.label = e.label ?? "";
      this.color = e.color ?? "";
      this.name = e.display_name;
      this.email = e.email;
      this.username = e.username;
      this.imap = { ...e.imap };
      this.smtp = { ...e.smtp };
      this.saveSent = e.save_sent_copy;
      this.signatures = (e.signatures ?? []).map((s) => ({ ...s }));
      this.defaultSignature = e.default_signature ?? null;
      this.replySignature = e.reply_signature ?? null;
      this.composeFormat = e.compose_format ?? "";
      this.attachmentsDir = e.attachments_dir ?? "";
      if (e.waiting) this.waiting = { ...e.waiting };
      this.quotaWarn = e.quota_warn !== false;
      this.quotaLimitGb = e.quota_limit_mb ? String(Math.round((e.quota_limit_mb / 1024) * 100) / 100).replace(".", ",") : "";
    }
    this.initial = JSON.stringify(this.account());
    api.oauthProviders().then((p) => (this.providers = p)).catch(() => {});
  }

  /** Something was changed and not saved: a field, a password typed or a sign-in made. */
  get dirty(): boolean {
    return !!this.password || !!this.grant || JSON.stringify(this.account()) !== this.initial;
  }

  /** Whether the form may go away: never during a check or a sign-in; with changes, if the user agrees to lose them. */
  async mayLeave(): Promise<boolean> {
    if (this.busy) return false;
    if (!this.dirty) return true;
    return app.confirm({ text: t("account.leaveConfirm"), okLabel: t("account.leaveDiscard"), cancelLabel: t("compose.goBack"), danger: true });
  }

  /** Saving needs a login first: the server, the login or the secret changed. A new mailbox always does. */
  get needsCheck(): boolean {
    return !this.existing || connectionChanged(this.existing, this.account(), this.password, this.grant);
  }

  setSecurity(which: "imap" | "smtp", s: Security) {
    const server = which === "imap" ? this.imap : this.smtp;
    const wasDefault = Object.values(DEFAULT_PORT[which]).includes(server.port);
    server.security = s;
    if (wasDefault) server.port = DEFAULT_PORT[which][s];
    server.trusted_cert = undefined;
  }

  providerTitle(p: OAuthProvider): string {
    return this.providers.find((x) => x.provider === p)?.title ?? { google: "Google", yandex: t("wizard.yandex"), microsoft: "Microsoft" }[p];
  }

  async signIn(p: OAuthProvider) {
    if (this.waitingFor === p) return;
    // Another provider's sign-in still waiting: the user changed their mind, it ends first.
    if (this.attempt) {
      const before = this.attempt;
      this.attempts++;
      api.oauthCancel();
      await before;
    }
    this.attempt = this.signInWith(p);
    await this.attempt;
  }

  private async signInWith(p: OAuthProvider) {
    const seq = ++this.attempts;
    /** A newer sign-in took over: this one leaves the form to it. */
    const superseded = () => seq !== this.attempts;
    this.error = null;
    if (this.providers.length && !this.providers.find((x) => x.provider === p)?.configured) {
      this.error = { kind: "input", message: t("wizard.oauthNotConfigured", { provider: this.providerTitle(p) }) };
      return;
    }
    const existing = this.existing;
    const waiting = t("wizard.waitingBrowser", { provider: this.providerTitle(p) });
    this.busy = true;
    this.waitingFor = p;
    this.status = waiting;
    try {
      const g = await api.oauthSignIn(p, existing?.email ?? (this.email.trim() || null));
      if (superseded()) return;
      if (existing && g.email.toLowerCase() !== existing.email.toLowerCase()) {
        this.error = { kind: "auth", message: t("wizard.otherAccount", { email: g.email, expected: existing.email }) };
        return;
      }
      this.mode = "oauth";
      this.provider = p;
      this.grant = g.id;
      this.email = g.email;
      this.username = g.email;
      if (!this.name.trim() && g.name) this.name = g.name;
      if (!existing) {
        this.imap = g.imap;
        this.smtp = g.smtp;
        this.saveSent = p !== "google";
      }
      this.password = "";
      this.step = "settings";
      this.waitingFor = null;
      await this.checkAndSave();
    } catch (e) {
      if (!superseded()) this.error = asError(e);
    } finally {
      if (!superseded()) {
        this.busy = false;
        this.waitingFor = null;
        this.attempt = null;
        // "Waiting for the browser" is over either way; a check's own words stay with its error.
        if (!this.error || this.status === waiting) this.status = "";
      }
    }
  }

  cancelSignIn() {
    api.oauthCancel();
  }

  startExchange() {
    this.error = null;
    this.mode = "ews";
    if (!this.username) this.username = this.email.trim();
  }

  private async nextExchange() {
    const email = this.email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.error = { kind: "input", message: t("wizard.needEmail") };
      return;
    }
    if (!this.password) {
      this.error = { kind: "input", message: t("wizard.needPasswordPlain") };
      return;
    }
    this.busy = true;
    this.status = t("wizard.detecting");
    try {
      const login = this.username.trim() || email;
      this.username = login;
      const d = await api.exchangeDetect(email, login, this.password, this.ewsServer.trim() || null);
      this.ewsUrl = d.url ?? `https://mail.${email.split("@")[1]}/EWS/Exchange.asmx`;
      this.source = d.source;
      this.notes = d.notes;
      this.saveSent = false;
      this.step = "settings";
    } catch (e) {
      this.error = asError(e);
    } finally {
      this.busy = false;
      this.status = "";
    }
  }

  /** From the address and the password to the detected servers. */
  async next() {
    this.error = null;
    if (this.mode === "ews") return this.nextExchange();
    const email = this.email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.error = { kind: "input", message: t("wizard.needEmail") };
      return;
    }
    if (!this.password) {
      this.error = { kind: "input", message: t("wizard.needPassword") };
      return;
    }
    this.busy = true;
    this.status = t("wizard.detecting");
    try {
      const d = await api.detect(email);
      this.username = d.username || email;
      this.imap = d.imap ?? { host: `mail.${email.split("@")[1]}`, port: 993, security: "tls" };
      this.smtp = d.smtp ?? { host: this.imap.host, port: 587, security: "starttls" };
      this.source = d.source;
      this.notes = d.notes;
      this.step = "settings";
    } catch (e) {
      this.error = asError(e);
    } finally {
      this.busy = false;
      this.status = "";
    }
  }

  account(): Account {
    const acc: Account = {
      id: this.existing?.id ?? "",
      label: this.label.trim(),
      color: this.color,
      display_name: this.name.trim(),
      email: this.email.trim(),
      username: this.username.trim(),
      imap: { ...this.imap, host: this.imap.host.trim(), port: Number(this.imap.port) },
      smtp: { ...this.smtp, host: this.smtp.host.trim(), port: Number(this.smtp.port) },
      save_sent_copy: this.mode === "ews" ? false : this.saveSent,
      signatures: this.signatures.map((s) => ({ ...s })),
      default_signature: this.defaultSignature,
      reply_signature: this.replySignature,
      attachments_dir: this.attachmentsDir.trim(),
      quota_warn: this.quotaWarn,
      quota_limit_mb: limitMb(this.quotaLimitGb),
    };
    if (this.composeFormat) acc.compose_format = this.composeFormat;
    const w = this.waiting;
    if (w.park || w.folder || w.stop_to_archive) acc.waiting = { park: w.park, folder: w.folder, stop_to_archive: w.stop_to_archive };
    if (this.mode === "oauth" && this.provider) acc.auth = { kind: "oauth", provider: this.provider };
    if (this.mode === "ews") acc.ews = { url: this.ewsUrl.trim(), trusted_cert: this.ewsCert };
    return acc;
  }

  /** Checks the login only when the connection changed; the rest is saved as it is. */
  save() {
    return this.needsCheck ? this.checkAndSave() : this.write(false);
  }

  checkAndSave() {
    return this.write(true);
  }

  private async write(check: boolean) {
    const existing = this.existing;
    this.error = null;
    this.errorProto = null;
    this.busy = true;
    this.status = !check ? t("wizard.saving") : this.mode === "ews" ? t("wizard.checkingEws") : t("wizard.checking");
    try {
      const acc = this.account();
      const secret = this.mode === "oauth" ? null : this.password || null;
      if (check) {
        await api.accountCheck(acc, secret, this.grant);
        this.status = t("wizard.saving");
      }
      await api.accountSave(acc, secret, this.grant);
      this.grant = null;
      await app.loadAccounts();
      this.done();
      app.toast(existing ? t("wizard.saved") : t("wizard.added", { email: acc.email }));
      app.scheduleFolders();
      if (!existing && app.accounts.length === 1) app.setView(app.home());
    } catch (e) {
      const error = asError(e);
      this.error = error;
      this.errorProto = error.message.startsWith("SMTP")
        ? "SMTP"
        : error.message.startsWith("IMAP")
          ? "IMAP"
          : error.message.startsWith("EWS")
            ? "EWS"
            : null;
    } finally {
      this.busy = false;
      this.status = "";
    }
  }

  trustCert() {
    const cert = this.error?.cert;
    if (!cert) return;
    if (this.errorProto === "EWS") this.ewsCert = cert.sha256;
    else (this.errorProto === "SMTP" ? this.smtp : this.imap).trusted_cert = cert.sha256;
    this.checkAndSave();
  }

  async allowPlain() {
    const ok = await app.confirm({ title: t("wizard.plainTitle"), text: t("wizard.plainWarning"), okLabel: t("wizard.plainAllow"), danger: true });
    if (!ok) return;
    (this.errorProto === "SMTP" ? this.smtp : this.imap).security = "plain";
    this.checkAndSave();
  }

  async remove() {
    const existing = this.existing;
    if (!existing) return;
    const ok = await app.confirm({ text: t("wizard.removeConfirm", { email: existing.email }), okLabel: t("act.delete"), danger: true });
    if (!ok) return;
    try {
      await api.accountRemove(existing.id);
      await Promise.all([app.loadAccounts(), app.loadFolders()]);
      this.done();
      app.setView(app.home());
    } catch (e) {
      this.error = asError(e);
    }
  }
}
