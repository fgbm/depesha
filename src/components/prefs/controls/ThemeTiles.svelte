<script lang="ts">
  // The looks as tiles with a swatch of their colours: a look is picked by the eye, so it is
  // the one choice of the window that is not a list or segments (#102, 1.5 А). A swatch is
  // painted by the look's own tokens (data-palette in app.css), in the light chosen now.
  let {
    looks,
    value,
    light,
    label,
    disabled = false,
    onpick,
  }: {
    looks: { value: string; label: string }[];
    value: string;
    light: "light" | "dark";
    label: string;
    disabled?: boolean;
    onpick: (value: string) => void;
  } = $props();
</script>

<div class="themes" role="radiogroup" aria-label={label}>
  {#each looks as look (look.value)}
    <button type="button" class="tile" role="radio" aria-checked={look.value === value} tabindex="-1" {disabled} onclick={() => onpick(look.value)}>
      <span class="swatch" data-palette="{look.value}-{light}" aria-hidden="true"><i></i><b><em></em></b></span>
      {look.label}
    </button>
  {/each}
</div>

<style>
  .themes {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 6px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .tile:hover:not(:disabled) {
    background: var(--hover);
  }

  .tile[aria-checked="true"] {
    border-color: var(--accent-text);
  }

  .tile:disabled {
    cursor: default;
  }

  .swatch {
    display: flex;
    width: 64px;
    height: 40px;
    border-radius: 6px;
    overflow: hidden;
    box-shadow: inset 0 0 0 1px var(--line);
  }

  .swatch i {
    width: 35%;
    background: var(--side);
  }

  .swatch b {
    flex: 1;
    display: flex;
    align-items: flex-end;
    padding: 6px;
    background: var(--paper);
  }

  /* The accent as «Write» wears it. */
  .swatch em {
    width: 100%;
    height: 7px;
    border-radius: 3px;
    background: var(--accent);
  }
</style>
