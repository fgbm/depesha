<script lang="ts">
  // The mailbox's name, the sender's name and the colour, as rows of the general pages (0.8.12, 3.1 А).
  // The address is no field: it stands in the page's heading beside the name.
  import { t } from "../../lib/i18n.svelte";
  import type { SectionProps } from "./sections";
  import SettingsRow from "../prefs/SettingsRow.svelte";
  import ColorField from "./ColorField.svelte";
  import FieldError from "./FieldError.svelte";

  let { form }: SectionProps = $props();
</script>

<SettingsRow id="acc-label" kind="field" label={t("wizard.mailboxName")}>
  <input class="input text" bind:value={form.label} placeholder={form.email} aria-label={t("wizard.mailboxName")} />
</SettingsRow>
<SettingsRow id="acc-name" kind="field" label={t("account.senderName")} hint={t("account.senderNote")}>
  <input class="input text" bind:value={form.name} placeholder={t("wizard.namePlaceholder")} aria-label={t("account.senderName")} />
</SettingsRow>
<SettingsRow id="acc-color" kind="field" label={t("account.colorRow")}>
  <ColorField bind:value={form.color} />
</SettingsRow>
<FieldError {form} keys={["label", "display_name", "color", "save_sent_copy"]} />

<style>
  .text {
    width: 300px;
    max-width: 100%;
  }
</style>
