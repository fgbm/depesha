<script module lang="ts">
  import type { Component } from "svelte";

  export interface RowAction {
    /** The word for the button's name and tooltip. */
    label: string;
    icon: Component<{ size?: number }>;
    run: (i: number) => void;
  }
</script>

<script lang="ts">
  // The list of a letter's attachments behind «+N more ›»: the composition window's (a click
  // takes the file off) and the opened letter's (a click shows it). One list for both, so that
  // it is made the same: ↑↓ walk the files, Enter does the row's main thing, → and ← reach the
  // row's own actions (Save), Esc closes. The caller gives the row's meaning and the footer.
  import type { Snippet } from "svelte";
  import Popover from "./Popover.svelte";
  import { size } from "../lib/format";

  let {
    open = $bindable(false),
    title,
    files,
    current = -1,
    rowTitle = "",
    hint,
    actions = [],
    onPick,
    onRowKey,
    footer,
  }: {
    open: boolean;
    title: string;
    files: { name: string; size: number }[];
    /** The row of the file shown now (the opened letter's viewer). */
    current?: number;
    /** The tooltip of a row: what Enter does to it. */
    rowTitle?: string;
    /** The grey text at the row's end; the file's size by default. */
    hint?: (file: { name: string; size: number }) => string;
    /** The row's own buttons, after the name: reached by →. */
    actions?: RowAction[];
    onPick: (i: number) => void;
    onRowKey?: (e: KeyboardEvent, i: number) => void;
    /** Under a rule at the end of the list: «Add files», «Save all». */
    footer?: Snippet;
  } = $props();

  /** → from the name to its first action, ← back; the row's buttons are one stop for ↑↓. */
  function onKey(e: KeyboardEvent, i: number) {
    const row = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-menu-row]");
    const buttons = row ? [...row.querySelectorAll<HTMLElement>("button")] : [];
    const at = buttons.indexOf(e.target as HTMLElement);
    if (actions.length && (e.key === "ArrowRight" || e.key === "ArrowLeft") && at >= 0) {
      const to = buttons[at + (e.key === "ArrowRight" ? 1 : -1)];
      if (to) {
        e.preventDefault();
        e.stopPropagation();
        to.focus();
      }
      return;
    }
    if ((e.target as HTMLElement).dataset.act === undefined) onRowKey?.(e, i);
  }
</script>

<Popover bind:open align="left">
  <div class="mt">{title}</div>
  {#each files as a, i (i)}
    <div class="menu-row" data-menu-row onkeydown={(e) => onKey(e, i)} role="presentation">
      <button class="mi" role="menuitem" data-att={i} class:current={i === current} aria-current={i === current ? "true" : undefined} onclick={() => onPick(i)} title={rowTitle}>
        <span class="fname">{a.name}</span><span class="hint">{hint ? hint(a) : size(a.size)}</span>
      </button>
      {#each actions as act (act.label)}
        <button class="act" data-act tabindex="-1" onclick={() => act.run(i)} title={act.label} aria-label={`${act.label}: ${a.name}`}><act.icon size={14} /></button>
      {/each}
    </div>
  {/each}
  {#if footer}
    <hr />
    {@render footer()}
  {/if}
</Popover>

<style>
  .menu-row {
    display: flex;
    align-items: center;
    flex: none;
    gap: 2px;
  }

  .menu-row :global(button.mi) {
    flex: 1;
    min-width: 0;
    width: auto;
  }

  .fname {
    min-width: 0;
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .current {
    box-shadow: inset 2px 0 0 var(--accent);
  }

  .act {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: none;
    color: var(--muted);
  }

  .act:hover,
  .act:focus-visible {
    background: var(--hover);
    color: var(--ink);
    outline: none;
  }
</style>
