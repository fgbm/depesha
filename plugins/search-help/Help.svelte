<script lang="ts">
  import type { PluginContext, Text } from "@depesha/plugin-api";
  import { exampleText, filterExamples, filterOperators, operatorText } from "./help";
  import { searchHelp } from "./state.svelte";
  import { S } from "./strings";

  let { ctx }: { ctx: PluginContext } = $props();

  const TIPS: Text[] = [
    { ru: "Условия складываются через пробел: письмо должно подойти под все сразу.", en: "Conditions add up through a space: a letter must match all of them." },
    { ru: "Пробелы в значении — в кавычках: тема:\"годовой отчёт\".", en: "Spaces in a value go in quotes: subject:\"annual report\"." },
    { ru: "в:Папка/* берёт и подпапки, без звёздочки — только саму папку.", en: "in:Folder/* takes subfolders too; without the asterisk, the folder alone." },
    { ru: "Даты — ГГГГ-ММ-ДД, размеры — 25М или 1Г.", en: "Dates are YYYY-MM-DD, sizes 25M or 1G." },
  ];

  let query = $state("");
  let input = $state<HTMLInputElement | null>(null);
  // Another query starts at the first row.
  let active = $derived.by(() => {
    void query;
    return 0;
  });

  const ops = $derived(searchHelp.open ? filterOperators(query, ctx.lang()) : []);
  const examples = $derived(searchHelp.open ? filterExamples(query, ctx.lang()) : []);
  const rows = $derived([...ops.map((op) => operatorText(op, ctx.lang())), ...examples.map((ex) => exampleText(ex, ctx.lang()))]);

  $effect(() => {
    if (searchHelp.open) {
      query = "";
      queueMicrotask(() => input?.focus());
    }
  });

  /** Copies the row into the clipboard: the search box itself is core's and takes a paste. */
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // A webview without the clipboard API: the hidden field is the fallback, not a hidden failure.
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    ctx.toast(ctx.t(S.copied));
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      searchHelp.open = false;
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(rows.length - 1, active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(0, active - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const text = rows[active];
      if (text) void copy(text);
    }
  }
</script>

{#if searchHelp.open}
  <div class="backdrop" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && (searchHelp.open = false)}>
    <div class="panel" role="dialog" aria-modal="true" aria-label={ctx.t(S.title)}>
      <header>
        <h2>{ctx.t(S.title)}</h2>
        <p class="lead muted">{ctx.t(S.lead)}</p>
        <input class="q" bind:this={input} bind:value={query} onkeydown={onKey} placeholder={ctx.t(S.filter)} />
      </header>

      <div class="body">
        {#if ops.length}
          <div class="group muted">{ctx.t(S.operators)}</div>
          {#each ops as op, i (op.id)}
            <button class="row" class:active={i === active} onpointermove={() => (active = i)} onclick={() => copy(operatorText(op, ctx.lang()))}>
              <code>{operatorText(op, ctx.lang())}</code>
              <span class="about">{ctx.t(op.about)}</span>
            </button>
          {/each}
        {/if}

        {#if examples.length}
          <div class="group muted">{ctx.t(S.examples)}</div>
          {#each examples as ex, j (ex.id)}
            {@const i = ops.length + j}
            <button class="row" class:active={i === active} onpointermove={() => (active = i)} onclick={() => copy(exampleText(ex, ctx.lang()))}>
              <code>{exampleText(ex, ctx.lang())}</code>
              <span class="about"><b>{ctx.t(ex.title)}.</b> {ctx.t(ex.about)}</span>
            </button>
          {/each}
        {/if}

        {#if !ops.length && !examples.length}
          <div class="empty muted">{ctx.t(S.empty)}</div>
        {/if}

        <div class="group muted">{ctx.t(S.tips)}</div>
        {#each TIPS as tip (tip.ru)}
          <div class="tip">{ctx.t(tip)}</div>
        {/each}
      </div>

      <footer class="muted">{ctx.t(S.footer)}</footer>
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
    padding-top: 10vh;
  }

  .panel {
    width: min(760px, calc(100vw - 40px));
    max-height: 78vh;
    display: flex;
    flex-direction: column;
    background: var(--paper);
    border-radius: 10px;
    box-shadow: 0 20px 50px rgb(0 0 0 / 30%);
    overflow: hidden;
  }

  header {
    padding: 16px 18px 12px;
    border-bottom: 1px solid var(--line);
  }

  h2 {
    margin: 0 0 4px;
    font-size: 18px;
  }

  .lead {
    margin: 0 0 10px;
    font-size: 12.5px;
    line-height: 1.45;
  }

  .q {
    width: 100%;
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 8px 10px;
    font: inherit;
    font-size: 14px;
    background: var(--paper);
    color: var(--ink);
    outline: none;
  }

  .body {
    padding: 6px 8px 8px;
    overflow-y: auto;
  }

  .group {
    padding: 10px 10px 4px;
    font-size: 12px;
  }

  .row {
    display: grid;
    grid-template-columns: minmax(180px, 42%) 1fr;
    gap: 10px;
    align-items: baseline;
    width: 100%;
    border: none;
    background: none;
    color: var(--ink);
    text-align: left;
    padding: 6px 10px;
    border-radius: 5px;
    font: inherit;
  }

  .row.active,
  .row:hover {
    background: var(--selected);
  }

  code {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 12px;
    background: var(--paper-2);
    border-radius: 4px;
    padding: 1px 5px;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .about {
    font-size: 12.5px;
    color: var(--muted);
    line-height: 1.4;
  }

  .tip {
    padding: 3px 10px;
    font-size: 12.5px;
    color: var(--ink);
    line-height: 1.45;
  }

  .empty {
    padding: 14px 10px;
    font-size: 13px;
  }

  footer {
    border-top: 1px solid var(--line);
    padding: 8px 18px;
    font-size: 12px;
  }

  .muted {
    color: var(--muted);
  }

  @media (max-width: 520px) {
    .row {
      grid-template-columns: 1fr;
      gap: 2px;
    }
  }
</style>
