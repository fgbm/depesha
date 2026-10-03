<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import { LaterMenu, Popover, sendLaterPresets, type ComposeContext, type PluginContext } from "@depesha/plugin-api";
  import { S } from "./strings";

  let { compose, ctx }: { compose: ComposeContext; ctx: PluginContext } = $props();
  let open = $state(false);
</script>

<button class="btn primary more" onclick={() => (open = !open)} title={ctx.t(S.title)} aria-label={ctx.t(S.title)}>
  <ChevronDown size={15} />
</button>
<Popover bind:open align="left">
  <LaterMenu title={ctx.t(S.title)} presets={sendLaterPresets()} action={ctx.t(S.schedule)} onPick={(at) => { open = false; compose.send(at); }} />
</Popover>

<style>
  .more {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-left: 1px solid rgb(255 255 255 / 25%);
    padding: 5px 6px;
  }
</style>
