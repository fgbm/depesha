<script lang="ts">
  import X from "@lucide/svelte/icons/x";
  import { t } from "../lib/i18n.svelte";
  import { lostNotice, settleLostFiles } from "../lib/compose/lostFiles";
  import type { ComposeWindow } from "../lib/composes.svelte";

  /** Files taken off the letter because their window closed, until attached again or closed (#115). */
  let { c }: { c: ComposeWindow } = $props();

  // A file attached again is no longer lost; the notice outlives every save.
  $effect(() => {
    void c.draft.attachments.length;
    settleLostFiles(c);
  });
</script>

{#if c.lostFiles?.length}
  <div class="error danger-text selectable" role="alert">
    <span>{lostNotice(c)}</span>
    <button class="btn ghost small-btn" aria-label={t("compose.fileLostClose")} title={t("compose.fileLostClose")} onclick={() => (c.lostFiles = [])}><X size={14} /></button>
  </div>
{/if}

<style>
  .error {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 18px;
  }
</style>
