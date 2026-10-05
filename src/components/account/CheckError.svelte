<script lang="ts">
  // Why the check or the save failed, with what can be done about it there and then:
  // trust the server's certificate, allow a server without encryption.
  import { t } from "../../lib/i18n.svelte";
  import { longDate } from "../../lib/format";
  import { fingerprint, type AccountForm } from "../../lib/accountForm.svelte";

  let { form }: { form: AccountForm } = $props();
</script>

{#if form.error}
  {@const error = form.error}
  <div class="error selectable">
    <p><b>{error.message}</b></p>
    {#if form.authHint}<p>{form.authHint}</p>{/if}
    {#if error.kind === "certificate" && error.cert}
      <dl>
        <dt>{t("wizard.server")}</dt><dd>{error.cert.host}</dd>
        <dt>{t("wizard.issuedTo")}</dt><dd>{error.cert.subject || "—"}</dd>
        <dt>{t("wizard.issuedBy")}</dt><dd>{error.cert.issuer || "—"}</dd>
        <dt>{t("wizard.validUntil")}</dt><dd>{error.cert.not_after ? longDate(error.cert.not_after) : "—"}</dd>
        <dt>SHA-256</dt><dd class="mono">{fingerprint(error.cert.sha256)}</dd>
      </dl>
      <p class="muted small">{t("wizard.trustNote")}</p>
      <button class="btn" onclick={() => form.trustCert()} disabled={form.busy}>{t("wizard.trust")}</button>
    {:else if error.kind === "no-tls" && form.mode !== "ews"}
      <p class="muted small">{t("wizard.noTlsNote")}</p>
      <button class="btn ghost" onclick={() => form.allowPlain()} disabled={form.busy}>{t("wizard.allowPlain")}</button>
    {:else if error.kind === "imap-unavailable"}
      <p class="muted small">{t("wizard.imapNote")}</p>
    {/if}
  </div>
{/if}

<style>
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

  .small {
    font-size: 12px;
  }
</style>
