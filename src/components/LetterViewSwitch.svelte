<script lang="ts">
  // «HTML · Markdown · Текст» above a letter: a view of the letter, not an action on it,
  // so it stands by the text rather than in the toolbar. A narrow reader folds it into a list.
  // Beside it the «▾» of #44 (frame 14А) sets what this sender's letters are shown as always.
  import { t } from "../lib/i18n.svelte";
  import type { BodyView, ViewRule } from "../lib/types";
  import Select from "./Select.svelte";
  import Popover from "./Popover.svelte";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Check from "@lucide/svelte/icons/check";

  let {
    views,
    value = $bindable(),
    rule = null,
    personName = "",
    onRule,
  }: {
    views: BodyView[];
    value: BodyView;
    /** The rule already set for this sender, when there is one. */
    rule?: ViewRule | null;
    personName?: string;
    /** Sets the form this sender's letters are always shown as ("" as usual). */
    onRule?: (view: ViewRule) => void;
  } = $props();

  const options = $derived(views.map((v) => ({ value: v, label: t(`letterView.${v}`) })));

  /** The «▾» menu of frame 14А: as usual, or one form always. */
  const RULES: { value: ViewRule; label: () => string }[] = [
    { value: "", label: () => t("people.asUsual") },
    { value: "markdown", label: () => t("letterView.rule.markdown") },
    { value: "html", label: () => t("letterView.rule.html") },
    { value: "text", label: () => t("letterView.rule.text") },
  ];
  let menu = $state(false);

  function pick(v: ViewRule) {
    menu = false;
    onRule?.(v);
  }
</script>

<div class="letter-view">
  <div class="segments" role="radiogroup" aria-label={t("letterView.title")}>
    {#each options as o (o.value)}
      <button role="radio" aria-checked={value === o.value} class:on={value === o.value} onclick={() => (value = o.value)}>{o.label}</button>
    {/each}
  </div>
  <Select class="list" label={t("letterView.title")} bind:value {options} />
  {#if onRule}
    <span class="anchor">
      <button class="more" title={t("letterView.rule")} aria-label={t("letterView.rule")} aria-haspopup="menu" aria-expanded={menu} onclick={() => (menu = !menu)}>
        <ChevronDown size={14} />
      </button>
      <Popover bind:open={menu}>
        <div class="mt">{t("letterView.rule.title", { name: personName })}</div>
        {#each RULES as r (r.value)}
          <button class="mi" role="menuitemradio" aria-checked={(rule ?? "") === r.value} onclick={() => pick(r.value)}>
            <span class="tick">{#if (rule ?? "") === r.value}<Check size={14} />{/if}</span>{r.label()}
          </button>
        {/each}
      </Popover>
    </span>
  {/if}
</div>

<style>
  .letter-view {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 4px;
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

  .more {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--muted);
  }

  .more:hover {
    background: var(--hover);
  }

  .letter-view :global(.list) {
    display: none;
  }

  .letter-view :global(.list .trigger) {
    border-color: transparent;
    font-size: 12.5px;
  }

  .anchor {
    display: inline-flex;
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
