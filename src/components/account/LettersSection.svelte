<script lang="ts">
  // What new letters of this mailbox start with: their format and the signatures.
  import type { SectionProps } from "./sections";
  import FormatField from "./FormatField.svelte";
  import SignaturesField from "./SignaturesField.svelte";

  let { form }: SectionProps = $props();
</script>

<FormatField bind:value={form.composeFormat} />
<SignaturesField {form} />
