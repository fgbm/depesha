<script lang="ts">
  import ListX from "@lucide/svelte/icons/list-x";
  import type { PluginContext } from "@depesha/plugin-api";
  import { S } from "./strings";

  let { ctx, ask }: { ctx: PluginContext; ask: (id: number) => void } = $props();
  const msg = $derived(ctx.mail.opened());
</script>

{#if msg?.view.summary.unsubscribe}
  <button class="chip" onclick={() => ask(msg.row.id)} title={ctx.t(S.hint)}><ListX size={13} /> {ctx.t(S.action)}</button>
{/if}

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 6px;
    border: 1px solid var(--line);
    background: var(--paper);
    border-radius: 10px;
    padding: 0 8px;
    font-size: 12px;
    color: var(--muted);
    vertical-align: 1px;
  }

  .chip:hover {
    color: var(--ink);
    border-color: var(--muted);
  }
</style>
