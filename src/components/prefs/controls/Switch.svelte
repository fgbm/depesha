<script lang="ts">
  // The switch of a settings row (#102): on or off, one look everywhere.
  let {
    checked,
    label,
    disabled = false,
    onchange,
  }: { checked: boolean; label: string; disabled?: boolean; onchange: (on: boolean) => void } = $props();
</script>

<!-- The row is the one stop of the keyboard (arrows walk the rows): the switch is for the pointer. -->
<button type="button" class="sw" role="switch" aria-checked={checked} aria-label={label} tabindex="-1" {disabled} onclick={() => onchange(!checked)}></button>

<style>
  .sw {
    position: relative;
    flex: none;
    width: 36px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 10px;
    background: color-mix(in srgb, var(--muted) 45%, var(--paper));
    cursor: pointer;
    transition: background 0.12s;
  }

  .sw::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 2px rgb(0 0 0 / 30%);
    transition: left 0.12s;
  }

  .sw[aria-checked="true"] {
    background: var(--link);
  }

  .sw[aria-checked="true"]::after {
    left: 18px;
  }

  .sw:disabled {
    cursor: default;
  }
</style>
