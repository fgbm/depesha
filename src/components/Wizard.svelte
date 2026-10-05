<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { t } from "../lib/i18n.svelte";
  import { AccountForm } from "../lib/accountForm.svelte";
  import ConnectionFields from "./account/ConnectionFields.svelte";
  import CheckError from "./account/CheckError.svelte";
  import SignatureField from "./account/SignatureField.svelte";
  import AttachmentsDirField from "./account/AttachmentsDirField.svelte";
  import { PROVIDER_LOGO } from "./account/logos";

  let {
    embedded = false,
    onDone,
  }: {
    /** A page of the settings window, not a window of its own. */
    embedded?: boolean;
    /** Saved: the settings window goes back to its list of mailboxes. */
    onDone?: () => void;
  } = $props();

  /** A new mailbox; an existing one is edited on its page in the settings (account/AccountPage). */
  // svelte-ignore state_referenced_locally
  const form = new AccountForm(embedded ? null : (app.wizard?.account ?? null), () => {
    if (embedded) onDone?.();
    else app.wizard = null;
  });
  const existing = form.existing;
</script>

{#snippet body()}
    <div class="content">
      {#if form.step === "start" && form.mode !== "ews"}
        <p class="muted lead">{t("wizard.lead")}</p>
        {#if form.available.length}
          <div class="oauth">
            {#each form.available as p (p)}
              <button class="btn" onclick={() => form.signIn(p)} disabled={form.busy}>
                <img src={PROVIDER_LOGO[p]} alt="" width="18" height="18" />{t("wizard.signInWith", { provider: form.providerTitle(p) })}
              </button>
            {/each}
          </div>
          <p class="muted small or">{t("wizard.orPassword")}</p>
        {/if}
        <label class="field"><span>{t("wizard.yourName")}</span><input class="input" bind:value={form.name} placeholder={t("wizard.namePlaceholder")} /></label>
        <label class="field"><span>{t("wizard.email")}</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input class="input" bind:value={form.email} type="email" autofocus placeholder={t("wizard.emailPlaceholder")} onkeydown={(e) => e.key === "Enter" && form.next()} />
        </label>
        {#if form.suggested && form.available.includes(form.suggested)}<p class="note">{t("wizard.oauthSuggested", { provider: form.providerTitle(form.suggested) })}</p>
        <!-- Outlook.com has no app passwords any more: without OAuth there is nothing to suggest. -->
        {:else if form.suggested && form.suggested !== "microsoft" && form.providers.length}<p class="note">{t("wizard.appPasswordSuggested", { provider: form.providerTitle(form.suggested) })}</p>{/if}
        <label class="field"><span>{t("wizard.password")}</span><input class="input" bind:value={form.password} type="password" onkeydown={(e) => e.key === "Enter" && form.next()} /></label>
        <p class="small"><button class="link" onclick={() => form.startExchange()} disabled={form.busy}>{t("wizard.exchangeLink")}</button></p>
      {:else if form.step === "start"}
        <p class="muted lead">{t("wizard.exchangeLead")}</p>
        <label class="field"><span>{t("wizard.yourName")}</span><input class="input" bind:value={form.name} placeholder={t("wizard.namePlaceholder")} /></label>
        <label class="field"><span>{t("wizard.email")}</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input class="input" bind:value={form.email} type="email" autofocus placeholder={t("wizard.emailPlaceholder")} />
        </label>
        <div class="grid">
          <label class="field"><span>{t("wizard.login")}</span><input class="input" bind:value={form.username} placeholder={t("wizard.loginPlaceholder")} /></label>
          <label class="field"><span>{t("wizard.password")}</span><input class="input" bind:value={form.password} type="password" onkeydown={(e) => e.key === "Enter" && form.next()} /></label>
        </div>
        <label class="field"><span>{t("wizard.exchangeServer")}</span><input class="input" bind:value={form.ewsServer} placeholder={t("wizard.exchangeServerPlaceholder")} onkeydown={(e) => e.key === "Enter" && form.next()} /></label>
        <p class="small"><button class="link" onclick={() => (form.mode = "imap")} disabled={form.busy}>{t("wizard.back")}</button></p>
      {:else}
        {#if form.source}<p class="muted lead">{t("wizard.found", { source: form.source })}</p>{/if}
        {#each form.notes as n (n)}<p class="note">⚠ {n}</p>{/each}

        <div class="grid">
          <label class="field"><span>{t("wizard.mailboxName")}</span><input class="input" bind:value={form.label} placeholder={form.email.trim() || t("wizard.mailboxNamePlaceholder")} /></label>
          <label class="field"><span>{t("wizard.name")}</span><input class="input" bind:value={form.name} placeholder={t("wizard.namePlaceholder")} /></label>
          <label class="field wide"><span>{t("wizard.address")}</span><input class="input" bind:value={form.email} disabled={!!existing} /></label>
        </div>

        <ConnectionFields {form} />
        <SignatureField bind:value={form.signature} />
        <AttachmentsDirField bind:value={form.attachmentsDir} />
      {/if}

      <CheckError {form} />
      {#if form.status}<p class="muted">{form.status}
        {#if form.waitingBrowser}<button class="link" onclick={() => form.cancelSignIn()}>{t("cancel")}</button>{/if}</p>{/if}
    </div>

    <footer>
      {#if existing}<button class="btn ghost danger-text" onclick={() => form.remove()} disabled={form.busy}>{t("wizard.remove")}</button>{/if}
      <span class="spacer"></span>
      {#if form.step === "start"}
        <button class="btn primary" onclick={() => form.next()} disabled={form.busy || form.waitingBrowser}>{t("wizard.next")}</button>
      {:else}
        {#if !existing}<button class="btn ghost" onclick={() => (form.step = "start")} disabled={form.busy}>{t("wizard.back")}</button>{/if}
        <button class="btn primary" onclick={() => form.checkAndSave()} disabled={form.busy}>{form.busy ? t("wizard.checkingShort") : t("wizard.checkAndSave")}</button>
      {/if}
    </footer>
{/snippet}

{#if embedded}
  <div class="wizard embedded" role="group" aria-label={t("cmd.addAccount")}>
    {@render body()}
  </div>
{:else}
<div class="modal-backdrop" role="presentation">
  <div class="modal wizard" role="dialog" aria-label={t("wizard.label")}>
    <header>
      <h3>{existing ? t("wizard.editTitle", { email: existing.email }) : t("cmd.addAccount")}</h3>
      {#if app.accounts.length > 0 || existing}
        <button class="btn ghost" onclick={() => (app.wizard = null)} disabled={form.busy}>×</button>
      {/if}
    </header>

    {@render body()}
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

  .oauth img {
    flex: none;
  }

  .or {
    margin: 2px 0 -4px;
  }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .grid .wide {
    grid-column: 1 / -1;
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
