<script lang="ts">
  // The mailbox's room on the server and on this computer. Not filled in yet.
  import { t } from "../../lib/i18n.svelte";
  import type { SectionProps } from "./sections";

  let {}: SectionProps = $props();
</script>

<p class="muted placeholder">{t("account.storageSoon")}</p>

<style>
  .placeholder {
    margin: 0;
    font-size: 13px;
    line-height: 1.45;
  }
</style>
