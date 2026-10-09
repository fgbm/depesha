<script lang="ts">
  // The themes as tiles with a swatch of their colours: a theme is picked by the eye, so it is
  // the one choice of the window that is not a list or segments (#102, 1.5 А).
  let {
    themes,
    value,
    label,
    disabled = false,
    onpick,
  }: {
    themes: { value: string; label: string }[];
    value: string;
    label: string;
    disabled?: boolean;
    onpick: (value: string) => void;
  } = $props();
</script>

<div class="themes" role="radiogroup" aria-label={label}>
  {#each themes as th (th.value)}
    <button type="button" class="tile" role="radio" aria-checked={th.value === value} tabindex="-1" {disabled} onclick={() => onpick(th.value)}>
      <span class="swatch {th.value}" aria-hidden="true"><i></i><b></b></span>
      {th.label}
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
    border: 1px solid transparent;
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
    border-color: var(--accent);
  }

  .tile:disabled {
    cursor: default;
  }

  /* Swatch colours repeat --side and --paper of each theme in app.css. */
  .swatch {
    display: flex;
    width: 64px;
    height: 40px;
    border-radius: 6px;
    overflow: hidden;
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 12%);
  }

  .swatch i {
    width: 35%;
    background: var(--s);
  }

  .swatch b {
    flex: 1;
    background: var(--p);
  }

  .swatch.paper {
    --s: #1f2a37;
    --p: #faf7f1;
  }

  .swatch.night {
    --s: #11161c;
    --p: #171a1f;
  }

  .swatch.snow {
    --s: #f3f4f6;
    --p: #ffffff;
  }

  .swatch.graphite {
    --s: #26272b;
    --p: #1c1c1e;
  }

  .swatch.system {
    --s: #1f2a37;
    --p: linear-gradient(135deg, #faf7f1 50%, #171a1f 50%);
  }
</style>
