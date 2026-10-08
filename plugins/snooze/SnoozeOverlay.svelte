<script lang="ts">
  import type { PluginContext } from "@depesha/plugin-api";
  import { snooze } from "./state.svelte";
  import SnoozeMenu from "./SnoozeMenu.svelte";

  let { ctx }: { ctx: PluginContext } = $props();
</script>

{#if snooze.menu}
  {#key snooze.menu}
    <SnoozeMenu {ctx} ids={snooze.menu.ids} anchor={snooze.menu.anchor} />
  {/key}
{/if}
