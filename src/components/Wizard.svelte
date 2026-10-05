<script lang="ts">
  import { app } from "../lib/store.svelte";
  import Select from "./Select.svelte";
  import FolderPicker from "./FolderPicker.svelte";
  import { api, asError } from "../lib/api";
  import { longDate } from "../lib/format";
  import { t } from "../lib/i18n.svelte";
  import type { Account, CmdError, OAuthProvider, OAuthProviderView, Security, ServerConfig } from "../lib/types";
  // Official marks: Google and Yandex from Wikimedia Commons, Microsoft from its Entra branding guide.
  import googleLogo from "../assets/providers/google.svg";
  import yandexLogo from "../assets/providers/yandex.svg";
  import microsoftLogo from "../assets/providers/microsoft.svg";

  const LOGO: Record<OAuthProvider, string> = { google: googleLogo, yandex: yandexLogo, microsoft: microsoftLogo };

  let {
    embedded = false,
    mailbox = null,
    onDone,
  }: {
    /** A page of the settings window, not a window of its own. */
    embedded?: boolean;
    /** The mailbox a settings page is about; the window takes `app.wizard`'s. */
    mailbox?: Account | null;
    /** Saved or removed: the settings window goes back to its list of mailboxes. */
    onDone?: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  const existing = embedded ? mailbox : (app.wizard?.account ?? null);

  function done() {
    if (embedded) onDone?.();
    else app.wizard = null;
  }

  /** `imap`: password over IMAP and SMTP; `oauth`: browser sign-in; `ews`: Exchange Web Services. */
  let mode = $state<"imap" | "oauth" | "ews">(
    existing?.ews ? "ews" : existing?.auth?.kind === "oauth" ? "oauth" : "imap",
  );
  let provider = $state<OAuthProvider | null>(existing?.auth?.kind === "oauth" ? existing.auth.provider : null);
  /** A browser sign-in not saved yet. */
  let grant = $state<string | null>(null);
  let providers = $state<OAuthProviderView[]>([]);
  let waitingBrowser = $state(false);
  let ewsUrl = $state(existing?.ews?.url ?? "");
  let ewsCert = $state<string | undefined>(existing?.ews?.trusted_cert);
  let ewsServer = $state("");

  api.oauthProviders().then((p) => (providers = p)).catch(() => {});

  let step = $state<"start" | "settings">(existing ? "settings" : "start");
  let name = $state(existing?.display_name ?? "");
  let label = $state(existing?.label ?? "");
  let email = $state(existing?.email ?? "");
  let password = $state("");
  let username = $state(existing?.username ?? "");
  let imap = $state<ServerConfig>(existing ? { ...existing.imap } : { host: "", port: 993, security: "tls" });
  let smtp = $state<ServerConfig>(existing ? { ...existing.smtp } : { host: "", port: 587, security: "starttls" });
  let saveSent = $state(existing?.save_sent_copy ?? true);
  let signature = $state(existing?.signature ?? "");
  let attachmentsDir = $state(existing?.attachments_dir ?? "");
  let source = $state("");
  let notes = $state<string[]>([]);
  let busy = $state(false);
  let status = $state("");
  let error = $state<CmdError | null>(null);
  let errorProto = $state<"IMAP" | "SMTP" | "EWS" | null>(null);

  const DEFAULT_PORT: Record<"imap" | "smtp", Record<Security, number>> = {
    imap: { tls: 993, starttls: 143, plain: 143 },
    smtp: { tls: 465, starttls: 587, plain: 25 },
  };

  function setSecurity(which: "imap" | "smtp", s: Security) {
    const server = which === "imap" ? imap : smtp;
    const wasDefault = Object.values(DEFAULT_PORT[which]).includes(server.port);
    server.security = s;
    if (wasDefault) server.port = DEFAULT_PORT[which][s];
    server.trusted_cert = undefined;
  }

  /** Mail domains whose provider wants OAuth rather than a password. */
  function oauthFor(address: string): OAuthProvider | null {
    const domain = address.split("@")[1]?.trim().toLowerCase() ?? "";
    if (["gmail.com", "googlemail.com"].includes(domain)) return "google";
    if (["yandex.ru", "ya.ru", "yandex.com", "yandex.by", "yandex.kz", "narod.ru"].includes(domain)) return "yandex";
    if (["outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.ru", "hotmail.ru", "live.ru"].includes(domain)) return "microsoft";
    return null;
  }

  const suggested = $derived(mode === "imap" ? oauthFor(email) : null);
  /** Only providers with an OAuth client in this build or in Preferences get a button. */
  const available = $derived(providers.filter((p) => p.configured).map((p) => p.provider));

  function providerTitle(p: OAuthProvider): string {
    return providers.find((x) => x.provider === p)?.title ?? { google: "Google", yandex: t("wizard.yandex"), microsoft: "Microsoft" }[p];
  }

  async function signIn(p: OAuthProvider) {
    error = null;
    if (providers.length && !providers.find((x) => x.provider === p)?.configured) {
      error = { kind: "input", message: t("wizard.oauthNotConfigured", { provider: providerTitle(p) }) };
      return;
    }
    busy = true;
    waitingBrowser = true;
    status = t("wizard.waitingBrowser", { provider: providerTitle(p) });
    try {
      const g = await api.oauthSignIn(p, existing?.email ?? (email.trim() || null));
      if (existing && g.email.toLowerCase() !== existing.email.toLowerCase()) {
        error = { kind: "auth", message: t("wizard.otherAccount", { email: g.email, expected: existing.email }) };
        return;
      }
      mode = "oauth";
      provider = p;
      grant = g.id;
      email = g.email;
      username = g.email;
      if (!name.trim() && g.name) name = g.name;
      if (!existing) {
        imap = g.imap;
        smtp = g.smtp;
        saveSent = p !== "google";
      }
      password = "";
      step = "settings";
      waitingBrowser = false;
      await checkAndSave();
    } catch (e) {
      error = asError(e);
    } finally {
      busy = false;
      waitingBrowser = false;
      if (!error) status = "";
    }
  }

  function cancelSignIn() {
    api.oauthCancel();
  }

  function startExchange() {
    error = null;
    mode = "ews";
    if (!username) username = email.trim();
  }

  async function nextExchange() {
    error = null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      error = { kind: "input", message: t("wizard.needEmail") };
      return;
    }
    if (!password) {
      error = { kind: "input", message: t("wizard.needPasswordPlain") };
      return;
    }
    busy = true;
    status = t("wizard.detecting");
    try {
      const login = username.trim() || email.trim();
      username = login;
      const d = await api.exchangeDetect(email.trim(), login, password, ewsServer.trim() || null);
      ewsUrl = d.url ?? `https://mail.${email.split("@")[1]}/EWS/Exchange.asmx`;
      source = d.source;
      notes = d.notes;
      saveSent = false;
      step = "settings";
    } finally {
      busy = false;
      status = "";
    }
  }

  async function next() {
    error = null;
    if (mode === "ews") return nextExchange();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      error = { kind: "input", message: t("wizard.needEmail") };
      return;
    }
    if (!password) {
      error = { kind: "input", message: t("wizard.needPassword") };
      return;
    }
    busy = true;
    status = t("wizard.detecting");
    try {
      const d = await api.detect(email.trim());
      username = d.username || email.trim();
      if (d.imap) imap = d.imap;
      else imap = { host: `mail.${email.split("@")[1]}`, port: 993, security: "tls" };
      if (d.smtp) smtp = d.smtp;
      else smtp = { host: imap.host, port: 587, security: "starttls" };
      source = d.source;
      notes = d.notes;
      step = "settings";
    } finally {
      busy = false;
      status = "";
    }
  }

  function account(): Account {
    const acc: Account = {
      id: existing?.id ?? "",
      label: label.trim(),
      display_name: name.trim(),
      email: email.trim(),
      username: username.trim(),
      imap: { ...imap, host: imap.host.trim(), port: Number(imap.port) },
      smtp: { ...smtp, host: smtp.host.trim(), port: Number(smtp.port) },
      save_sent_copy: mode === "ews" ? false : saveSent,
      signature,
      attachments_dir: attachmentsDir.trim(),
    };
    if (mode === "oauth" && provider) acc.auth = { kind: "oauth", provider };
    if (mode === "ews") acc.ews = { url: ewsUrl.trim(), trusted_cert: ewsCert };
    return acc;
  }

  async function checkAndSave() {
    error = null;
    errorProto = null;
    busy = true;
    status = mode === "ews" ? t("wizard.checkingEws") : t("wizard.checking");
    try {
      const acc = account();
      const secret = mode === "oauth" ? null : password || null;
      await api.accountCheck(acc, secret, grant);
      status = t("wizard.saving");
      await api.accountSave(acc, secret, grant);
      grant = null;
      await app.loadAccounts();
      done();
      app.toast(existing ? t("wizard.saved") : t("wizard.added", { email: acc.email }));
      app.scheduleFolders();
      if (!existing && app.accounts.length === 1) app.setView(app.home());
    } catch (e) {
      error = asError(e);
      errorProto = error.message.startsWith("SMTP")
        ? "SMTP"
        : error.message.startsWith("IMAP")
          ? "IMAP"
          : error.message.startsWith("EWS")
            ? "EWS"
            : null;
    } finally {
      busy = false;
      status = "";
    }
  }

  function trustCert() {
    if (!error?.cert) return;
    if (errorProto === "EWS") {
      ewsCert = error.cert.sha256;
      checkAndSave();
      return;
    }
    const target = errorProto === "SMTP" ? smtp : imap;
    target.trusted_cert = error.cert.sha256;
    checkAndSave();
  }

  async function allowPlain() {
    const ok = await app.confirm({ title: t("wizard.plainTitle"), text: t("wizard.plainWarning"), okLabel: t("wizard.plainAllow"), danger: true });
    if (!ok) return;
    const target = errorProto === "SMTP" ? smtp : imap;
    target.security = "plain";
    checkAndSave();
  }

  async function removeAccount() {
    if (!existing) return;
    const ok = await app.confirm({ text: t("wizard.removeConfirm", { email: existing.email }), okLabel: t("act.delete"), danger: true });
    if (!ok) return;
    try {
      await api.accountRemove(existing.id);
      await Promise.all([app.loadAccounts(), app.loadFolders()]);
      done();
      app.setView(app.home());
    } catch (e) {
      error = asError(e);
    }
  }

  function fingerprint(sha: string): string {
    return sha.toUpperCase().match(/.{1,2}/g)?.join(":") ?? sha;
  }

  const authHint = $derived(
    error?.kind === "auth" && mode !== "oauth" && !username.includes("\\")
      ? mode === "ews"
        ? t("wizard.ewsAuthHint")
        : t("wizard.authHint")
      : "",
  );
