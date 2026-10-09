<script lang="ts">
  // A choice of a few short options, all in sight (#102, 1.1 А): one click, or ← / → on the row.
  let {
    options,
    value,
    label,
    disabled = false,
    onpick,
  }: {
    options: { value: string | number; label: string }[];
    value: string | number;
    label: string;
    disabled?: boolean;
    onpick: (value: string | number) => void;
  } = $props();
</script>

<div class="seg" role="radiogroup" aria-label={label}>
  {#each options as o (o.value)}
    <button type="button" role="radio" aria-checked={o.value === value} tabindex="-1" {disabled} onclick={() => onpick(o.value)}>{o.label}</button>
  {/each}
</div>

<style>
  .seg {
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: 7px;
    overflow: hidden;
    background: var(--paper);
  }

  button {
    padding: 4px 12px;
    border: none;
    border-left: 1px solid var(--line);
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    white-space: nowrap;
    cursor: pointer;
  }

  button:first-child {
    border-left: none;
  }

  button:hover:not(:disabled) {
    background: var(--hover);
  }

  button[aria-checked="true"] {
    background: var(--selected);
    font-weight: 600;
  }

  button:disabled {
    cursor: default;
  }
</style>
