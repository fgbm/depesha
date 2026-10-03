<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    open = $bindable(false),
    align = "right",
    matchWidth = false,
    role = "menu",
    children,
  }: { open: boolean; align?: "left" | "right"; matchWidth?: boolean; role?: "menu" | "listbox"; children: Snippet } = $props();

  let box = $state<HTMLDivElement | null>(null);
  /** Fixed coordinates: a dialog's `overflow: hidden` does not cut the menu off. */
  let pos = $state<{ left: number; top: number; maxHeight: number; minWidth: number } | null>(null);

  const GAP = 4;
  const MARGIN = 8;

  /** Below the trigger when it fits, otherwise on the side with more room. */
  function place() {
    const anchor = box?.parentElement;
    if (!box || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = box.offsetWidth;
    const h = box.scrollHeight;
    const below = window.innerHeight - r.bottom - GAP - MARGIN;
    const above = r.top - GAP - MARGIN;
    const down = h <= below || below >= above;
    const maxHeight = Math.max(80, down ? below : above);
    const top = down ? r.bottom + GAP : r.top - GAP - Math.min(h, maxHeight);
    const left = Math.min(Math.max(MARGIN, align === "left" ? r.left : r.right - w), window.innerWidth - w - MARGIN);
    pos = { left, top, maxHeight, minWidth: matchWidth ? r.width : 0 };
  }

  /** Where the focus was before the menu took it; Escape gives it back. */
  let before: HTMLElement | null = null;

  $effect(() => {
    if (!open || !box) {
      pos = null;
      return;
    }
    before = document.activeElement as HTMLElement | null;
    place();
    // The first item that is current (a select's value), or the first one: arrows go on from there.
    const first = box.querySelector<HTMLElement>("[aria-selected='true']") ?? items()[0];
    if (first) {
      first.focus({ preventScroll: true });
      box.scrollTop = Math.max(0, first.offsetTop - box.clientHeight / 2);
    }
  });

  function outside(e: PointerEvent) {
    // The trigger toggles by itself; clicks inside stay inside.
    if (open && box && !box.parentElement?.contains(e.target as Node)) open = false;
  }

  function items(): HTMLElement[] {
    return box ? [...box.querySelectorAll<HTMLElement>("button.mi:not(:disabled)")] : [];
  }

  // Capture: the menu gets Escape before the dialog it sits in would close.
  function onKey(e: KeyboardEvent) {
    if (!open) return;
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
      const i = list.indexOf(document.activeElement as HTMLElement);
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
    // A scrolled list would leave the menu hanging away from its button.
    if (open && box && !box.contains(e.target as Node)) open = false;
  }}
/>

{#if open}
  <div
    class="pop"
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
