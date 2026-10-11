<script lang="ts">
  import X from "@lucide/svelte/icons/x";
  import { t } from "../lib/i18n.svelte";

  /** The cross of a window: «Close (Esc)». `corner` pins it to the top right corner of the window (which must be positioned). */
  let { onclick, corner = false, disabled = false }: { onclick: () => void; corner?: boolean; disabled?: boolean } = $props();
</script>

<button class="btn ghost icon shut" class:corner {onclick} {disabled} title={t("viewer.close")} aria-label={t("close")}><X size={17} /></button>

<style>
  .corner {
    position: absolute;
    top: 10px;
    right: 12px;
    z-index: 1;
  }
</style>