</script>

{#snippet form()}
    <div class="content">
      {#if step === "start" && mode !== "ews"}
        <p class="muted lead">{t("wizard.lead")}</p>
        {#if available.length}
          <div class="oauth">
            {#each available as p (p)}
              <button class="btn" onclick={() => signIn(p)} disabled={busy}>
                <img src={LOGO[p]} alt="" width="18" height="18" />{t("wizard.signInWith", { provider: providerTitle(p) })}
              </button>
            {/each}
          </div>
          <p class="muted small or">{t("wizard.orPassword")}</p>
        {/if}
        <label class="field"><span>{t("wizard.yourName")}</span><input class="input" bind:value={name} placeholder={t("wizard.namePlaceholder")} /></label>
        <label class="field"><span>{t("wizard.email")}</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input class="input" bind:value={email} type="email" autofocus placeholder={t("wizard.emailPlaceholder")} onkeydown={(e) => e.key === "Enter" && next()} />
        </label>
        {#if suggested && available.includes(suggested)}<p class="note">{t("wizard.oauthSuggested", { provider: providerTitle(suggested) })}</p>
        <!-- Outlook.com has no app passwords any more: without OAuth there is nothing to suggest. -->
        {:else if suggested && suggested !== "microsoft" && providers.length}<p class="note">{t("wizard.appPasswordSuggested", { provider: providerTitle(suggested) })}</p>{/if}
        <label class="field"><span>{t("wizard.password")}</span><input class="input" bind:value={password} type="password" onkeydown={(e) => e.key === "Enter" && next()} /></label>
        <p class="small"><button class="link" onclick={startExchange} disabled={busy}>{t("wizard.exchangeLink")}</button></p>
      {:else if step === "start"}
        <p class="muted lead">{t("wizard.exchangeLead")}</p>
        <label class="field"><span>{t("wizard.yourName")}</span><input class="input" bind:value={name} placeholder={t("wizard.namePlaceholder")} /></label>
        <label class="field"><span>{t("wizard.email")}</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input class="input" bind:value={email} type="email" autofocus placeholder={t("wizard.emailPlaceholder")} />
        </label>
        <div class="grid">
          <label class="field"><span>{t("wizard.login")}</span><input class="input" bind:value={username} placeholder={t("wizard.loginPlaceholder")} /></label>
          <label class="field"><span>{t("wizard.password")}</span><input class="input" bind:value={password} type="password" onkeydown={(e) => e.key === "Enter" && next()} /></label>
        </div>
        <label class="field"><span>{t("wizard.exchangeServer")}</span><input class="input" bind:value={ewsServer} placeholder={t("wizard.exchangeServerPlaceholder")} onkeydown={(e) => e.key === "Enter" && next()} /></label>
        <p class="small"><button class="link" onclick={() => (mode = "imap")} disabled={busy}>{t("wizard.back")}</button></p>
      {:else}
        {#if source}<p class="muted lead">{t("wizard.found", { source })}</p>{/if}
        {#each notes as n (n)}<p class="note">⚠ {n}</p>{/each}

        <div class="grid">
          <label class="field"><span>{t("wizard.mailboxName")}</span><input class="input" bind:value={label} placeholder={email.trim() || t("wizard.mailboxNamePlaceholder")} /></label>
          <label class="field"><span>{t("wizard.name")}</span><input class="input" bind:value={name} placeholder={t("wizard.namePlaceholder")} /></label>
          <label class="field wide"><span>{t("wizard.address")}</span><input class="input" bind:value={email} disabled={!!existing} /></label>
          {#if mode === "oauth" && provider}
            <div class="field signed">
              <span>{t("wizard.signIn")}</span>
              <div class="signed-row">
                <span class="provider"><img src={LOGO[provider]} alt="" width="18" height="18" />{grant ? t("wizard.signedInWith", { provider: providerTitle(provider) }) : t("wizard.viaProvider", { provider: providerTitle(provider) })}</span>
                <button class="btn ghost" onclick={() => provider && signIn(provider)} disabled={busy}>{t("wizard.signInAgain")}</button>
              </div>
            </div>
          {:else}
            <label class="field"><span>{t("wizard.login")}</span><input class="input" bind:value={username} placeholder={t("wizard.loginPlaceholder")} /></label>
            <label class="field"><span>{existing ? t("wizard.passwordKeep") : t("wizard.password")}</span><input class="input" type="password" bind:value={password} /></label>
          {/if}
        </div>

        {#if mode === "ews"}
          <fieldset>
            <legend>{t("wizard.exchangeLegend")}</legend>
            <label class="field"><span>{t("wizard.ewsUrl")}</span><input class="input" bind:value={ewsUrl} placeholder="https://mail.company.ru/EWS/Exchange.asmx" /></label>
            {#if ewsCert}<p class="muted small">{t("wizard.trusted")} {fingerprint(ewsCert).slice(0, 23)}…
              <button class="link" onclick={() => (ewsCert = undefined)}>{t("wizard.forget")}</button></p>{/if}
            <p class="muted small">{t("wizard.ewsNote")}</p>
          </fieldset>
        {/if}

        {#each (mode === "ews" ? [] : [["imap", t("wizard.incoming"), imap], ["smtp", t("wizard.outgoing"), smtp]]) as [key, title, server] (key)}
          {@const s = server as ServerConfig}
          <fieldset>
            <legend>{title}</legend>
            <div class="server">
              <label class="field host"><span>{t("wizard.server")}</span><input class="input" bind:value={s.host} /></label>
              <label class="field port"><span>{t("wizard.port")}</span><input class="input" type="number" bind:value={s.port} /></label>
              <div class="field sec"><span>{t("wizard.security")}</span>
                <Select
                  class="security"
                  label={t("wizard.security")}
                  value={s.security}
                  options={[
                    { value: "tls" as Security, label: "SSL/TLS" },
                    { value: "starttls" as Security, label: "STARTTLS" },
                    { value: "plain" as Security, label: t("wizard.noEncryption") },
                  ]}
                  onchange={(v) => setSecurity(key as "imap" | "smtp", v)}
                />
              </div>
            </div>
            {#if s.security === "plain"}<p class="note">⚠ {t("wizard.plainNote")}</p>{/if}
            {#if s.trusted_cert}<p class="muted small">{t("wizard.trusted")} {fingerprint(s.trusted_cert).slice(0, 23)}…
              <button class="link" onclick={() => (s.trusted_cert = undefined)}>{t("wizard.forget")}</button></p>{/if}
          </fieldset>
        {/each}

        <label class="field"><span>{t("wizard.signature")}</span>
          <textarea class="input sig" bind:value={signature} rows="3" placeholder={t("wizard.signaturePlaceholder")}></textarea>
        </label>

        <div class="field"><span>{t("wizard.attachmentsDir")}</span>
          <!-- The settings' folder is a hint, not the value: what is inherited stays visible as such. -->
          <FolderPicker bind:value={attachmentsDir} label={t("wizard.attachmentsDir")} placeholder={app.settings.attachments_dir || t("settings.askEveryTime")} />
          <p class="muted small inherit">{t("wizard.attachmentsDirInherit", { dir: app.settings.attachments_dir ? `: ${app.settings.attachments_dir}` : "" })}</p>
        </div>

        {#if mode !== "ews"}<label class="check"><input type="checkbox" bind:checked={saveSent} /> {t("wizard.saveSent")}</label>{/if}
      {/if}

      {#if error}
        <div class="error selectable">
          <p><b>{error.message}</b></p>
          {#if authHint}<p>{authHint}</p>{/if}
          {#if error.kind === "certificate" && error.cert}
            <dl>
              <dt>{t("wizard.server")}</dt><dd>{error.cert.host}</dd>
              <dt>{t("wizard.issuedTo")}</dt><dd>{error.cert.subject || "—"}</dd>
              <dt>{t("wizard.issuedBy")}</dt><dd>{error.cert.issuer || "—"}</dd>
              <dt>{t("wizard.validUntil")}</dt><dd>{error.cert.not_after ? longDate(error.cert.not_after) : "—"}</dd>
              <dt>SHA-256</dt><dd class="mono">{fingerprint(error.cert.sha256)}</dd>
            </dl>
            <p class="muted small">{t("wizard.trustNote")}</p>
            <button class="btn" onclick={trustCert} disabled={busy}>{t("wizard.trust")}</button>
          {:else if error.kind === "no-tls" && mode !== "ews"}
            <p class="muted small">{t("wizard.noTlsNote")}</p>
            <button class="btn ghost" onclick={allowPlain} disabled={busy}>{t("wizard.allowPlain")}</button>
          {:else if error.kind === "imap-unavailable"}
            <p class="muted small">{t("wizard.imapNote")}</p>
          {/if}
        </div>
      {/if}
      {#if status}<p class="muted">{status}
        {#if waitingBrowser}<button class="link" onclick={cancelSignIn}>{t("cancel")}</button>{/if}</p>{/if}
    </div>

    <footer>
      {#if existing}<button class="btn ghost danger-text" onclick={removeAccount} disabled={busy}>{t("wizard.remove")}</button>{/if}
      <span class="spacer"></span>
      {#if step === "start"}
        <button class="btn primary" onclick={next} disabled={busy || waitingBrowser}>{t("wizard.next")}</button>
      {:else}
        {#if !existing}<button class="btn ghost" onclick={() => (step = "start")} disabled={busy}>{t("wizard.back")}</button>{/if}
        <button class="btn primary" onclick={checkAndSave} disabled={busy}>{busy ? t("wizard.checkingShort") : t("wizard.checkAndSave")}</button>
      {/if}
    </footer>
{/snippet}

{#if embedded}
  <div class="wizard embedded" role="group" aria-label={existing ? existing.email : t("cmd.addAccount")}>
    {@render form()}
  </div>
{:else}
<div class="modal-backdrop" role="presentation">
  <div class="modal wizard" role="dialog" aria-label={t("wizard.label")}>
    <header>
      <h3>{existing ? t("wizard.editTitle", { email: existing.email }) : t("cmd.addAccount")}</h3>
      {#if app.accounts.length > 0 || existing}
        <button class="btn ghost" onclick={() => (app.wizard = null)} disabled={busy}>×</button>
      {/if}
    </header>

    {@render form()}
  </div>
</div>
{/if}

<style>
  .wizard {
    width: min(640px, calc(100vw - 40px));
  }

  /* In the settings window: its page scrolls, the buttons stay at the bottom. */
  .wizard.embedded {
    width: auto;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .embedded .content {
    flex: 1;
    min-height: 0;
    padding: 4px 24px 12px;
  }

  .embedded footer {
    padding-left: 24px;
    padding-right: 24px;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 14px 4px 22px;
  }

  h3 {
    margin: 0;
    font-size: 17px;
  }

  .content {
    padding: 8px 22px 12px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .lead {
    margin: 0;
    line-height: 1.45;
  }

  .note {
    margin: 0;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--warn) 12%, var(--paper));
    border-radius: 6px;
    font-size: 13px;
    line-height: 1.4;
  }

  .oauth {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .oauth .btn {
    flex: 1;
    min-width: 150px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .oauth img,
  .provider img {
    flex: none;
  }

  .provider {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .or {
    margin: 2px 0 -4px;
  }

  .signed-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 32px;
  }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .grid .wide {
    grid-column: 1 / -1;
  }

  fieldset {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 12px 10px;
    margin: 0;
  }

  legend {
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    padding: 0 4px;
  }

  .server {
    display: flex;
    gap: 8px;
  }

  .host {
    flex: 1;
  }

  .port {
    width: 84px;
  }

  .sec {
    width: 200px;
  }

  /* Capped so the resize handle never slides under the footer; longer text scrolls inside. */
  .sig {
    resize: vertical;
    font: inherit;
    line-height: 1.4;
    /* 3 to 8 lines plus padding and border */
    min-height: calc(4.2em + 14px);
    max-height: calc(11.2em + 14px);
  }

  .check {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    font-size: 13px;
    line-height: 1.4;
  }

  .error {
    border-left: 4px solid var(--accent);
    background: color-mix(in srgb, var(--accent) 7%, var(--paper));
    padding: 10px 14px;
    border-radius: 6px;
    line-height: 1.45;
  }

  .error p {
    margin: 0 0 6px;
  }

  dl {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 3px 10px;
    margin: 6px 0 8px;
    font-size: 13px;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .mono {
    font-family: var(--mono);
    font-size: 12px;
  }

  .inherit {
    margin: 0;
  }

  .small {
    font-size: 12px;
  }

  .link {
    border: none;
    background: none;
    color: var(--link);
    padding: 0;
    text-decoration: underline;
  }

  footer {
    display: flex;
    gap: 8px;
    padding: 12px 22px 16px;
    border-top: 1px solid var(--line);
  }

  .spacer {
    flex: 1;
  }
</style>
