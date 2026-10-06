<script lang="ts">
  // A quiet accent beside "From": a dot in the colour of the chosen mailbox, so the
  // letter's sender is recognisable at a glance. Decorative only — it takes no pointer
  // and is hidden from the accessibility tree.
  import type { ComposeContext, PluginContext } from "@depesha/plugin-api";

  let { compose }: { compose: ComposeContext; ctx: PluginContext } = $props();

  // Re-reads the colour whenever the mailbox in "From" changes.
  const color = $derived(compose.accountColor());
</script>

<span class="tint" aria-hidden="true" style:--tint={color}></span>

<style>
  /* The accent is a zero-width box, so it adds nothing to the row; the visible dot is
     drawn by ::before inside the 8px gap the "From" row already keeps between its items
     (Compose.svelte .row). The margins cancel that one extra gap, so the mailbox list
     and its neighbours keep their exact width and nothing shifts. The dot is exactly as
     wide as that gap, which is why it is not made larger: beyond 8px it would run into
     the address. Centred against the row, it stays clear of the row's border-bottom. */
  .tint {
    position: relative;
    flex: none;
    align-self: center;
    height: 8px;
    width: 0;
    margin: 0 -4px;
  }

  .tint::before {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--tint);
    pointer-events: none;
  }
</style>
