<script lang="ts">
  // The note in the format menu of a letter written in Markdown: it goes out in three parts.
  // A light cross closes it for good; Settings → Look and language → Hints brings it back (#103, 3.3 А).
  import X from "@lucide/svelte/icons/x";
  import { t } from "../lib/i18n.svelte";

  let { onclose }: { onclose: () => void } = $props();
</script>

<div class="nt" role="note" title={t("compose.markdown.partsNote")}>
  <span>{t("compose.markdown.note")}</span>
  <button class="ntx" onclick={onclose} title={t("compose.markdown.noteClose")} aria-label={t("compose.markdown.noteClose")}><X size={13} /></button>
</div>

<style>
  .nt {
    position: relative;
    margin: 4px 6px 2px;
    padding: 6px 26px 6px 8px;
    border-top: 1px solid var(--line);
    font-size: 12px;
    line-height: 1.4;
    color: var(--muted);
    max-width: 260px;
  }

  .ntx {
    position: absolute;
    top: 4px;
    right: 2px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }

  .ntx:hover,
  .ntx:focus-visible {
    background: var(--hover);
    color: var(--ink);
  }
</style>
