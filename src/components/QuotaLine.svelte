<script lang="ts">
  // Under a mailbox's folders: how full it is, quiet until a warning level, yellow with the
  // percent past it, red when full. A click opens the mailbox's «Storage».
  import { app } from "../lib/store.svelte";
  import { rooms } from "../lib/room.svelte";
  import { t } from "../lib/i18n.svelte";
  import { accountLabel } from "../lib/format";
  import { percent, usedOf, wholePercent } from "../lib/quota";
  import type { AccountView } from "../lib/types";

  let { account, fly = false, onopen }: { account: AccountView; fly?: boolean; onopen?: () => void } = $props();

  const room = $derived(rooms.room(account));
  const level = $derived(rooms.level(account));
  const pct = $derived(room ? percent(room) : 0);
  const text = $derived.by(() => {
    if (!room) return "";
    const { used, limit } = usedOf(room.used, room.limit);
    const shown = room.estimate ? `≈${used}` : used;
    if (fly) return t("quota.flyLine", { p: wholePercent(pct), used: shown, limit });
    if (level === 3) return t("quota.lineFull", { used: shown, limit });
    if (level > 0) return t("quota.linePct", { used: shown, limit, p: wholePercent(pct) });
    return t("quota.line", { used: shown, limit });
  });

  function open() {
    onopen?.();
    app.ui.openSettings(`account:${account.id}`, "storage");
  }
</script>

{#if room}
  <button class="quota" class:fly data-level={level} data-account={account.id} onclick={open} title={t("quota.lineTitle", { name: accountLabel(account), p: wholePercent(pct) })}>
    {#if !fly}<span class="bar"><span style:width="{Math.min(100, pct)}%"></span></span>{/if}
    <span class="text">{text}</span>
  </button>
  {#if fly && level > 0}
    <button class="large" onclick={() => (onopen?.(), rooms.findLarge())}>{t("quota.largeShort")}</button>
  {/if}
{/if}

<style>
  /* Lined up with the folder names; the sidebar's own muted colour until a level. */
  .quota {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 3px var(--tail, 14px) 3px 40px;
    border: none;
    background: none;
    color: var(--side-muted);
    font: inherit;
    font-size: 11.5px;
    text-align: left;
  }

  .quota:hover .text {
    color: var(--side-ink);
  }

  .quota:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .bar {
    flex: none;
    width: 34px;
    height: 3px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--side-ink) 18%, transparent);
    overflow: hidden;
  }

  .bar span {
    display: block;
    height: 100%;
    background: currentColor;
  }

  .text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .quota[data-level="1"],
  .quota[data-level="2"] {
    color: var(--side-warn);
  }

  .quota[data-level="3"] {
    color: var(--side-alert);
    font-weight: 600;
  }

  /* In the strip's flyout: a line of its own under the folders. */
  .quota.fly {
    padding: 6px 12px 2px;
    font-size: 12px;
  }

  .large {
    margin: 4px 12px 6px;
    padding: 3px 8px;
    border: 1px solid color-mix(in srgb, var(--side-ink) 25%, transparent);
    border-radius: 6px;
    background: none;
    color: var(--side-ink);
    font: inherit;
    font-size: 12px;
  }

  .large:hover {
    background: var(--side-2);
  }
</style>
