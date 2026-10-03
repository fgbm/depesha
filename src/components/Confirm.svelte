<script lang="ts">
  import type { Confirmation } from "../lib/store.svelte";
  import { t } from "../lib/i18n.svelte";

  let { q }: { q: Confirmation } = $props();

  let okBtn = $state<HTMLButtonElement | null>(null);
  let cancelBtn = $state<HTMLButtonElement | null>(null);
  const before = document.activeElement as HTMLElement | null;

  function answer(ok: boolean) {
    q.resolve(ok);
    before?.focus();
  }

  $effect(() => {
    (q.danger ? cancelBtn : okBtn)?.focus();
  });

  // Capture on the window: no key reaches the dialogs and shortcuts underneath.
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
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="modal-backdrop confirm-backdrop" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && answer(false)}>
  <div class="modal confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-text">
    {#if q.title}<h3>{q.title}</h3>{/if}
    <p id="confirm-text" class="text selectable">{q.text}</p>
    {#if q.detail}<p class="detail selectable">{q.detail}</p>{/if}
    <div class="buttons">
      <button class="btn" bind:this={cancelBtn} onclick={() => answer(false)}>{q.cancelLabel ?? t("cancel")}</button>
      <button class="btn primary" bind:this={okBtn} onclick={() => answer(true)}>{q.okLabel}</button>
    </div>
  </div>
</div>

<style>
  /* Over the dialog that asks, under the window controls. */
  .confirm-backdrop {
    z-index: 55;
  }

  .confirm {
    width: min(440px, calc(100vw - 40px));
    padding: 20px 20px 16px;
    gap: 10px;
  }

  h3 {
    margin: 0;
    font-size: 15px;
  }

  .text {
    margin: 0;
    line-height: 1.5;
    white-space: pre-line;
  }

  .detail {
    margin: 0;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--paper-2);
    border: 1px solid var(--line);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.45;
    overflow-wrap: anywhere;
    max-height: 120px;
    overflow-y: auto;
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
