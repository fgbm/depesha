<script lang="ts">
  // How the mailbox reaches its server: the login, Exchange's address or the IMAP and SMTP
  // servers, and the copy of sent mail. The same fields in the wizard and on the mailbox's page.
  import Select from "../Select.svelte";
  import { t } from "../../lib/i18n.svelte";
  import { fingerprint, type AccountForm } from "../../lib/accountForm.svelte";
  import { PROVIDER_LOGO } from "./logos";
  import type { Security, ServerConfig } from "../../lib/types";

  let { form }: { form: AccountForm } = $props();
</script>

<div class="connection">
  <div class="grid">
    {#if form.mode === "oauth" && form.provider}
      {@const p = form.provider}
      <div class="field signed">
        <span>{t("wizard.signIn")}</span>
        <div class="signed-row">
          <span class="provider"><img src={PROVIDER_LOGO[p]} alt="" width="18" height="18" />{form.grant ? t("wizard.signedInWith", { provider: form.providerTitle(p) }) : t("wizard.viaProvider", { provider: form.providerTitle(p) })}</span>
          <button class="btn ghost" onclick={() => form.signIn(p)} disabled={form.busy}>{t("wizard.signInAgain")}</button>
        </div>
      </div>
    {:else}
      <label class="field"><span>{t("wizard.login")}</span><input class="input" bind:value={form.username} placeholder={t("wizard.loginPlaceholder")} /></label>
      <label class="field"><span>{form.existing ? t("wizard.passwordKeep") : t("wizard.password")}</span><input class="input" type="password" bind:value={form.password} /></label>
    {/if}
  </div>

  {#if form.mode === "ews"}
    <fieldset>
      <legend>{t("wizard.exchangeLegend")}</legend>
      <label class="field"><span>{t("wizard.ewsUrl")}</span><input class="input" bind:value={form.ewsUrl} placeholder="https://mail.company.ru/EWS/Exchange.asmx" /></label>
      {#if form.ewsCert}<p class="muted small">{t("wizard.trusted")} {fingerprint(form.ewsCert).slice(0, 23)}…
        <button class="link" onclick={() => (form.ewsCert = undefined)}>{t("wizard.forget")}</button></p>{/if}
      <p class="muted small">{t("wizard.ewsNote")}</p>
    </fieldset>
  {/if}

  {#each (form.mode === "ews" ? [] : [["imap", t("wizard.incoming"), form.imap], ["smtp", t("wizard.outgoing"), form.smtp]]) as [key, title, server] (key)}
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
            onchange={(v) => form.setSecurity(key as "imap" | "smtp", v)}
          />
        </div>
      </div>
      {#if s.security === "plain"}<p class="note">⚠ {t("wizard.plainNote")}</p>{/if}
      {#if s.trusted_cert}<p class="muted small">{t("wizard.trusted")} {fingerprint(s.trusted_cert).slice(0, 23)}…
        <button class="link" onclick={() => (s.trusted_cert = undefined)}>{t("wizard.forget")}</button></p>{/if}
    </fieldset>
  {/each}

  {#if form.mode !== "ews"}<label class="check"><input type="checkbox" bind:checked={form.saveSent} /> {t("wizard.saveSent")}</label>{/if}
</div>

<style>
  .connection {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .signed {
    grid-column: 1 / -1;
  }

  .signed-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 32px;
  }

  .provider {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .provider img {
    flex: none;
  }

  fieldset {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 12px 10px;
    margin: 0;
    min-width: 0;
  }

  legend {
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    padding: 0 4px;
  }

  fieldset p {
    margin: 6px 0 0;
  }

  .server {
    display: flex;
    gap: 8px;
  }

  .host {
    flex: 1;
    min-width: 0;
  }

  .port {
    width: 84px;
  }

  .sec {
    width: 200px;
  }

  .note {
    padding: 8px 10px;
    background: color-mix(in srgb, var(--warn) 12%, var(--paper));
    border-radius: 6px;
    font-size: 13px;
    line-height: 1.4;
  }

  .check {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    font-size: 13px;
    line-height: 1.4;
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

  /* A narrow window: one field under another, the server's three in two rows. */
  @media (max-width: 640px) {
    .grid {
      grid-template-columns: 1fr;
    }

    .server {
      flex-wrap: wrap;
    }

    .host {
      flex-basis: 100%;
    }

    .sec {
      flex: 1;
      width: auto;
    }
  }
</style>
