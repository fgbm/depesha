<script lang="ts">
  // What the IMAP server can do and what of it Depesha uses. Not filled in yet.
  import { t } from "../../lib/i18n.svelte";
  import type { SectionProps } from "./sections";

  let {}: SectionProps = $props();
</script>

<p class="muted placeholder">{t("account.serverSoon")}</p>

<style>
  .placeholder {
    margin: 0;
    font-size: 13px;
    line-height: 1.45;
  }
</style>
