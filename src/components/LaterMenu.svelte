<script lang="ts">
  import { fromLocalInput, toLocalInput, type Preset } from "../lib/later";
  import { t } from "../lib/i18n.svelte";

  let {
    title,
    presets,
    action,
    onPick,
  }: { title: string; presets: Preset[]; action: string; onPick: (at: number) => void } = $props();

  let custom = $state(toLocalInput(Math.floor(Date.now() / 1000) + 3 * 3600));
  const customAt = $derived(fromLocalInput(custom));
</script>

<div class="mt">{title}</div>
{#each presets as p (p.label)}
  <button class="mi" onclick={() => onPick(p.at)}>{p.label}<span class="hint">{p.hint}</span></button>
{/each}
<hr />
<div class="custom">
  <input class="input" type="datetime-local" bind:value={custom} aria-label={t("later.custom")} />
  <button class="btn" disabled={!customAt || customAt * 1000 <= Date.now()} onclick={() => customAt && onPick(customAt)}>{action}</button>
</div>

<style>
  .custom {
    display: flex;
    gap: 6px;
    padding: 4px 6px 6px;
  }

  .custom .input {
    flex: 1;
    min-width: 0;
    font-size: 13px;
  }
</style>
