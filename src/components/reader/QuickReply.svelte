<script lang="ts">
  // The quick answer under the conversation: one wide bar that turns into the answer by a
  // click, unfolded into a window when it grows. The state and the actions live in
  // useQuickReply; this is its markup, so the wording of the answer stays in a component.
  import Reply from "@lucide/svelte/icons/reply";
  import ReplyAll from "@lucide/svelte/icons/reply-all";
  import Trash from "@lucide/svelte/icons/trash-2";
  import { addrFull } from "../../lib/format";
  import { t } from "../../lib/i18n.svelte";
  import type { QuickReplyState } from "./useQuickReply.svelte";

  let {
    state,
    manyRecipients,
  }: {
    state: QuickReplyState;
    /** "All" reaches someone a plain reply does not: the button is offered. */
    manyRecipients: boolean;
  } = $props();

  const q = $derived(state.quick);
</script>

<div class="quick">
  {#if q}
    <div class="quick-box">
      <div class="quick-to muted">
        {#if q.all}<ReplyAll size={14} />{:else}<Reply size={14} />{/if}
        <span class="quick-who">{[...q.draft.to, ...q.draft.cc].map(addrFull).join(", ")}</span>
        {#if manyRecipients}
          <button class="quick-all" class:on={q.all} aria-pressed={q.all} onclick={() => state.setAll(!q.all)} title={t("act.replyAllHint")}>{t("act.replyAll")}</button>
        {/if}
      </div>
      <textarea bind:this={state.box} bind:value={state.text} onkeydown={(e) => state.onKey(e)} spellcheck="true" rows="4" placeholder={t("compose.bodyPlaceholder")}></textarea>
      <div class="quick-actions">
        <button class="btn primary" onclick={() => state.send()} disabled={state.busy || !state.text.trim()}>{t("compose.send")} <kbd>Ctrl+Enter</kbd></button>
        <button class="btn ghost" onclick={() => state.toWindow()}>{t("reader.toWindow")}</button>
        <span class="sep"></span>
        <button class="btn ghost icon" onclick={() => { state.quick = null; state.text = ""; }} title={t("compose.discardDraft")} aria-label={t("compose.discardDraft")}><Trash size={15} /></button>
      </div>
    </div>
  {:else}
    <button class="quick-bar" onclick={() => state.openQuick(false)}><Reply size={16} /> {t("act.reply")}</button>
  {/if}
</div>

<style>
  .quick {
    flex: none;
    display: flex;
    gap: 8px;
    margin: 10px 22px 16px;
  }

  /* One wide bar that reads as a field: a click turns it into the answer. */
  .quick-bar {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 13px 16px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--paper);
    color: var(--muted);
    text-align: left;
  }

  .quick-bar:hover {
    color: var(--ink);
    border-color: color-mix(in srgb, var(--ink) 22%, var(--line));
  }

  .quick-who {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .quick-all {
    flex: none;
    padding: 2px 10px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: none;
    color: var(--muted);
    font-size: 12px;
  }

  .quick-all.on {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, var(--paper));
    color: var(--ink);
  }

  .quick-box {
    flex: 1;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--paper);
    box-shadow: 0 2px 10px rgb(0 0 0 / 6%);
  }

  .quick-to {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px 0;
    font-size: 13px;
    white-space: nowrap;
  }

  .quick-box textarea {
    border: none;
    outline: none;
    resize: vertical;
    min-height: 96px;
    padding: 10px 14px;
    background: transparent;
    line-height: 1.55;
    user-select: text;
  }

  .quick-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px 10px 14px;
  }

  .quick-actions kbd {
    border-color: rgb(255 255 255 / 40%);
    color: var(--accent-ink);
  }
</style>
