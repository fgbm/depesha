<script lang="ts">
  // What a community plugin will be able to do, before it is installed, updated or
  // allowed to run: nothing is copied or switched on until the user agrees.
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { t } from "../lib/i18n.svelte";
  import { textOf } from "../lib/extensions.svelte";
  import { consentItems, mailLeaves, type ConsentItem } from "../lib/consent";
  import type { ExtPreview } from "../lib/types";

  let { preview, mode, onanswer }: { preview: ExtPreview; mode: "install" | "update" | "approve"; onanswer: (ok: boolean) => void } = $props();

  let okBtn = $state<HTMLButtonElement | null>(null);
  let cancelBtn = $state<HTMLButtonElement | null>(null);
  const before = document.activeElement as HTMLElement | null;

  const m = $derived(preview.manifest);
  const items = $derived(consentItems(m, preview.previous?.granted ?? null));
  const leaves = $derived(mailLeaves(m));
  const name = $derived(textOf(m.name));

  function answer(ok: boolean) {
    onanswer(ok);
    before?.focus();
  }

  // Refusing is the safe answer, so it has the focus.
  $effect(() => {
    cancelBtn?.focus();
  });

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      answer(false);
    } else if (e.key === "Tab") {
      e.preventDefault();
      (document.activeElement === okBtn ? cancelBtn : okBtn)?.focus();
    }
  }

  function explain(i: ConsentItem): string {
    if (i.kind === "hook") {
      if (i.value === "messageOpen") return t("ext.consent.hook.messageOpen");
      if (i.value === "newMail") return t("ext.consent.hook.newMail");
      if (i.value === "beforeSend") return t("ext.consent.hook.beforeSend");
      return i.value;
    }
    if (i.value === "messages.read") return t("ext.consent.read");
    if (i.value === "messages.modify") return t("ext.consent.modify");
    if (i.value === "storage") return t("ext.consent.storage");
    if (i.value.startsWith("network:")) return t("ext.consent.network", { host: i.value.slice("network:".length) });
    return i.value;
  }
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="modal-backdrop consent-backdrop" role="presentation">
  <div class="modal consent" role="alertdialog" aria-modal="true" aria-labelledby="consent-title" data-consent={m.id}>
    <h3 id="consent-title">{t(mode === "update" ? "ext.consent.update" : mode === "approve" ? "ext.consent.approve" : "ext.consent.install", { name })}</h3>
    <p class="muted small meta">
      {preview.previous && mode === "update"
        ? t("ext.consent.versionUpdate", { from: preview.previous.version, to: m.version })
        : t("ext.consent.version", { version: m.version })}
      · {m.author ? t("ext.consent.author", { author: m.author }) : t("ext.consent.noAuthor")}
      · <span class="selectable">{m.id}</span>
    </p>
    {#if m.description}<p class="small">{textOf(m.description)}</p>{/if}

    {#if items.length}
      <p class="lead">{t(items.some((i) => i.added) ? "ext.consent.asksMore" : "ext.consent.asks")}</p>
      <ul>
        {#each items as i (i.kind + i.value)}
          <li class:added={i.added} data-item={i.value}>
            {explain(i)}{#if i.added}<span class="badge">{t("ext.consent.new")}</span>{/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="lead">{t("ext.consent.nothing")}</p>
    {/if}

    {#if leaves}
      <div class="leak" role="alert">
        <TriangleAlert size={16} />
        <span>{t(leaves.newMail ? "ext.consent.leakNewMail" : "ext.consent.leak", { hosts: leaves.hosts.join(", ") })}</span>
      </div>
    {/if}

    <div class="buttons">
      <button class="btn" bind:this={cancelBtn} onclick={() => answer(false)}>{t("cancel")}</button>
      <button class="btn primary" bind:this={okBtn} onclick={() => answer(true)}>
        {t(mode === "update" ? "ext.consent.updateButton" : mode === "approve" ? "ext.consent.approveButton" : "ext.consent.installButton")}
      </button>
    </div>
  </div>
</div>

<style>
  /* Over the settings window that asks. */
  .consent-backdrop {
    z-index: 55;
  }

  .consent {
    width: min(480px, calc(100vw - 40px));
    padding: 20px 20px 16px;
    gap: 8px;
    overflow-y: auto;
  }

  h3 {
    margin: 0;
    font-size: 15px;
  }

  p {
    margin: 0;
  }

  .small {
    font-size: 12px;
  }

  .lead {
    margin-top: 4px;
  }

  ul {
    margin: 0;
    padding-left: 20px;
    line-height: 1.5;
  }

  li.added {
    font-weight: 600;
  }

  .badge {
    margin-left: 6px;
    font-size: 11px;
    border: 1px solid var(--accent);
    color: var(--accent);
    border-radius: 10px;
    padding: 0 6px;
  }

  .leak {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--paper));
    line-height: 1.45;
  }

  .leak :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--accent);
  }

  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 6px;
  }

  .btn:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent);
    outline-offset: 2px;
  }
</style>
