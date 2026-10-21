<script lang="ts">
  // What new letters of this mailbox start with, how its letters are shown and where their
  // attachments go, the signatures, and what an answer does with the letter of the inbox. Each
  // «As in the settings» stands where the general pages have the same row (0.8.12, 3.1 А).
  import { t } from "../../lib/i18n.svelte";
  import type { SectionProps } from "./sections";
  import SettingsRow from "../prefs/SettingsRow.svelte";
  import AttachmentsDirSelect from "./AttachmentsDirSelect.svelte";
  import FieldError from "./FieldError.svelte";
  import FormatField from "./FormatField.svelte";
  import LetterViewField from "./LetterViewField.svelte";
  import SignaturesField from "./SignaturesField.svelte";
  import WaitingField from "./WaitingField.svelte";
  import Switch from "../prefs/controls/Switch.svelte";

  let { form, account }: SectionProps = $props();
</script>

<SettingsRow id="acc-format" kind="field" label={t("wizard.composeFormat")}>
  <FormatField bind:value={form.composeFormat} />
</SettingsRow>
<SettingsRow id="acc-view" kind="field" label={t("settings.letterView")}>
  <LetterViewField bind:value={form.letterView} />
</SettingsRow>
<FieldError {form} keys={["compose_format", "letter_view"]} />
<SettingsRow id="acc-attachments" kind="field" label={t("wizard.attachmentsDir")}>
  <AttachmentsDirSelect bind:value={form.attachmentsDir} />
</SettingsRow>
<FieldError {form} keys={["attachments_dir"]} />
<SettingsRow id="acc-signatures" kind="field" label={t("account.signatures.title")}>
  <SignaturesField {form} bare />
</SettingsRow>
<FieldError {form} keys={["signatures", "default_signature", "reply_signature"]} />
<WaitingField bind:waiting={form.waiting} accountId={account.id} />
<FieldError {form} keys={["waiting"]} />
<SettingsRow
  id="acc-trust-by-address"
  kind="toggle"
  label={t("account.trustByAddress")}
  hint={t("account.trustByAddressNote")}
>
  <Switch
    checked={form.trustByAddress}
    label={t("account.trustByAddress")}
    onchange={(on) => (form.trustByAddress = on)}
  />
</SettingsRow>
<FieldError {form} keys={["trust_by_address"]} />
