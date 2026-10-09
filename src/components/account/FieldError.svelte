<script lang="ts">
  // Why a field of the mailbox's page was not saved: the backend refused it. The page keeps
  // saving the rest; the mark goes when the field says something else.
  import type { AccountForm } from "../../lib/accountForm.svelte";

  let { form, keys }: { form: AccountForm; keys: string[] } = $props();
  const messages = $derived(keys.map((k) => form.fieldErrors[k]).filter(Boolean));
</script>

{#each messages as m (m)}<p class="field-error" role="alert">{m}</p>{/each}

<style>
  .field-error {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--warn);
  }
</style>
