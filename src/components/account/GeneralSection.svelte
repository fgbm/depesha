<script lang="ts">
  import { t } from "../../lib/i18n.svelte";
  import type { SectionProps } from "./sections";
  import ColorField from "./ColorField.svelte";
  import AttachmentsDirField from "./AttachmentsDirField.svelte";
  import ConnectionBlock from "./ConnectionBlock.svelte";

  let { form, account }: SectionProps = $props();
  let connectionOpen = $state(false);

  // A failed check is about the connection: its fields open to be fixed.
  $effect(() => {
    if (form.errorProto || form.error?.kind === "auth") connectionOpen = true;
  });
</script>

<div class="grid">
  <label class="field"><span>{t("wizard.mailboxName")}</span><input class="input" bind:value={form.label} placeholder={form.email} /></label>
  <label class="field"><span>{t("wizard.name")}</span><input class="input" bind:value={form.name} placeholder={t("wizard.namePlaceholder")} /></label>
  <label class="field wide"><span>{t("wizard.address")}</span><input class="input" value={form.email} disabled /></label>
</div>
<ColorField bind:value={form.color} />
<AttachmentsDirField bind:value={form.attachmentsDir} />
<ConnectionBlock {form} status={account.status} bind:open={connectionOpen} />

<style>
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .wide {
    grid-column: 1 / -1;
  }

  @media (max-width: 640px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
