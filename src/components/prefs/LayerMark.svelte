<script lang="ts">
  // The mark beside a value that has a layer above it (#102, 3.1 В): «own» with a way back, or
  // the layer it follows — «as in the general settings» at a mailbox, «as in the mailbox» at a person.
  import { t } from "../../lib/i18n.svelte";

  let { own, word, onreset }: { own: boolean; word: string; onreset: () => void } = $props();
</script>

<span class="chip" class:own>{own ? t("settings.layerOwnMark") : word}</span>
{#if own}<button type="button" class="reset" onclick={onreset}>{t("settings.layerReset")}</button>{/if}

<style>
  .chip {
    padding: 0 5px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--paper-2);
    font-size: 11px;
    line-height: 16px;
    color: var(--muted);
    white-space: nowrap;
  }

  .chip.own {
    border-color: color-mix(in srgb, var(--link) 45%, var(--line));
    background: color-mix(in srgb, var(--link) 9%, var(--paper));
    color: var(--ink);
  }

  .reset {
    padding: 2px 4px;
    border: none;
    border-radius: 5px;
    background: none;
    color: var(--link);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .reset:hover {
    background: var(--hover);
  }
</style>
