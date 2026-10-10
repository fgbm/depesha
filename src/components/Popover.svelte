<script lang="ts">
  import type { Snippet } from "svelte";
  import { GAP, MARGIN, placeMenu, type Anchor } from "../lib/anchor";

  let {
    open = $bindable(false),
    align = "right",
    matchWidth = false,
    role = "menu",
    at = null,
    beside = false,
    tone = "paper",
    children,
  }: {
    open: boolean;
    align?: "left" | "right";
    matchWidth?: boolean;
    role?: "menu" | "listbox";
    /** A context menu opens at this point of the window instead of under its parent; a menu opened by a key, under the row it is for (#96). */
    at?: Anchor | null;
    /** To the right of its parent, level with it (a flyout from the sidebar strip). */
    beside?: boolean;
    /** "side": in the sidebar's colours, as a part of it. */
    tone?: "paper" | "side";
    children: Snippet;
  } = $props();

  let box = $state<HTMLDivElement | null>(null);
  /** Fixed coordinates: a dialog's `overflow: hidden` does not cut the menu off. */
  let pos = $state<{ left: number; top: number; maxHeight: number; minWidth: number } | null>(null);

  /** Below the trigger when it fits, otherwise on the side with more room. */
  function place() {
    const anchor = box?.parentElement;
    if (!box || !anchor) return;
    const w = box.offsetWidth;
    const h = box.scrollHeight;
    if (at) {
      // A context menu opens to the right of the pointer, to its left near the edge; a menu
      // opened by a key hangs under the selected row, or over it (#96).
      const p = placeMenu(at, { w, h }, { w: window.innerWidth, h: window.innerHeight });
      pos = { left: p.left, top: p.top, maxHeight: p.maxHeight, minWidth: 0 };
      return;
    }
    const r = anchor.getBoundingClientRect();
    if (beside) {
      const maxHeight = window.innerHeight - 2 * MARGIN;
      const top = Math.max(MARGIN, Math.min(r.top - GAP, window.innerHeight - MARGIN - Math.min(h, maxHeight)));
      pos = { left: Math.min(r.right + GAP, window.innerWidth - w - MARGIN), top, maxHeight, minWidth: 0 };
      return;
    }
    const below = window.innerHeight - r.bottom - GAP - MARGIN;
    const above = r.top - GAP - MARGIN;
    const down = h <= below || below >= above;
    const maxHeight = Math.max(80, down ? below : above);
    const top = down ? r.bottom + GAP : r.top - GAP - Math.min(h, maxHeight);
    const want = align === "left" ? r.left : r.right - w;
    const left = Math.min(Math.max(MARGIN, want), window.innerWidth - w - MARGIN);
    pos = { left, top, maxHeight, minWidth: matchWidth ? r.width : 0 };
  }

  /** Where the focus was before the menu took it; Escape gives it back. */
  let before: HTMLElement | null = null;

  $effect(() => {
    if (!open || !box) {
      pos = null;
      return;
    }
    // A context menu moves with every right click.
    void at;
    before = document.activeElement as HTMLElement | null;
    place();
    // The first item that is current (a select's value, the ticked one of a radio list), or the first one: arrows go on from there.
    const first = box.querySelector<HTMLElement>("[aria-selected='true'], button.mi[aria-checked='true']") ?? items()[0];
    let frame = 0;
    if (first) {
      first.focus({ preventScroll: true });
      box.scrollTop = Math.max(0, first.offsetTop - box.clientHeight / 2);
      // Still `visibility: hidden` until the position is applied: a hidden item takes no focus, so a frame later.
      if (document.activeElement !== first) frame = requestAnimationFrame(() => open && first.focus({ preventScroll: true }));
    }
    return () => cancelAnimationFrame(frame);
  });

  // A flyout grows in place (the folder tree under «All folders»): it is placed again to stay in the window.
  $effect(() => {
    if (!open || !box || !beside) return;
    const watch = new MutationObserver(() => place());
    watch.observe(box, { childList: true, subtree: true });
    return () => watch.disconnect();
  });

  function outside(e: PointerEvent) {
    // The trigger toggles by itself; clicks inside stay inside. A context menu has no trigger.
    const inside = at ? box : box?.parentElement;
    if (open && box && !inside?.contains(e.target as Node)) open = false;
  }

  function items(): HTMLElement[] {
    return box ? [...box.querySelectorAll<HTMLElement>("button.mi:not(:disabled), button[role='menuitem']:not(:disabled), button[role='menuitemcheckbox']:not(:disabled)")] : [];
  }

  // Capture: the menu gets Escape before the dialog it sits in would close.
  function onKey(e: KeyboardEvent) {
    if (!open) return;
    // A field marked `data-own` keeps its keys: the card's name being written takes Esc and the arrows itself.
    if ((document.activeElement as HTMLElement | null)?.dataset?.own !== undefined) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      open = false;
      before?.focus();
      return;
    }
    if (!box?.contains(document.activeElement)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      const list = items();
      if (!list.length) return;
      e.preventDefault();
      e.stopPropagation();
      // A row's own button (a file's «Save») stands in for the row's item: ↑↓ go on from the row.
      const at = document.activeElement as HTMLElement;
      const row = at.closest("[data-menu-row]");
      const i = list.findIndex((el) => el === at || (row !== null && row.contains(el)));
      const next =
        e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : e.key === "ArrowDown" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[next].focus();
    } else if (e.key === "Tab") {
      open = false;
    }
  }
