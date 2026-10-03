<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    open = $bindable(false),
    align = "right",
    children,
  }: { open: boolean; align?: "left" | "right"; children: Snippet } = $props();

  let box = $state<HTMLDivElement | null>(null);

  function outside(e: PointerEvent) {
    // The trigger toggles by itself; clicks inside stay inside.
    if (open && box && !box.parentElement?.contains(e.target as Node)) open = false;
  }
</script>

<svelte:window
  onpointerdown={outside}
  onkeydown={(e) => {
    if (open && e.key === "Escape") {
      e.stopPropagation();
      open = false;
    }
  }}
/>

{#if open}
  <div class="pop" class:left={align === "left"} bind:this={box} role="menu">
    {@render children()}
  </div>
{/if}

<style>
  .pop {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 30;
    min-width: 200px;
    background: var(--paper);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: 0 10px 28px rgb(0 0 0 / 18%);
    padding: 4px;
    display: flex;
    flex-direction: column;
    text-align: left;
  }

  .pop.left {
    right: auto;
    left: 0;
  }

  .pop :global(button.mi) {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    border: none;
    background: none;
    text-align: left;
    padding: 6px 10px;
    border-radius: 5px;
    white-space: nowrap;
  }

  .pop :global(button.mi:hover),
  .pop :global(button.mi:focus-visible) {
    background: var(--hover);
    outline: none;
  }

  .pop :global(.mi .hint) {
    margin-left: auto;
    padding-left: 16px;
    color: var(--muted);
    font-size: 12px;
  }

  .pop :global(hr) {
    border: none;
    border-top: 1px solid var(--line);
    margin: 4px 2px;
  }

  .pop :global(.mt) {
    padding: 6px 10px 2px;
    font-size: 12px;
    color: var(--muted);
  }
</style>
