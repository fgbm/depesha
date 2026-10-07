<script lang="ts">
  // The line of the wait in the compose window (frame 6В): "Take the letter out of the
  // inbox until a reply" for an answer to a letter of the inbox, and the reminder beside
  // it — both are one wait. A letter of another folder says it stays there (frame 12Б).
  import AlarmClock from "@lucide/svelte/icons/alarm-clock";
  import type { ComposeContext, PluginContext } from "@depesha/plugin-api";
  import { queueBox } from "./queue";
  import RemindSelect from "./RemindSelect.svelte";

  let { compose, ctx }: { compose: ComposeContext; ctx: PluginContext } = $props();

  const box = $derived(queueBox(compose.draft.acts_on, compose.accountId(), ctx.mail.accounts(), ctx.mail.folders(), compose.options.park, ctx));
  // No choice to make (another mailbox in From, a letter that stays): the backend decides.
  $effect(() => {
    if ((!box || box.disabled) && compose.options.park !== null) compose.options.park = null;
  });
</script>

<div class="wait-line">
  {#if box}
    <label class="queue" class:off={box.disabled} title={box.title}>
      <input type="checkbox" checked={box.checked} disabled={box.disabled} onchange={(e) => (compose.options.park = e.currentTarget.checked)} />
      {box.text}
    </label>
    <span class="sep" aria-hidden="true">|</span>
  {/if}
  <AlarmClock size={13} />
  <RemindSelect {compose} {ctx} />
</div>

<style>
  .wait-line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 10px;
    padding: 6px 18px;
    border-top: 1px solid var(--line);
    font-size: 12px;
    color: var(--muted);
  }

  .queue {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--ink);
    white-space: nowrap;
  }

  .queue.off {
    color: var(--muted);
  }

  .sep {
    color: var(--line);
  }
</style>
