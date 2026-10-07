<script lang="ts">
  // A quiet accent across the whole "From" row: the row's background is tinted with the
  // colour of the chosen mailbox, label and "Копия" included. Decorative only — the layer
  // takes no pointer and is hidden from the accessibility tree.
  import type { ComposeContext, PluginContext } from "@depesha/plugin-api";

  let { compose }: { compose: ComposeContext; ctx: PluginContext } = $props();

  // Re-reads the colour whenever the mailbox in "From" changes.
  const color = $derived(compose.accountColor());
</script>

<span class="tint" aria-hidden="true" style:--tint={color}></span>

<style>
  /* The layer fills the row (Compose.svelte makes the “From” row a positioning and
     stacking context, so `inset: 0` is the row, not the window). It sits at z-index:-1,
     behind the row's own content but above the row's background: the semi-transparent tint
     therefore stacks with a state background (--hover / --selected) instead of replacing it.
     It takes no pointer, so the select, “Копия” and their focus are untouched.

     At 14% the colour reads from across the room, while the row still stays below a
     selected one (ΔE 8.2–9.5 against 12.8), so a resting row is not taken for a chosen one. */
  .tint {
    position: absolute;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background: color-mix(in srgb, var(--tint) 14%, transparent);
  }
</style>
