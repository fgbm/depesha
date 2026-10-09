<script lang="ts">
  import { Keys, type Command, type PluginContext } from "@depesha/plugin-api";
  import Pencil from "@lucide/svelte/icons/pencil";
  import { palette } from "./state.svelte";
  import { editTarget } from "./keys";
  import { rank, recency } from "./rank";

  let { ctx }: { ctx: PluginContext } = $props();

  const S = {
    title: { en: "Commands", ru: "Команды" },
    placeholder: { en: "What to do? E.g. “sno tom” or “mov arch”", ru: "Что сделать? Например: «отл завт» или «пер архив»" },
    none: { en: "No such command", ru: "Нет такой команды" },
    edit: { en: "Alt+Enter — edit the key", ru: "Alt+Enter — изменить клавишу" },
    people: { en: "People", ru: "Люди" },
    personTip: { en: "Enter — the card, Ctrl+Enter — all mail", ru: "Enter — карточка, Ctrl+Enter — все письма" },
  };

  /** Opens Settings → «Keys», at this command when there is one (Alt+Enter, #46). */
  function configure(c?: Command) {
    palette.open = false;
    ctx.editKeys(c?.id ?? "", c?.title() ?? "");
  }

  let query = $state("");
  let active = $state(0);
  let input = $state<HTMLInputElement | null>(null);

  /** The best matches, the ones used last first among equals: what was run before is near. */
  const shown = $derived(palette.open ? rank(ctx.commands(), query, recency).slice(0, 12) : []);
  /** People by name or address (#104, 1.2 Б): after the commands, found by what is typed. */
  const people = $derived(palette.open && query.trim().length >= 2 ? ctx.people.find(query).slice(0, 5) : []);
  const count = $derived(shown.length + people.length);

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

  /** Enter opens the card of the person, Ctrl+Enter their letters. */
  function person(i: number, mail: boolean) {
    const p = people[i - shown.length];
    if (!p) return;
    palette.open = false;
    if (mail) ctx.people.allMail(p.email);
    else ctx.people.open(p.email);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(count - 1, active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(0, active - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Alt+Enter edits the highlighted command's key instead of running it (#46).
      const edit = editTarget(e, shown, active);
      if (active >= shown.length) person(active, e.ctrlKey || e.metaKey);
      else if (edit) configure(edit);
      else run(shown[active]);
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
            {#if ctx.keyOf(c.id)}<span class="hint"><Keys of={c.id} /></span>{:else if c.hint}<span class="hint">{c.hint()}</span>{/if}
            {#if i === active}<span class="pedit" class:solo={!ctx.keyOf(c.id) && !c.hint} title={ctx.t(S.edit)}><Pencil size={12} /> Alt+Enter</span>{/if}
          </button>
        {:else}
          {#if !people.length}<div class="none muted">{ctx.t(S.none)}</div>{/if}
        {/each}
        {#if people.length}
          <div class="group muted">{ctx.t(S.people)}</div>
          {#each people as p, j (p.email)}
            {@const i = shown.length + j}
            <button class="item" class:active={i === active} role="option" aria-selected={i === active} title={ctx.t(S.personTip)} onpointermove={() => (active = i)} onclick={(e) => person(i, e.ctrlKey || e.metaKey)}>
              <span>{p.name}</span>
              <span class="hint">{p.email}{p.emails.length > 1 ? ` +${p.emails.length - 1}` : ""}</span>

            </button>
          {/each}
        {/if}
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

  /* The active row: a quiet chip saying Alt+Enter edits this command's key (#46). */
  .pedit {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 8px;
    padding: 1px 6px;
    border: 1px solid var(--line);
    border-radius: 5px;
    background: var(--paper);
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }

  /* A row with neither a key nor a hint: the chip still sits at the right edge. */
  .pedit.solo {
    margin-left: auto;
  }

  .none {
    padding: 14px;
  }

  .group {
    padding: 8px 12px 2px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
</style>