</script>

<svelte:window
  onpointerdown={outside}
  onkeydowncapture={onKey}
  onresize={() => open && place()}
  onscrollcapture={(e) => {
    // A scrolled list would leave the menu hanging away from its button. A context
    // menu stays: opening the row scrolls the app by itself; only the user's wheel closes it.
    if (open && !at && box && !box.contains(e.target as Node)) open = false;
  }}
  onwheel={(e) => {
    if (open && at && box && !box.contains(e.target as Node)) open = false;
  }}
/>

{#if open}
  <div
    class="pop"
    class:side={tone === "side"}
    bind:this={box}
    {role}
    style:left={pos ? `${pos.left}px` : "0"}
    style:top={pos ? `${pos.top}px` : "0"}
    style:max-height={pos ? `${pos.maxHeight}px` : undefined}
    style:min-width={pos?.minWidth ? `${pos.minWidth}px` : undefined}
    style:visibility={pos ? "visible" : "hidden"}
  >
    {@render children()}
  </div>
{/if}

<style>
  .pop {
    position: fixed;
    /* Over toasts; a menu inside a dialog stays inside the dialog's layer. */
    z-index: 45;
    min-width: 200px;
    max-width: min(420px, calc(100vw - 16px));
    overflow-y: auto;
    background: var(--paper);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: 0 10px 28px rgb(0 0 0 / 18%);
    padding: 4px;
    display: flex;
    flex-direction: column;
    text-align: left;
    font-size: 14px;
    font-weight: 400;
  }

  .pop.side {
    background: var(--side);
    color: var(--side-ink);
    border-color: color-mix(in srgb, var(--side-ink) 14%, transparent);
    box-shadow: 0 10px 28px rgb(0 0 0 / 32%);
  }

  .pop :global(button.mi) {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    width: 100%;
    border: none;
    background: none;
    color: var(--ink);
    text-align: left;
    padding: 6px 10px;
    border-radius: 5px;
    white-space: nowrap;
  }

  .pop :global(button.mi:hover),
  .pop :global(button.mi:focus-visible) {
    background: var(--hover);
    outline: none;
  }

  .pop :global(button.mi:disabled) {
    opacity: 0.5;
    cursor: default;
  }

  .pop :global(.mi .hint) {
    margin-left: auto;
    padding-left: 16px;
    color: var(--muted);
    font-size: 12px;
  }

  .pop :global(hr) {
    flex: none;
    width: auto;
    border: none;
    border-top: 1px solid var(--line);
    margin: 4px 2px;
  }

  .pop :global(.mt) {
    padding: 6px 10px 2px;
    font-size: 12px;
    color: var(--muted);
  }
</style>
