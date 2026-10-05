<script lang="ts">
  // A plugin's line above the opened letter. In a narrow window the first action stays a
  // button and the rest, with the details when they have a title, fold into "⋯".
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import Popover from "./Popover.svelte";
  import { foldBanner } from "../lib/banner";
  import { layout } from "../lib/layout.svelte";
  import { t } from "../lib/i18n.svelte";
  import type { Banner } from "../plugin-api";

  let { banner: b }: { banner: Banner } = $props();

  let open = $state(false);
  let detailsOpen = $state(false);
  const f = $derived(foldBanner(b, layout.single, detailsOpen));
</script>

<div class="banner" class:info={b.tone === "info" || !b.tone} class:good={b.tone === "good"}>
  {#if b.icon}<b.icon size={15} />{/if}
  <span class="text">{b.text}</span>
  {#each f.buttons as a (a.title)}<button class="btn" class:primary={a.primary} class:ghost={!a.primary} onclick={a.run}>{a.title}</button>{/each}
  {#if f.folded}
    <span class="anchor">
      <button class="btn ghost icon" onclick={() => (open = !open)} title={t("act.more")} aria-label={t("act.more")}><Ellipsis size={15} /></button>
      <Popover bind:open>
        {#each f.menu as a (a.title)}<button class="mi" onclick={() => { open = false; a.run(); }}>{a.title}</button>{/each}
        {#if f.detailsInMenu}
          {#if f.menu.length}<hr />{/if}
          <button class="mi" onclick={() => { open = false; detailsOpen = !detailsOpen; }}>{b.detailsTitle}</button>
        {/if}
      </Popover>
    </span>
  {/if}
  {#if f.details.length}
    <dl class="details selectable">
      {#each f.details as d, j (j)}<dt>{d.label}</dt><dd>{d.value}</dd>{/each}
    </dl>
  {/if}
</div>

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin: 0 22px 10px;
    padding: 8px 12px;
    background: color-mix(in srgb, var(--warn) 12%, var(--paper));
    border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--paper));
    border-radius: 6px;
    font-size: 13px;
  }

  .banner.info {
    background: color-mix(in srgb, var(--link) 9%, var(--paper));
    border-color: color-mix(in srgb, var(--link) 28%, var(--paper));
  }

  .banner.good {
    background: color-mix(in srgb, var(--ok) 9%, var(--paper));
    border-color: color-mix(in srgb, var(--ok) 28%, var(--paper));
  }

  .text {
    flex: 1;
    min-width: 200px;
  }

  .anchor {
    position: relative;
  }

  .details {
    flex-basis: 100%;
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px 10px;
    margin: 0;
    max-height: 160px;
    overflow: auto;
  }

  .details dt {
    color: var(--muted);
  }

  .details dd {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
