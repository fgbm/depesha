<script lang="ts">
  // Выбор цвета метки (#42, кадр 5Б): палитра и свой цвет в той же строке. Цвет живёт
  // только в Депеше; выбранный применяется сразу.
  import { t } from "../lib/i18n.svelte";
  import { LABEL_PALETTE } from "../lib/format";
  import type { Label } from "../lib/types";
  import Popover from "./Popover.svelte";
  import { labels } from "../lib/labels.svelte";

  let {
    at,
    account,
    label,
    onclose,
  }: {
    at: { x: number; y: number };
    account: string;
    label: Label;
    onclose: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let color = $state(label.color || LABEL_PALETTE[0]);

  async function pick(value: string) {
    color = value;
    await labels.save(account, label.name, value);
    onclose();
  }
</script>

<Popover {at} bind:open={() => true, (v) => !v && onclose()}>
  <div class="mt">{t("label.color")} · {label.name}</div>
  <div class="palette">
    {#each LABEL_PALETTE as c (c)}
      <button class="sw" class:on={c.toLowerCase() === color.toLowerCase()} style:--c={c} title={c} aria-label={c} onclick={() => pick(c)}></button>
    {/each}
  </div>
  <label class="own">
    <input type="color" bind:value={color} onchange={() => pick(color)} />
    <span class="mono">{color}</span>
    <span class="muted">{t("label.customColor")}</span>
  </label>
</Popover>

<style>
  .palette {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 10px;
  }

  .sw {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--ink) 18%, transparent);
    background: var(--c);
    padding: 0;
  }

  .sw.on {
    box-shadow: inset 0 0 0 2px var(--paper), 0 0 0 2px var(--link);
  }

  .own {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px 8px;
    font-size: 12px;
  }

  .own input[type="color"] {
    width: 28px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: none;
  }

  .mono {
    font-family: var(--mono);
  }
</style>
