<script lang="ts">
  // The search box above the list with its suggestions. Focused and empty: ready queries
  // (large mail by the threshold from the settings), recent searches and the operators.
  // While typing: completion of the operator being typed and of its value. A suggestion
  // only puts text into the box: what is searched stays visible and editable.
  import { untrack } from "svelte";
  import HardDrive from "@lucide/svelte/icons/hard-drive";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import History from "@lucide/svelte/icons/rotate-ccw-clock";
  import Calendar from "@lucide/svelte/icons/calendar";
  import Folder from "@lucide/svelte/icons/folder";
  import Settings2 from "@lucide/svelte/icons/settings-2";
  import { app } from "../lib/store.svelte";
  import { size } from "../lib/format";
  import { i18n, t } from "../lib/i18n.svelte";
  import { readyQueries, threshold } from "../lib/largeMail";
  import { recentSearches } from "../lib/recentSearches.svelte";
  import { NEW_OPERATORS, OPERATORS, applyCompletion, completions, type Completion } from "../lib/searchSuggest";

  let { input = $bindable() }: { input: HTMLInputElement | null } = $props();
  /** The box's own ids: the input names its listbox and the highlighted option by them. */
  const uid = $props.id();
  const optionId = (i: number) => `${uid}-option-${i}`;

  let text = $state("");
  let open = $state(false);
  /** The highlighted suggestion; -1 for none: Enter searches the text as it is. */
  // Other text starts with no row highlighted; a list that loads more at the same text keeps it.
  let active = $derived.by(() => {
    void text;
    return -1;
  });
  let timer: ReturnType<typeof setTimeout> | null = null;

  type Item = { kind: "query"; title: string; text: string; icon: "large" | "files" | "recent" } | { kind: "completion"; c: Completion };

  const mb = $derived(threshold(app.settingsCtl.settings.large_mb));
  const ready = $derived(readyQueries(mb).map((q) => ({ kind: "query" as const, title: q.title, text: q.text, icon: q.id === "files" ? ("files" as const) : ("large" as const) })));
  const recent = $derived(recentSearches.list.map((s) => ({ kind: "query" as const, title: s, text: s, icon: "recent" as const })));
  const typed = $derived<Item[]>(
    text.trim()
      ? completions(text, {
          lang: i18n.lang,
          now: new Date(),
          folders: app.mailboxes.folders,
          accounts: app.mailboxes.accounts,
          labels: [...new Set(app.mailboxes.accounts.flatMap((a) => app.labels.of(a.id).map((l) => l.name)))],
        }).map((c) => ({ kind: "completion" as const, c }))
      : [],
  );
  const empty = $derived(!text.trim());
  const items = $derived<Item[]>(empty ? [...ready, ...recent] : typed);
  const shown = $derived(open && (empty || typed.length > 0));

  // The box shows the search the list shows, however it was started ("Mail from", Ctrl+K).
  $effect(() => {
    const v = app.list.view;
    if (v.kind !== "search") text = "";
    else if (untrack(() => text.trim()) !== v.text.trim()) text = v.text;
  });

  function onInput() {
    open = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const q = text.trim();
      if (q) app.selection.setView({ kind: "search", text: q });
      else if (app.list.view.kind === "search") app.selection.setView(app.mailboxes.home());
    }, 250);
  }

  /** Searches at once and remembers the search among the recent ones. */
  function run(q: string) {
    if (timer) clearTimeout(timer);
    text = q;
    open = false;
    if (!q.trim()) return;
    recentSearches.remember(q);
    app.selection.setView({ kind: "search", text: q.trim() });
  }

  function complete(c: Completion) {
    text = applyCompletion(text, c);
    open = true;
    onInput();
    input?.focus();
  }

  function pick(item: Item, search: boolean) {
    if (item.kind === "query") return run(item.text);
    if (search) {
      run(applyCompletion(text, item.c));
      return;
    }
    complete(item.c);
  }

  function clear() {
    if (timer) clearTimeout(timer);
    text = "";
    if (app.list.view.kind === "search") app.selection.setView(app.mailboxes.home());
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" && shown && items.length) {
      e.preventDefault();
      active = (active + 1) % items.length;
    } else if (e.key === "ArrowUp" && shown && items.length) {
      e.preventDefault();
      active = active <= 0 ? items.length - 1 : active - 1;
    } else if (e.key === "Tab" && shown && !empty && items.length) {
      e.preventDefault();
      pick(items[Math.max(active, 0)], false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown && active >= 0) pick(items[active], true);
      else run(text);
    } else if (e.key === "Escape") {
      if (shown) {
        e.stopPropagation();
        open = false;
      } else clear();
    }
  }

  /** An operator from the cheat sheet goes after the text typed so far. */
  function addOperator(op: string) {
    const base = text.trimEnd();
    text = `${base ? `${base} ` : ""}${op.replace("Folder/*", "").replace("Папка/*", "")}`;
    onInput();
    input?.focus();
  }
</script>

