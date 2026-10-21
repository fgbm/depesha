<script lang="ts">
  // How the mailbox reaches its server, as rows of the general pages (0.8.12, 3.1 А). Its
  // fields are saved by a check only: «Check and save» stands under them, and only once one of
  // them is changed (3.2 А). Enter in a field starts the check, Esc puts the saved ones back.
  import Select from "../Select.svelte";
  import SettingsRow from "../prefs/SettingsRow.svelte";
  import Switch from "../prefs/controls/Switch.svelte";
  import { t } from "../../lib/i18n.svelte";
  import { fingerprint } from "../../lib/accountForm.svelte";
  import type { Security, ServerConfig } from "../../lib/types";
  import { PROVIDER_LOGO } from "./logos";
  import CheckError from "./CheckError.svelte";
  import type { SectionProps } from "./sections";

  let { form }: SectionProps = $props();

  const SECURITY = [
    { value: "tls" as Security, label: "SSL/TLS" },
    { value: "starttls" as Security, label: "STARTTLS" },
    { value: "plain" as Security, label: t("wizard.noEncryption") },
  ];

  const pending = $derived(form.connectionDirty || form.busy);

  function onKey(e: KeyboardEvent) {
    if (!(e.target instanceof HTMLInputElement) || !form.connectionDirty || form.busy) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void form.checkAndSave();
    } else if (e.key === "Escape") {
      // The field's Esc, not the window's: the window stays open.
      e.preventDefault();
      e.stopPropagation();
      form.revertConnection();
    }
  }
</script>

<!-- The keys of the fields bubble here: Enter checks the changed connection, Esc takes the change back. -->
<div class="connection" role="presentation" onkeydown={onKey}>
  {#if form.mode === "oauth" && form.provider}
    {@const p = form.provider}
    <SettingsRow id="acc-login" kind="field" label={t("wizard.signIn")}>
      <span class="provider"><img src={PROVIDER_LOGO[p]} alt="" width="18" height="18" />{form.grant ? t("wizard.signedInWith", { provider: form.providerTitle(p) }) : t("wizard.viaProvider", { provider: form.providerTitle(p) })}</span>
      <button class="btn ghost" onclick={() => form.signIn(p)} disabled={form.busy}>{t("wizard.signInAgain")}</button>
    </SettingsRow>
  {:else}
    <SettingsRow id="acc-login" kind="field" label={t("wizard.login")}>
      <input class="input text" bind:value={form.username} placeholder={t("wizard.loginPlaceholder")} aria-label={t("wizard.login")} />
    </SettingsRow>
    <SettingsRow id="acc-password" kind="field" label={t("wizard.password")}>
      <input class="input text" type="password" bind:value={form.password} placeholder={t("account.passwordKept")} aria-label={t("wizard.password")} />
    </SettingsRow>
  {/if}

  {#if form.mode === "ews"}
    <SettingsRow id="acc-ews" kind="field" label={t("wizard.ewsUrl")} hint={t("wizard.ewsNote")}>
      <input class="input text" bind:value={form.ewsUrl} placeholder="https://mail.company.ru/EWS/Exchange.asmx" aria-label={t("wizard.ewsUrl")} />
      {#if form.ewsCert}<span class="muted small">{t("wizard.trusted")} {fingerprint(form.ewsCert).slice(0, 23)}…
        <button class="link" onclick={() => (form.ewsCert = undefined)}>{t("wizard.forget")}</button></span>{/if}
    </SettingsRow>
  {:else}
    {#each [["imap", t("wizard.incoming"), form.imap], ["smtp", t("wizard.outgoing"), form.smtp]] as [key, title, server] (key)}
      {@const s = server as ServerConfig}
      <SettingsRow id="acc-{key}" kind="field" label={title as string} warn={s.security === "plain" ? t("wizard.plainNote") : null}>
        <input class="input host" bind:value={s.host} aria-label="{title} · {t('wizard.server')}" />
        <input class="input port" type="number" bind:value={s.port} aria-label="{title} · {t('wizard.port')}" />
        <Select class="security" label="{title} · {t('wizard.security')}" value={s.security} options={SECURITY} onchange={(v) => form.setSecurity(key as "imap" | "smtp", v)} />
        {#if s.trusted_cert}<span class="muted small">{t("wizard.trusted")} {fingerprint(s.trusted_cert).slice(0, 23)}…
          <button class="link" onclick={() => (s.trusted_cert = undefined)}>{t("wizard.forget")}</button></span>{/if}
      </SettingsRow>
    {/each}
    <SettingsRow id="acc-sent" kind="toggle" label={t("account.saveSent")} hint={t("account.saveSentNote")}>
      <Switch checked={form.saveSent} label={t("account.saveSent")} onchange={(on) => (form.saveSent = on)} />
    </SettingsRow>
  {/if}

  <CheckError {form} />
  {#if form.status}
    <p class="muted status">{form.status}
      {#if form.waitingBrowser}<button class="link" onclick={() => form.cancelSignIn()}>{t("cancel")}</button>{/if}</p>
  {/if}

  {#if pending}
    <div class="check">
      <span class="muted pending">{t("account.connectionPending")}</span>
      <div class="buttons">
        <button class="btn primary" onclick={() => form.checkAndSave()} disabled={form.busy}>
          {form.busy ? t("wizard.checkingShort") : t("wizard.checkAndSave")}
        </button>
        <button class="btn ghost" onclick={() => form.revertConnection()} disabled={form.busy}>{t("cancel")}</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .text {
    width: 300px;
    max-width: 100%;
  }

  .host {
    width: 150px;
    max-width: 100%;
  }

  .port {
    width: 78px;
  }

  .provider {
    display: inline-flex;
    align-items: center;
    gap: 8px;
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

  .status {
    margin: 6px 0 0 266px;
  }

  /* Under the fields, level with the controls: the check and its way back (3.2 А). */
  .check {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 4px 0 0 266px;
  }

  .pending {
    font-size: 12.5px;
  }

  .buttons {
    display: flex;
    gap: 8px;
  }

  @container (max-width: 470px) {
    .status,
    .check {
      margin-left: 0;
    }
  }
</style>
