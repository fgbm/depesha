<script lang="ts">
  // A quiet line under a letter written in Markdown: it goes out in more parts than usual.
  // A click shows what the recipient gets. Nothing to choose: the parts are always the same.
  import Info from "@lucide/svelte/icons/info";
  import { t } from "../lib/i18n.svelte";

  /** In the order they go: the recipient's program shows the last one it can. */
  const PARTS = ["multipart/alternative", "├ text/plain; charset=utf-8", "├ text/markdown; charset=utf-8; variant=CommonMark", "└ text/html; charset=utf-8"];

  let open = $state(false);
  let box = $state<HTMLDivElement | null>(null);

  function onWindowDown(e: PointerEvent) {
    if (open && !box?.contains(e.target as Node)) open = false;
  }

  function onKey(e: KeyboardEvent) {
    if (open && e.key === "Escape") {
      e.stopPropagation();
      open = false;
    }
  }
</script>

<svelte:window onpointerdown={onWindowDown} />

<div class="md-note" bind:this={box} role="presentation" onkeydown={onKey}>
  <button class="line" aria-expanded={open} onclick={() => (open = !open)}>
    <Info size={13} /><span>{t("compose.markdown.note")}</span>
  </button>
  {#if open}
    <div class="parts" role="note">
      <b>{t("compose.markdown.partsTitle")}</b>
      <p>{t("compose.markdown.partsNote")}</p>
      <pre>{PARTS.join("\n")}</pre>
    </div>
  {/if}
</div>

<style>
  .md-note {
    position: relative;
    border-top: 1px solid var(--line);
  }

  .line {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 18px;
    border: none;
    background: none;
    font-size: 12px;
    color: var(--muted);
    text-align: left;
    cursor: pointer;
  }

  .line:hover {
    color: var(--ink);
  }

  .line :global(svg) {
    flex: none;
  }

  .parts {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: calc(100% + 4px);
    z-index: 3;
    max-width: 520px;
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper);
    box-shadow: 0 6px 24px rgb(0 0 0 / 16%);
    font-size: 12.5px;
  }

  .parts p {
    margin: 4px 0 8px;
    color: var(--muted);
  }

  .parts pre {
    margin: 0;
    font: 12px/1.5 ui-monospace, "DejaVu Sans Mono", Consolas, monospace;
    white-space: pre-wrap;
    user-select: text;
  }
</style>
