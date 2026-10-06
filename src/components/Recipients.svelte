<script lang="ts">
  // The letter's "To" and "Cc" lines, wherever a letter is shown: the reader's header and
  // a letter attached to a letter. A long list opens folded, the first few by name and
  // "N more" (src/lib/recipients.ts); one click shows both lines whole. The parent keys
  // it by the letter, so every letter opens folded.
  import { addrFull, addrName } from "../lib/format";
  import { t, tn } from "../lib/i18n.svelte";
  import { foldLine, foldsRecipients } from "../lib/recipients";
  import type { Addr } from "../lib/types";

  let {
    to,
    cc,
    showTo = true,
  }: {
    to: Addr[];
    cc: Addr[];
    /** "To: me" says nothing: the reader leaves the line out. */
    showTo?: boolean;
  } = $props();

  const folds = $derived(foldsRecipients(to, cc));
  let unfolded = $state(false);
  const folded = $derived(folds && !unfolded);

  function list(addrs: Addr[]): string {
    return addrs.map(addrFull).join(", ");
  }
</script>

{#snippet line(label: string, addrs: Addr[], last: boolean)}
  <div class="muted small line">
    {label}:
    {#if folded}
      {@const part = foldLine(addrs)}
      <span title={list(addrs)}>{part.shown.map(addrName).join(", ")}</span>
      {#if part.more}<button class="fold" aria-expanded="false" onclick={() => (unfolded = true)}>{tn("reader.moreRecipients", part.more, { n: part.more })}</button>{/if}
    {:else}
      {list(addrs)}
      {#if folds && last}<button class="fold" aria-expanded="true" onclick={() => (unfolded = false)}>{t("reader.foldRecipients")}</button>{/if}
    {/if}
  </div>
{/snippet}

{#if to.length && showTo}{@render line(t("compose.fwd.to"), to, !cc.length)}{/if}
{#if cc.length}{@render line(t("compose.fwd.cc"), cc, true)}{/if}

<style>
  .line {
    overflow-wrap: anywhere;
  }

  .small {
    font-size: 12px;
  }

  /* A link in the line of recipients: it unfolds or folds them all. */
  .fold {
    border: none;
    background: none;
    padding: 0;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }

  .fold:hover {
    text-decoration: underline;
  }
</style>
