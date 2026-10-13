<script lang="ts">
  // One side of the conversation read as an accordion (0.8.4, #180; decision 4.0 Б): the far
  // history folds into «Ещё N писем», and every letter is drawn by ThreadLetter — a folded row or
  // an unfolded one with its own header and buttons. The pane (Reader.svelte) frames the group and
  // keeps the letter that is open; this holds which letters of its own side are unfolded, and asks
  // the backend for a letter's body when it unfolds.
  import { untrack } from "svelte";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ThreadLetter from "./ThreadLetter.svelte";
  import { api } from "../../lib/api";
  import { app } from "../../lib/store.svelte";
  import { tn } from "../../lib/i18n.svelte";
  import type { MessageRow, OpenedMessage } from "../../lib/types";

  let {
    messages,
    folded = 0,
    foldAt = "top",
    onShowAll,
    focusId,
    onReply,
    onForward,
  }: {
    /** The letters of this group, oldest first. */
    messages: MessageRow[];
    /** How many letters at the far end of the group «Ещё N писем» hides; 0 shows every row. */
    folded?: number;
    /** Where the far end is: the top of the group above the open letter, the bottom below it.
     *  Each side shows the letters nearest the open one and folds the far ones away. */
    foldAt?: "top" | "bottom";
    /** «Ещё N писем» unfolds the far letters. */
    onShowAll?: () => void;
    /** The letter the pane has open: the one that is unfolded by default (4.1 Б). */
    focusId: number;
    /** Answering a letter unfolded here: the pane replies for the letter it has open. */
    onReply: (all: boolean) => void;
    onForward: () => void;
  } = $props();

  /** The letters unfolded here; the letter the pane has open is not among them. */
  let unfolded = $state<Set<number>>(new Set());
  /** The bodies of the unfolded letters, asked of the backend as they unfold. */
  let bodies = $state<Map<number, OpenedMessage>>(new Map());
  /** The letter the accordion was unfolded around: another one closes it again. */
  let openedFor = $state<number | null>(null);

  // The unfolded letters close again when another letter becomes the one open, as the pane's own
  // folds do: the accordion is about the letter read now.
  $effect(() => {
    const id = focusId;
    untrack(() => {
      if (openedFor === id) return;
      openedFor = id;
      unfolded = new Set();
      bodies = new Map();
    });
  });

  // The far letters fold away; the ones nearest the open letter show.
  const shown = $derived(!folded ? messages : foldAt === "bottom" ? messages.slice(0, messages.length - folded) : messages.slice(folded));

  /** Unfolds a letter here, or folds it back; a letter unfolded is a letter read (4.0 Б). */
  function toggle(m: MessageRow) {
    if (unfolded.has(m.id)) {
      const next = new Set(unfolded);
      next.delete(m.id);
      unfolded = next;
      return;
    }
    unfolded = new Set(unfolded).add(m.id);
    app.reader.saw([m.id]);
    if (bodies.has(m.id)) return;
    void api.open(m.id, false)
      .then((o) => (bodies = new Map(bodies).set(m.id, o)))
      .catch((e) => app.ui.fail(e));
  }

  /** Answering a letter unfolded here: it becomes the letter the pane has open, and the pane
   *  answers for it (4.3 А — the quick reply stays with one letter). */
  async function reply(m: MessageRow, all: boolean) {
    if (m.id !== focusId) await app.reader.open(m.id);
    onReply(all);
  }

  async function forward(m: MessageRow) {
    if (m.id !== focusId) await app.reader.open(m.id);
    onForward();
  }
</script>

{#if folded && foldAt === "top"}
  <button class="more" onclick={onShowAll}><ChevronDown size={14} /> {tn("conv.more", folded)}</button>
{/if}

{#each shown as m (m.id)}
  <ThreadLetter {m} open={unfolded.has(m.id)} body={bodies.get(m.id)} onToggle={() => toggle(m)} onReply={(all) => void reply(m, all)} onForward={() => void forward(m)} />
{/each}

{#if folded && foldAt === "bottom"}
  <button class="more" onclick={onShowAll}><ChevronDown size={14} /> {tn("conv.more", folded)}</button>
{/if}

<style>
  /* «Ещё N писем»: the far letters of this side folded into one row at their end. */
  .more {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    padding: 7px 12px;
    border: none;
    border-bottom: 1px solid var(--line);
    background: none;
    color: var(--muted);
    font-size: 13px;
  }

  /* Below the open letter the far end is the bottom: the row closes the group from there. */
  .more:last-child {
    border-bottom: none;
    border-top: 1px solid var(--line);
  }

  .more:hover {
    background: var(--hover);
    color: var(--ink);
  }
</style>
