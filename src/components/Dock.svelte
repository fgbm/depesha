<script lang="ts">
  // Compositions dock in the corner and leave the mail usable, as in Gmail and Yandex Mail.
  // Toasts stand in the corner above the folded bars, whatever their number; next to an
  // unfolded window they sit left of it, so they never cover its Send button.
  import { app } from "../lib/store.svelte";
  import { t } from "../lib/i18n.svelte";
  import Compose from "./Compose.svelte";

  const unfolded = $derived(app.composes.some((c) => c.mode === "open"));
</script>

<div class="dock" class:stacked={!unfolded}>
  <div class="toasts" aria-live="polite">
    {#each app.toasts as toast (toast.id)}
      <div class="toast" class:error={toast.error}>
        <span class="selectable">{toast.text}</span>
        {#if toast.action}
          <button class="btn ghost act" onclick={() => { app.dismiss(toast.id); toast.action?.run(); }}>{toast.action.label}</button>
        {/if}
        <button class="btn ghost close" onclick={() => app.dismiss(toast.id)} aria-label={t("close")}>×</button>
      </div>
    {/each}
  </div>
  {#if app.composes.length}
    <div class="windows">
      {#each app.composes as c (c.id)}
        <Compose {c} />
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Newest on the right; a full-screen window leaves the dock (position: fixed). */
  .dock {
    position: fixed;
    right: 16px;
    bottom: 0;
    display: flex;
    align-items: flex-end;
    gap: 12px;
    z-index: 30;
    pointer-events: none;
  }

  /* Only bars below: the toasts go over them, at the same place as with none. */
  .dock.stacked {
    flex-direction: column;
    gap: 0;
  }

  .windows {
    display: flex;
    align-items: flex-end;
    gap: 12px;
  }

  .toasts,
  .windows > :global(*) {
    pointer-events: auto;
  }

  /* In the dock, under dialogs (their z-index is higher): a toast covers neither
     a dialog's buttons nor a composition window. */
  .toasts {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
    max-width: 440px;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--side);
    color: var(--side-ink);
    border-radius: var(--radius);
    padding: 10px 8px 10px 14px;
    box-shadow: 0 8px 24px rgb(0 0 0 / 25%);
    line-height: 1.4;
  }

  .toast.error {
    border-left: 4px solid var(--accent);
  }

  .toast .act {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 3px;
    font-weight: 600;
    padding: 0 6px;
    white-space: nowrap;
  }

  .toast .close {
    color: var(--side-muted);
    padding: 0 6px;
    font-size: 16px;
  }
</style>
