<script lang="ts">
  import { t } from "../../lib/i18n.svelte";

  let { value = $bindable("") }: { value: string } = $props();
</script>

<label class="field"><span>{t("wizard.signature")}</span>
  <textarea class="input sig" bind:value rows="3" placeholder={t("wizard.signaturePlaceholder")}></textarea>
</label>

<style>
  /* Capped so the resize handle never slides under the footer; longer text scrolls inside. */
  .sig {
    resize: vertical;
    font: inherit;
    line-height: 1.4;
    /* 3 to 8 lines plus padding and border */
    min-height: calc(4.2em + 14px);
    max-height: calc(11.2em + 14px);
  }
</style>
