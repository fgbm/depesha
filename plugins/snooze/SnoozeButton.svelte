<script lang="ts">
  import AlarmClock from "@lucide/svelte/icons/alarm-clock";
  import { type PluginContext } from "@depesha/plugin-api";
  import { anchorOfButton } from "./anchor";
  import { closeSnooze, openSnooze, snooze } from "./state.svelte";
  import { S } from "./strings";

  let { ctx, bulk = false }: { ctx: PluginContext; bulk?: boolean } = $props();

  function toggle(e: MouseEvent) {
    if (snooze.menu) return closeSnooze();
    openSnooze(ctx.mail.selection(), anchorOfButton(e.currentTarget as HTMLElement));
  }
</script>

{#if bulk}
  <button class="btn" data-snooze-button onclick={toggle}><AlarmClock size={15} /> {ctx.t(S.action)}</button>
{:else}
  <button class="btn ghost" data-snooze-button onclick={toggle} title={ctx.keyTitle(ctx.t(S.hint), "snooze.open")}>
    <AlarmClock size={16} /><span class="lbl2">{ctx.t(S.action)}</span>
  </button>
{/if}
