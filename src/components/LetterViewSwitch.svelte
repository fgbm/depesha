<script lang="ts">
  // «HTML · Markdown · Текст» above a letter: a view of the letter, not an action on it,
  // so it stands by the text rather than in the toolbar. A narrow reader folds it into a list.
  import { t } from "../lib/i18n.svelte";
  import type { BodyView } from "../lib/types";
  import Select from "./Select.svelte";

  let { views, value = $bindable() }: { views: BodyView[]; value: BodyView } = $props();

  const options = $derived(views.map((v) => ({ value: v, label: t(`letterView.${v}`) })));
</script>

<div class="letter-view">
  <div class="segments" role="radiogroup" aria-label={t("letterView.title")}>
    {#each options as o (o.value)}
      <button role="radio" aria-checked={value === o.value} class:on={value === o.value} onclick={() => (value = o.value)}>{o.label}</button>
    {/each}
  </div>
  <Select class="list" label={t("letterView.title")} bind:value {options} />
</div>

<style>
  .letter-view {
    display: flex;
    justify-content: flex-end;
    margin: 0 16px 6px;
  }

  .segments {
    display: inline-flex;
    padding: 2px;
    gap: 2px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper-2);
  }

  .segments button {
    border: none;
    background: none;
    color: var(--muted);
    font-size: 12.5px;
    padding: 2px 10px;
    border-radius: 6px;
  }

  .segments button.on {
    background: var(--paper);
    color: var(--ink);
    font-weight: 600;
    box-shadow: 0 1px 2px rgb(0 0 0 / 10%);
  }

  .letter-view :global(.list) {
    display: none;
  }

  .letter-view :global(.list .trigger) {
    border-color: transparent;
    font-size: 12.5px;
  }

  @container (max-width: 520px) {
    .segments {
      display: none;
    }

    .letter-view :global(.list) {
      display: inline-flex;
    }
  }
</style>
