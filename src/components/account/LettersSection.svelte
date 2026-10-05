<script lang="ts">
  // What new letters of this mailbox start with. The format of new letters and several
  // signatures come here later; for now the one signature.
  import type { SectionProps } from "./sections";
  import SignatureField from "./SignatureField.svelte";

  let { form }: SectionProps = $props();
</script>

<SignatureField bind:value={form.signature} />
