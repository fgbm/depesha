<script lang="ts">
  import type { Command, PluginContext } from "@depesha/plugin-api";
  import { palette } from "./state.svelte";
  import { rank, recency } from "./rank";

  let { ctx }: { ctx: PluginContext } = $props();

  const S = {
    title: { en: "Commands", ru: "Команды" },
    placeholder: { en: "What to do? E.g. “sno tom” or “mov arch”", ru: "Что сделать? Например: «отл завт» или «пер архив»" },
    none: { en: "No such command", ru: "Нет такой команды" },
  };

  let query = $state("");
  let active = $state(0);
  let input = $state<HTMLInputElement | null>(null);

  /** The best matches, the ones used last first among equals: what was run before is near. */
  const shown = $derived(palette.open ? rank(ctx.commands(), query, recency).slice(0, 12) : []);

  $effect(() => {
    void query;
    active = 0;
  });

  $effect(() => {
    if (palette.open) {
      query = "";
      queueMicrotask(() => input?.focus());
    }
  });

  function run(c: Command | undefined) {
    if (!c) return;
    palette.open = false;
    recency.touch(c.id);
    c.run();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(shown.length - 1, active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(0, active - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(shown[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      palette.open = false;
    }
  }
</script>

{#if palette.open}
  <div class="backdrop" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && (palette.open = false)}>
    <div class="palette" role="dialog" aria-label={ctx.t(S.title)}>
      <input class="q" bind:this={input} bind:value={query} onkeydown={onKey} placeholder={ctx.t(S.placeholder)} />
      <div class="items" role="listbox">
        {#each shown as c, i (c.id)}
          <button class="item" class:active={i === active} role="option" aria-selected={i === active} onpointermove={() => (active = i)} onclick={() => run(c)}>
            <span>{c.title()}</span>
            {#if c.hint}<span class="hint">{c.hint()}</span>{/if}
          </button>
        {:else}
          <div class="none muted">{ctx.t(S.none)}</div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 25%);
    z-index: 60;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
  }

  .palette {
    width: min(620px, calc(100vw - 40px));
    background: var(--paper);
    border-radius: 10px;
    box-shadow: 0 20px 50px rgb(0 0 0 / 30%);
    overflow: hidden;
  }

  .q {
    width: 100%;
    border: none;
    border-bottom: 1px solid var(--line);
    padding: 14px 16px;
    font-size: 16px;
    outline: none;
    background: transparent;
  }

  .items {
    max-height: 60vh;
    overflow-y: auto;
    padding: 4px;
  }

  .item {
    display: flex;
    width: 100%;
    align-items: center;
    border: none;
    background: none;
    text-align: left;
    padding: 8px 12px;
    border-radius: 6px;
  }

  .item.active {
    background: var(--selected);
  }

  .hint {
    margin-left: auto;
    padding-left: 16px;
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
  }

  .none {
    padding: 14px;
  }
</style>
