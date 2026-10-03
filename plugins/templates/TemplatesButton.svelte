<script lang="ts">
  import FileText from "@lucide/svelte/icons/file-text";
  import { Popover, type ComposeContext, type PluginContext } from "@depesha/plugin-api";
  import type { Template } from "./index";
  import { S } from "./strings";

  let { compose, ctx }: { compose: ComposeContext; ctx: PluginContext } = $props();
  let open = $state(false);
  const list = $derived(ctx.settings.get<Template[]>("list", []));
</script>

{#if list.length}
  <span class="anchor">
    <button class="btn" onclick={() => (open = !open)}><FileText size={15} /> {ctx.t(S.button)}</button>
    <Popover bind:open align="left">
      <div class="mt">{ctx.t(S.insert)}</div>
      {#each list as tpl, i (i)}
        <button class="mi" onclick={() => { open = false; compose.insertText(tpl.text); }}>{tpl.name}</button>
      {/each}
    </Popover>
  </span>
{/if}

<style>
  .anchor {
    position: relative;
    display: inline-flex;
  }
</style>
