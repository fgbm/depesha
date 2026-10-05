<script lang="ts">
  // The folded letters of the conversation around the opened one: one line per letter, a
  // card above and below the letter read, the middle of a long conversation into "N more".
  // The pane (Reader.svelte) frames the group and decides what "N more" opens.
  import { app } from "../../lib/store.svelte";
  import { avatarColor, initials, listDate } from "../../lib/format";
  import { t, tn } from "../../lib/i18n.svelte";
  import { avatarOf } from "../../lib/avatars.svelte";
  import type { MessageRow } from "../../lib/types";

  let {
    messages,
    folded = 0,
    onShowAll,
  }: {
    /** The letters of this group, oldest first. */
    messages: MessageRow[];
    /** How many letters the middle hides; 0 shows every card. */
    folded?: number;
    /** "N more" unfolds the middle. */
    onShowAll?: () => void;
  } = $props();

  function isMine(m: MessageRow): boolean {
    const mine = app.accounts.map((a) => a.email.toLowerCase());
    return !!m.from && mine.includes(m.from.email.toLowerCase());
  }

  function roleOf(m: MessageRow) {
    return app.folder(m.account_id, m.folder)?.role;
  }
</script>

{#snippet card(m: MessageRow)}
  {@const pic = avatarOf(m.account_id, m.from?.email, false)}
  <button class="card" class:unread={!m.flags.seen} onclick={() => app.open(m.id)}>
    <span class="mini" class:pic style:background={pic ? null : avatarColor(m.from?.email ?? "")}>
      {#if pic}<img src={pic} alt="" />{:else}{initials(m.from)}{/if}
    </span>
    <span class="who">{isMine(m) ? t("list.me") : (m.from?.name ?? m.from?.email ?? "")}</span>
    {#if roleOf(m) === "drafts"}<span class="draft-tag">{t("conv.draft")}</span>
    {:else if roleOf(m) === "sent" && !isMine(m)}<span class="muted">· {t("conv.youReplied")}</span>{/if}
    <span class="when muted">{listDate(m.date)}</span>
  </button>
{/snippet}

{#if folded}
  {@render card(messages[0])}
  <button class="card more" onclick={onShowAll}><span class="more-line"></span>{tn("conv.more", folded)}<span class="more-line"></span></button>
  {#each messages.slice(-1) as m (m.id)}{@render card(m)}{/each}
{:else}
  {#each messages as m (m.id)}{@render card(m)}{/each}
{/if}

<style>
  .card {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 9px 12px;
    border: none;
    border-bottom: 1px solid var(--line);
    background: none;
    text-align: left;
    font-size: 13px;
  }

  .card:last-child {
    border-bottom: none;
  }

  .card:hover {
    background: var(--hover);
  }

  .card.unread .who {
    font-weight: 650;
  }

  .card .when {
    margin-left: auto;
    font-size: 12px;
  }

  .card.more {
    justify-content: center;
    color: var(--muted);
    font-size: 12px;
    padding: 6px 12px;
  }

  .more-line {
    flex: 1;
    height: 1px;
    background: var(--line);
  }

  .draft-tag {
    color: var(--accent);
    font-weight: 600;
    font-size: 12px;
  }

  .mini {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }

  /* A photo fills the circle; logos are drawn for a white ground. */
  .mini.pic {
    background: #fff;
    overflow: hidden;
    box-shadow: inset 0 0 0 1px var(--line);
  }

  .mini.pic img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
</style>
