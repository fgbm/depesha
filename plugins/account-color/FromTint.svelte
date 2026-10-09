<script lang="ts">
  // The colour of the chosen mailbox, handed to the title of the letter's window (#103, 1.1 Б):
  // the mailbox stands in the title, and the core tints the title bar
  // with it. The plugin only names the colour, through `--row-tint`; the strength of the tint
  // lives in Compose.svelte. Decorative only — nothing here takes a pointer and it is hidden
  // from the accessibility tree.
  import type { ComposeContext, PluginContext } from "@depesha/plugin-api";

  let { compose }: { compose: ComposeContext; ctx: PluginContext } = $props();

  // Re-reads the colour whenever the mailbox in "From" changes.
  const color = $derived(compose.accountColor());

  let marker = $state<HTMLSpanElement | null>(null);

  // The title bar is the marker's parent: the "from" slot places the control right inside it.
  // Removing the property when the plugin is switched off leaves the core as it was.
  $effect(() => {
    const bar = marker?.parentElement;
    if (!bar) return;
    bar.style.setProperty("--row-tint", color);
    return () => bar.style.removeProperty("--row-tint");
  });
</script>

<span class="marker" bind:this={marker} aria-hidden="true"></span>

<style>
  /* A zero-size marker: the core draws the tint, so the plugin carries no geometry and the
     bar's own padding and layout stay the core's business. */
  .marker {
    display: none;
  }
</style>
