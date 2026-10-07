<script lang="ts">
  import AlarmClock from "@lucide/svelte/icons/alarm-clock";
  import { LaterMenu, Popover, snoozePresets, type PluginContext } from "@depesha/plugin-api";
  import { snoozeMail } from "./actions";
  import { snooze } from "./state.svelte";
  import { S } from "./strings";

  let { ctx, bulk = false }: { ctx: PluginContext; bulk?: boolean } = $props();

  // The reader's button follows "h"; the bulk panel has its own menu.
  let bulkOpen = $state(false);

  function pick(until: number) {
    snooze.open = false;
    bulkOpen = false;
    snoozeMail(ctx, until);
  }
</script>

{#if bulk}
  <span class="anchor">
    <button class="btn" onclick={() => (bulkOpen = !bulkOpen)}><AlarmClock size={15} /> {ctx.t(S.action)}</button>
    <Popover bind:open={bulkOpen} align="left">
      <LaterMenu title={ctx.t(S.menuTitle)} presets={snoozePresets()} action={ctx.t(S.action)} onPick={pick} />
    </Popover>
  </span>
{:else}
  <span class="anchor">
    <button class="btn ghost" onclick={() => (snooze.open = !snooze.open)} title={ctx.keyTitle(ctx.t(S.hint), "snooze.open")}>
      <AlarmClock size={16} /><span class="lbl2">{ctx.t(S.action)}</span>
    </button>
    <Popover bind:open={() => snooze.open, (v) => (snooze.open = v)} align="left">
      <LaterMenu title={ctx.t(S.menuTitle)} presets={snoozePresets()} action={ctx.t(S.action)} onPick={pick} />
    </Popover>
  </span>
{/if}

<style>
  .anchor {
    position: relative;
    display: inline-flex;
  }
</style>
