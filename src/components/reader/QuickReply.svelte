<script lang="ts">
  // The quick answer under the conversation: one wide bar that turns into the answer by a
  // click, unfolded into a window when it grows. The state and the actions live in
  // useQuickReply; this is its markup, so the wording of the answer stays in a component.
  import Reply from "@lucide/svelte/icons/reply";
  import ReplyAll from "@lucide/svelte/icons/reply-all";
  import Trash from "@lucide/svelte/icons/trash-2";
  import { addrFull } from "../../lib/format";
  import { t } from "../../lib/i18n.svelte";
  import { shortcuts } from "../../lib/shortcuts.svelte";
  import type { QuickReplyState } from "./useQuickReply.svelte";

  let {
    state: answer,
    manyRecipients,
  }: {
    state: QuickReplyState;
    /** "All" reaches someone a plain reply does not: the button is offered. */
    manyRecipients: boolean;
  } = $props();

  const q = $derived(answer.quick);

  // The box grows upwards, so its grip is at the top: dragged up, the answer gets taller.
  const MIN = 96;
  const STEP = 24;
  let height = $state<number | null>(null);
  const max = () => Math.max(MIN, Math.round(window.innerHeight * 0.6));
  const fit = (h: number) => Math.min(max(), Math.max(MIN, Math.round(h)));

  function grab(e: PointerEvent) {
    if (e.button !== 0 || !answer.box) return;
    e.preventDefault();
    const grip = e.currentTarget as HTMLElement;
    const y0 = e.clientY;
    const h0 = answer.box.offsetHeight;
    grip.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => (height = fit(h0 + y0 - m.clientY));
    const done = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", done);
      grip.removeEventListener("pointercancel", done);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", done);
    grip.addEventListener("pointercancel", done);
  }

  function nudge(e: KeyboardEvent) {
    const by = e.key === "ArrowUp" ? STEP : e.key === "ArrowDown" ? -STEP : 0;
    if (!by || !answer.box) return;
    // The arrows are the grip's here, not the list's: the letter stays.
    e.preventDefault();
    e.stopPropagation();
    height = fit(answer.box.offsetHeight + by);
  }
</script>

<div class="quick">
  {#if q}
    <div class="quick-box">
      <div class="quick-to muted">
        {#if q.all}<ReplyAll size={14} />{:else}<Reply size={14} />{/if}
        <span class="quick-who">{[...q.draft.to, ...q.draft.cc].map(addrFull).join(", ")}</span>
        {#if manyRecipients}
          <button class="quick-all" class:on={q.all} aria-pressed={q.all} onclick={() => answer.setAll(!q.all)} title={shortcuts.titled(t("act.replyAllHint"), "core.reply-all")}>{t("act.replyAll")}</button>
        {/if}
      </div>
      <div class="answer">
        <!-- A focusable separator is a splitter (ARIA): it moves with the arrow keys. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
        <div class="grip" role="separator" aria-orientation="horizontal" aria-label={t("reader.resizeAnswer")} title={t("reader.resizeAnswer")} aria-valuenow={height ?? MIN} aria-valuemin={MIN} tabindex="0" onpointerdown={grab} onkeydown={nudge}></div>
        <textarea style:height={height === null ? null : `${height}px`} bind:this={answer.box} bind:value={answer.text} onkeydown={(e) => answer.onKey(e)} spellcheck="true" rows="4" placeholder={t("compose.bodyPlaceholder")}></textarea>
      </div>
      <div class="quick-actions">
        <button class="btn primary" onclick={() => answer.send()} disabled={answer.busy || !answer.text.trim()}>{t("compose.send")}</button>
        <button class="btn ghost" onclick={() => answer.toWindow()}>{t("reader.toWindow")}</button>
        <span class="sep"></span>
        <button class="btn ghost icon" onclick={() => { answer.quick = null; answer.text = ""; }} title={t("compose.discardDraft")} aria-label={t("compose.discardDraft")}><Trash size={15} /></button>
      </div>
    </div>
  {:else}
    <button class="quick-bar" onclick={() => answer.openQuick(false)}><Reply size={16} /> {t("act.reply")}</button>
  {/if}
</div>

<style>
  .sep {
    flex: 1;
  }

  .icon {
    min-width: 32px;
    justify-content: center;
    font-size: 15px;
  }

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

  .answer {
    position: relative;
    display: flex;
  }

  .quick-box textarea {
    width: 100%;
    border: none;
    outline: none;
    resize: none;
    min-height: 96px;
    padding: 10px 26px 10px 14px;
    background: transparent;
    line-height: 1.55;
    user-select: text;
  }

  /* The native corner grip, mirrored to the top: two strokes across the corner. */
  .grip {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 14px;
    height: 14px;
    border-radius: 3px;
    cursor: ns-resize;
    touch-action: none;
    color: var(--muted);
    --stroke: linear-gradient(45deg, transparent calc(50% - 0.7px), currentColor calc(50% - 0.7px) calc(50% + 0.7px), transparent calc(50% + 0.7px));
    background:
      var(--stroke) top 2px right 2px / 10px 10px no-repeat,
      var(--stroke) top 2px right 2px / 5px 5px no-repeat;
    opacity: 0.6;
  }

  .grip:hover,
  .grip:focus-visible {
    opacity: 1;
  }

  .quick-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px 10px 14px;
  }
</style>
