<script lang="ts">
  // What new letters of this mailbox start with: their format and the signature.
  // Several signatures come here later (#25).
  import type { SectionProps } from "./sections";
  import FormatField from "./FormatField.svelte";
  import SignatureField from "./SignatureField.svelte";

  let { form }: SectionProps = $props();
</script>

<FormatField bind:value={form.composeFormat} />
<SignatureField bind:value={form.signature} />
