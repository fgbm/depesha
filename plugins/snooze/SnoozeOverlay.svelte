<script lang="ts">
  import { closeWhenMenu, whenMenu, type PluginContext } from "@depesha/plugin-api";
  import { snoozeMail } from "./actions";
  import { closeSnooze, snooze } from "./state.svelte";
  import SnoozeMenu from "./SnoozeMenu.svelte";

  let { ctx }: { ctx: PluginContext } = $props();

  // Another plugin may borrow the menu (the reminder of a letter in writing): say it can be drawn.
  $effect(() => {
    whenMenu.available = true;
    return () => {
      whenMenu.available = false;
    };
  });

  /** The borrowed menu goes away: the borrower hears of it, whatever the way. */
  function leave() {
    const req = whenMenu.request;
    closeWhenMenu();
    req?.onclose();
  }
</script>

{#if whenMenu.request}
  {#key whenMenu.request}
    <SnoozeMenu
      {ctx}
      anchor={whenMenu.request.anchor}
      onpick={whenMenu.request.onpick}
      onclose={leave}
      onnone={whenMenu.request.onnone}
      onsetup={whenMenu.request.onsetup}
      extras={whenMenu.request.extras}
      texts={whenMenu.request.texts}
    />
  {/key}
{/if}

{#if snooze.menu}
  {#key snooze.menu}
    <SnoozeMenu {ctx} ids={snooze.menu.ids} anchor={snooze.menu.anchor} onpick={(at, ids) => void snoozeMail(ctx, at, ids)} onclose={closeSnooze} />
  {/key}
{/if}
