<script lang="ts">
  import { closeWhenMenu, provideWhenMenu, whenMenuRequest, type PluginContext } from "@depesha/plugin-api";
  import { snoozeMail } from "./actions";
  import { closeSnooze, snooze } from "./state.svelte";
  import SnoozeMenu from "./SnoozeMenu.svelte";

  let { ctx }: { ctx: PluginContext } = $props();

  // Another plugin may borrow the menu (the reminder of a letter in writing): say it can be drawn.
  $effect(() => {
    provideWhenMenu(true);
    return () => provideWhenMenu(false);
  });

  /** The borrowed menu goes away: the borrower hears of it, whatever the way. */
  function leave() {
    const req = whenMenuRequest();
    closeWhenMenu();
    req?.onclose();
  }
</script>

{#if whenMenuRequest()}
  {#key whenMenuRequest()}
    <SnoozeMenu
      {ctx}
      anchor={whenMenuRequest()!.anchor}
      onpick={whenMenuRequest()!.onpick}
      onclose={leave}
      onnone={whenMenuRequest()!.onnone}
      onsetup={whenMenuRequest()!.onsetup}
      extras={whenMenuRequest()!.extras}
      texts={whenMenuRequest()!.texts}
      notBefore={whenMenuRequest()!.notBefore}
    />
  {/key}
{/if}

{#if snooze.menu}
  {#key snooze.menu}
    <SnoozeMenu {ctx} ids={snooze.menu.ids} anchor={snooze.menu.anchor} onpick={(at, ids) => void snoozeMail(ctx, at, ids)} onclose={closeSnooze} />
  {/key}
{/if}
