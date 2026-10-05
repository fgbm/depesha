<script lang="ts">
  // A switch of a few parts over a list, e.g. Active / Closed of "Waiting for reply".
  import type { ViewTabs } from "../plugin-api";

  let { tabs }: { tabs: ViewTabs } = $props();
  const current = $derived(tabs.current());
</script>

<div class="segments" role="tablist">
  {#each tabs.options() as o (o.id)}
    <button class="seg" class:on={o.id === current} role="tab" aria-selected={o.id === current} onclick={() => o.id !== current && tabs.select(o.id)}>
      {o.title}{#if o.count}<span class="n">{o.count}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .segments {
    display: flex;
    background: var(--paper-2);
    border-radius: 7px;
    padding: 2px;
    margin-top: 8px;
  }

  .seg {
    flex: 1;
    border: none;
    background: none;
    font: inherit;
    font-size: 12px;
    color: var(--muted);
    padding: 4px 0;
    border-radius: 6px;
    cursor: pointer;
  }

  .seg.on {
    background: var(--selected);
    color: var(--ink);
    font-weight: 600;
  }

  .n {
    font-weight: 400;
    color: var(--muted);
    margin-left: 4px;
  }
</style>
