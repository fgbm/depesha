<script lang="ts">
  // What new letters of this mailbox start with: their format and the signatures; and what
  // an answer does with the letter of the inbox.
  import type { SectionProps } from "./sections";
  import FormatField from "./FormatField.svelte";
  import SignaturesField from "./SignaturesField.svelte";
  import WaitingField from "./WaitingField.svelte";

  let { form, account }: SectionProps = $props();
</script>

<FormatField bind:value={form.composeFormat} />
<SignaturesField {form} />
<WaitingField bind:waiting={form.waiting} accountId={account.id} />
