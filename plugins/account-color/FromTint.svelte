<script lang="ts">
  // The colour of the chosen mailbox, handed to the core's "From" row: the row, its label
  // and "Копия" are tinted by the core, and the address field fills with the same colour
  // instead of paper. The plugin only names the colour, through `--row-tint`; the geometry
  // of the layer lives in Compose.svelte, which knows the window's paddings. Decorative
  // only — nothing here takes a pointer and it is hidden from the accessibility tree.
  import type { ComposeContext, PluginContext } from "@depesha/plugin-api";

  let { compose }: { compose: ComposeContext; ctx: PluginContext } = $props();

  // Re-reads the colour whenever the mailbox in "From" changes.
  const color = $derived(compose.accountColor());

  let marker = $state<HTMLSpanElement | null>(null);

  // The row is the marker's parent: the "from" slot places the control right inside it.
  // Removing the property when the plugin is switched off leaves the core as it was.
  $effect(() => {
    const row = marker?.parentElement;
    if (!row) return;
    row.style.setProperty("--row-tint", color);
    return () => row.style.removeProperty("--row-tint");
  });
</script>

<span class="marker" bind:this={marker} aria-hidden="true"></span>

<style>
  /* A zero-size marker: the core draws the full-width tint, so the plugin carries no
     geometry and the row's own padding and layout stay the core's business. */
  .marker {
    display: none;
  }
</style>