{#snippet query(item: Item & { kind: "query" }, i: number)}
  <button class="sg" class:active={i === active} id={optionId(i)} role="option" aria-selected={i === active} tabindex="-1" onpointermove={() => (active = i)} onclick={() => pick(item, true)}>
    {#if item.icon === "large"}<HardDrive size={14} />{:else if item.icon === "files"}<Paperclip size={14} />{:else}<History size={14} />{/if}
    <span class="title">{item.title}</span>
    {#if item.icon !== "recent"}<code>{item.text}</code>{/if}
  </button>
{/snippet}

<div class="search">
  <input
    class="input"
    class:query={!!text}
    placeholder={t("search.placeholder")}
    bind:this={input}
    bind:value={text}
    oninput={onInput}
    onfocus={() => (open = true)}
    onblur={() => (open = false)}
    onkeydown={onKey}
    role="combobox"
    aria-expanded={shown}
    aria-controls="{uid}-suggestions"
    aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined}
    aria-autocomplete="list"
  />
  {#if text}<button class="btn ghost clear" onclick={clear} aria-label={t("clear")}>×</button>{/if}
  {#if shown}
    <!-- Clicks inside keep the focus in the box: the list stays open until a choice. -->
    <div class="suggest" id="{uid}-suggestions" role="listbox" tabindex="-1" onpointerdown={(e) => e.preventDefault()}>
      {#if empty}
        <div class="head">{t("suggest.ready")}</div>
        {#each ready as item, i (item.text)}{@render query(item, i)}{/each}
        {#if recent.length}
          <hr />
          <div class="head">{t("suggest.recent")}</div>
          {#each recent as item, i (item.text)}{@render query(item, ready.length + i)}{/each}
        {/if}
        <hr />
        <div class="ops">
          <span class="muted">{t("suggest.operators")}</span>
          {#each OPERATORS[i18n.lang].filter((op) => !NEW_OPERATORS[i18n.lang].includes(op)) as op (op)}<button class="op" tabindex="-1" onclick={() => addOperator(op)}>{op}</button>{/each}
          {#each NEW_OPERATORS[i18n.lang] as op (op)}<button class="op" tabindex="-1" onclick={() => addOperator(op)}>{op}</button>{/each}
        </div>
        <hr />
        <button class="sg foot" tabindex="-1" onclick={() => { open = false; app.ui.openSettings("storage"); }}>
          <Settings2 size={13} />
          <span>{t("suggest.threshold", { size: size(mb * 1024 * 1024, 0) })}</span>
        </button>
      {:else}
        {#each typed as item, i (i)}
          {#if item.kind === "completion"}
            <button class="sg" class:active={i === active} id={optionId(i)} role="option" aria-selected={i === active} tabindex="-1" onpointermove={() => (active = i)} onclick={() => pick(item, false)}>
              {#if item.c.kind === "year"}<Calendar size={14} />{:else if item.c.kind === "folder"}<Folder size={14} />{:else if item.c.kind === "size"}<HardDrive size={14} />{/if}
              <code>{item.c.token}</code>
              <span class="detail">{item.c.detail}</span>
            </button>
          {/if}
        {/each}
        <hr />
        <div class="keys muted">{t("suggest.keys")}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .search {
    position: relative;
  }

  .search .input {
    width: 100%;
    padding-right: 30px;
  }

  /* A query with operators reads as one: the same face the suggestions show it in. */
  .search .input.query {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 13px;
  }

  .clear {
    position: absolute;
    right: 2px;
    top: 2px;
    padding: 3px 8px;
  }

  .suggest {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    min-width: min(420px, calc(100vw - 16px));
    z-index: 30;
    max-height: 70vh;
    overflow-y: auto;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: 0 10px 28px rgb(0 0 0 / 18%);
    padding: 4px;
    display: flex;
    flex-direction: column;
  }

  .head {
    padding: 6px 10px 2px;
    font-size: 12px;
    color: var(--muted);
  }

  .sg {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    border: none;
    background: none;
    color: var(--ink);
    text-align: left;
    padding: 6px 10px;
    border-radius: 5px;
    min-width: 0;
  }

  .sg :global(svg) {
    flex: none;
    color: var(--muted);
  }

  .sg.active,
  .sg:hover {
    background: var(--selected);
  }

  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  code {
    font-size: 12px;
    background: var(--paper-2);
    border-radius: 4px;
    padding: 1px 5px;
    white-space: nowrap;
    color: var(--muted);
  }

  .sg code:first-of-type:not(:last-child) {
    color: var(--ink);
  }

  .detail {
    margin-left: auto;
    padding-left: 12px;
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ops {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 4px 10px 6px;
    font-size: 12px;
  }

  .op {
    border: none;
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 12px;
    background: var(--paper-2);
    color: var(--ink);
    border-radius: 4px;
    padding: 1px 5px;
  }

  .op:hover {
    background: var(--hover);
  }

  .foot {
    font-size: 12px;
    color: var(--muted);
  }

  .keys {
    padding: 4px 10px 6px;
    font-size: 12px;
  }

  hr {
    flex: none;
    width: auto;
    border: none;
    border-top: 1px solid var(--line);
    margin: 4px 2px;
  }
</style>
