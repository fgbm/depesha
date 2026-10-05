<script lang="ts">
  // A mailbox's page in the settings window: one page of sections under a table of contents
  // that stays in sight and marks the section being read, and the page's own buttons.
  import { onMount } from "svelte";
  import { t } from "../../lib/i18n.svelte";
  import { app } from "../../lib/store.svelte";
  import { rooms } from "../../lib/room.svelte";
  import { AccountForm } from "../../lib/accountForm.svelte";
  import { currentSection } from "../../lib/toc";
  import type { AccountView } from "../../lib/types";
  import { sectionsFor } from "./sections";
  import CheckError from "./CheckError.svelte";

  let { account, onDone }: { account: AccountView; onDone: () => void } = $props();

  // The page is opened for one mailbox: the settings window opens a new one for another.
  // svelte-ignore state_referenced_locally
  const form = new AccountForm(account, () => onDone());
  const sections = $derived(sectionsFor(account));

  let scroller = $state<HTMLElement>();
  let current = $state(0);

  function track() {
    if (!scroller) return;
    const tops = [...scroller.querySelectorAll<HTMLElement>("section[data-section]")].map((s) => s.offsetTop);
    const atBottom = scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    current = currentSection(tops, scroller.scrollTop, atBottom);
  }

  // Opened for one of its sections (the signatures, from a letter): the page starts there.
  onMount(() => {
    const id = app.settingsSection;
    app.settingsSection = null;
    const target = id ? scroller?.querySelector<HTMLElement>(`section[data-section="${id}"]`) : null;
    if (scroller && target) scroller.scrollTop = target.offsetTop;
  });

  function go(e: MouseEvent, id: string) {
    e.preventDefault();
    const target = scroller?.querySelector<HTMLElement>(`section[data-section="${id}"]`);
    if (!scroller || !target) return;
    scroller.scrollTo({ top: target.offsetTop, behavior: "smooth" });
  }

  onMount(() => {
    // What the server can do, from the cache: the section and the contents' dot read it.
    if (!account.ews) rooms.loadInfo(account.id);
  });
</script>

<div class="account-page" role="group" aria-label={account.email}>
  <nav class="toc" aria-label={t("account.contents")}>
    {#each sections as s, i (s.id)}
      {@const look = s.attention?.(account) ?? false}
      <a href="#account-{s.id}" data-toc={s.id} aria-current={current === i ? "location" : undefined} onclick={(e) => go(e, s.id)}
        >{s.title()}{#if look}<span class="look" role="img" aria-label={t("account.attention")} title={t("account.attention")}></span>{/if}</a
      >
    {/each}
  </nav>

  <div class="scroller" bind:this={scroller} onscroll={track}>
    {#each sections as s (s.id)}
      <section id="account-{s.id}" data-section={s.id} aria-labelledby="account-{s.id}-title">
        <h3 id="account-{s.id}-title">{s.title()}</h3>
        <div class="body">
          <s.component {form} {account} />
        </div>
      </section>
    {/each}
  </div>

  {#if form.error || form.status}
    <div class="outcome">
      <CheckError {form} />
      {#if form.status}<p class="muted">{form.status}
        {#if form.waitingBrowser}<button class="link" onclick={() => form.cancelSignIn()}>{t("cancel")}</button>{/if}</p>{/if}
    </div>
  {/if}

  <footer>
    <button class="btn ghost danger-text" onclick={() => form.remove()} disabled={form.busy}>{t("wizard.remove")}</button>
    <span class="spacer"></span>
    <button class="btn ghost" onclick={() => onDone()} disabled={form.busy}>{t("cancel")}</button>
    <button class="btn primary" onclick={() => form.save()} disabled={form.busy}>
      {form.needsCheck ? (form.busy ? t("wizard.checkingShort") : t("wizard.checkAndSave")) : form.busy ? t("wizard.saving") : t("file.save")}
    </button>
  </footer>
</div>

<style>
  .account-page {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* Anchors, not tabs: the page is one, a section hides none of the others. */
  .toc {
    flex: none;
    display: flex;
    gap: 4px;
    padding: 4px 24px 10px;
    border-bottom: 1px solid var(--line);
    overflow-x: auto;
  }

  .toc a {
    flex: none;
    padding: 4px 9px;
    border-radius: 6px;
    color: var(--muted);
    font-size: 13px;
    text-decoration: none;
    white-space: nowrap;
  }

  .toc a:hover {
    background: var(--hover);
    color: var(--ink);
  }

  .toc a[aria-current="location"] {
    background: var(--selected);
    color: var(--ink);
    font-weight: 600;
  }

  /* Something in the section deserves a look; nowhere else does it show. */
  .look {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-left: 5px;
    border-radius: 50%;
    background: var(--warn);
    vertical-align: middle;
  }

  .toc a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  /* Offsets of the sections are counted from here. */
  .scroller {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 24px;
  }

  section {
    padding: 16px 0 20px;
    border-bottom: 1px solid var(--line);
  }

  section:last-child {
    border-bottom: none;
    /* The last section can still be scrolled to the top, as the others. */
    min-height: 100%;
  }

  h3 {
    margin: 0 0 12px;
    font-size: 15px;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .outcome {
    flex: none;
    max-height: 40%;
    overflow-y: auto;
    padding: 10px 24px 0;
    border-top: 1px solid var(--line);
  }

  .outcome p {
    margin: 0 0 6px;
  }

  .link {
    border: none;
    background: none;
    color: var(--link);
    padding: 0;
    text-decoration: underline;
  }

  footer {
    flex: none;
    display: flex;
    gap: 8px;
    padding: 12px 24px 16px;
    border-top: 1px solid var(--line);
  }

  .spacer {
    flex: 1;
  }

  @media (max-width: 640px) {
    .toc {
      padding: 4px 16px 8px;
    }

    .scroller {
      padding: 0 16px;
    }

    footer {
      padding: 10px 16px 12px;
    }
  }
</style>
