<script lang="ts" generics="T">
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Popover from "./Popover.svelte";

  // A drop-down list drawn like the app's menus, in place of the system <select>.
  let {
    value = $bindable(),
    options,
    onchange,
    title,
    label,
    disabled = false,
    tabindex,
    class: cls = "",
  }: {
    value: T;
    options: { value: T; label: string }[];
    onchange?: (value: T) => void;
    title?: string;
    /** Accessible name when no <label> wraps the list. */
    label?: string;
    disabled?: boolean;
    /** -1 takes the list out of the Tab order (a row of the settings is the one stop). */
    tabindex?: number;
    class?: string;
  } = $props();

  let open = $state(false);
  const current = $derived(options.find((o) => o.value === value));

  function pick(v: T) {
    open = false;
    trigger?.focus();
    if (v === value) return;
    value = v;
    onchange?.(v);
  }

  let trigger = $state<HTMLButtonElement | null>(null);

  function onKey(e: KeyboardEvent) {
    if (open || disabled) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      open = true;
    }
  }
</script>

<div class="select {cls}" data-value={String(value)}>
  <button
    bind:this={trigger}
    type="button"
    class="input trigger"
    class:open
    {disabled}
    {tabindex}
    {title}
    aria-label={label}
    aria-haspopup="listbox"
    aria-expanded={open}
    onclick={() => (open = !open)}
    onkeydown={onKey}
  >
    <span class="text">{current?.label ?? ""}</span>
    <ChevronDown size={14} />
  </button>
  <Popover bind:open align="left" matchWidth role="listbox">
    {#each options as o (o.value)}
      <button class="mi" role="option" aria-selected={o.value === value} data-value={String(o.value)} onclick={() => pick(o.value)}>
        <span class="text">{o.label}</span>
        {#if o.value === value}<span class="hint"><Check size={14} /></span>{/if}
      </button>
    {/each}
  </Popover>
</div>

<style>
  .select {
    display: inline-flex;
    min-width: 0;
  }

  .trigger {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 4px 9px;
    text-align: left;
    color: var(--ink);
    cursor: pointer;
    user-select: none;
  }

  .trigger :global(svg) {
    flex: none;
    margin-left: auto;
    color: var(--muted);
    transition: transform 0.12s;
  }

  .trigger.open :global(svg) {
    transform: rotate(180deg);
  }

  .trigger:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
