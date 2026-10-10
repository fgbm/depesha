<script lang="ts">
  // The "View" button above the list: which messages it shows (a plugin's filter, e.g.
  // People / Newsletters) and in what order: a ready-made set or keys of one's own.
  import ArrowDownUp from "@lucide/svelte/icons/arrow-down-up";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import Check from "@lucide/svelte/icons/check";
  import X from "@lucide/svelte/icons/x";
  import Popover from "./Popover.svelte";
  import { app } from "../lib/store.svelte";
  import { t } from "../lib/i18n.svelte";
  import { PRESETS, RELEVANCE, SORT_FIELDS, naturalDesc, presetOf } from "../lib/sort";
  import type { SortField, SortKey } from "../lib/types";

  let open = $state(false);

  const search = $derived(app.list.view.kind === "search");
  const sort = $derived(app.selection.sort());
  const preset = $derived(presetOf(sort));
  const presets = $derived(search ? [RELEVANCE, ...PRESETS] : PRESETS);
  const fields = $derived<SortField[]>(search ? ["relevance", ...SORT_FIELDS] : SORT_FIELDS);
  /** The keys as edited: an empty order is newest first. */
  const keys = $derived<SortKey[]>(sort.length ? sort : [{ by: "date", desc: true }]);
  const unused = $derived(fields.filter((f) => !keys.some((k) => k.by === f)));

  const lf = $derived(app.selection.listFilter());
  const options = $derived(lf ? lf.filter.options() : []);
  const shown = $derived(lf ? lf.filter.current(lf.list) : "");
  /** A filter is on: the button names it, so hidden mail is not forgotten. */
  const filtered = $derived(!!lf && options.length > 0 && shown !== options[0].id);
  const shownTitle = $derived(options.find((o) => o.id === shown)?.title ?? "");
  const sortTitle = $derived(preset ? t(`sort.preset.${preset.id}`) : t("sort.custom"));

  // Search results keep their order apart: the rank means nothing in other lists.
  const own = $derived(search || app.selection.ownSort());

  function apply(next: SortKey[], ownList = own) {
    app.selection.setSort(next, search || ownList);
  }

  function setDirection(i: number) {
    apply(keys.map((k, j) => (j === i ? { ...k, desc: !k.desc } : k)));
  }

  function raise(i: number) {
    const next = [...keys];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    apply(next);
  }

  function remove(i: number) {
    apply(keys.filter((_, j) => j !== i));
  }

  function add(by: SortField) {
    apply([...keys, { by, desc: by === "relevance" ? false : naturalDesc(by) }]);
  }
</script>

<div class="view">
  <button
    class="trigger"
    class:filtered
    title={t("sort.view")}
    aria-label={t("sort.view")}
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <ArrowDownUp size={13} />
    <span>{filtered ? `${shownTitle} · ${sortTitle}` : sortTitle}</span>
  </button>
  <Popover bind:open>
    {#if lf && options.length}
      <div class="mt">{lf.filter.title()}</div>
      {#each options as o (o.id)}
        <button class="mi" role="menuitemradio" aria-checked={shown === o.id} onclick={() => lf.filter.select(lf.list, o.id)}>
          <span class="tick">{#if shown === o.id}<Check size={14} />{/if}</span>{o.title}
        </button>
      {/each}
      <hr />
    {/if}
    <div class="mt">{t("sort.title")}</div>
    {#each presets as p (p.id)}
      <button class="mi" role="menuitemradio" aria-checked={preset?.id === p.id} onclick={() => apply(p.sort)}>
        <span class="tick">{#if preset?.id === p.id}<Check size={14} />{/if}</span>{t(`sort.preset.${p.id}`)}
      </button>
    {/each}
    <hr />
    <div class="mt">{t("sort.custom")}</div>
    <ol class="keys">
      {#each keys as k, i (k.by)}
        <li>
          <span class="name">{t(`sort.field.${k.by}`)}</span>
          {#if k.by === "relevance"}
            <span class="dir static">{t("sort.dir.relevance.desc")}</span>
          {:else}
            <button class="dir" onclick={() => setDirection(i)}>{t(`sort.dir.${k.by}.${k.desc ? "desc" : "asc"}`)}</button>
          {/if}
          <button class="icon" disabled={i === 0} title={t("sort.up")} aria-label={t("sort.up")} onclick={() => raise(i)}><ArrowUp size={13} /></button>
          <button class="icon" disabled={keys.length === 1} title={t("sort.remove")} aria-label={t("sort.remove")} onclick={() => remove(i)}><X size={13} /></button>
        </li>
      {/each}
    </ol>
    {#if unused.length}
      <div class="add">
        <span class="muted">{t("sort.add")}</span>
        {#each unused as f (f)}<button class="chip" onclick={() => add(f)}>{t(`sort.field.${f}`)}</button>{/each}
      </div>
    {/if}
    {#if !search && app.selection.listKey()}
      <hr />
      <label class="scope"><input type="checkbox" checked={own} onchange={(e) => apply(sort, e.currentTarget.checked)} /> {t("sort.ownList")}</label>
    {/if}
  </Popover>
</div>

<style>
  .view {
    position: relative;
    flex: none;
  }

  /* Quiet like the rest of the title row; a filter that hides mail is not quiet. */
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: none;
    background: none;
    border-radius: 5px;
    padding: 3px 7px;
    font-size: 12px;
    color: var(--muted);
    max-width: 220px;
  }

  .trigger span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trigger:hover,
  .trigger[aria-expanded="true"] {
    color: var(--ink);
    background: var(--hover);
  }

  .trigger.filtered {
    color: var(--accent);
    font-weight: 600;
  }

  .tick {
    display: inline-flex;
    width: 14px;
  }

  .keys {
    list-style: none;
    margin: 0;
    padding: 2px 4px 4px 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    counter-reset: key;
  }

  .keys li {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
    counter-increment: key;
  }

  .keys li::before {
    content: counter(key) ".";
    color: var(--muted);
    width: 16px;
    font-size: 12px;
  }

  .name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
  }

  .dir {
    border: 1px solid var(--line);
    background: none;
    color: var(--ink);
    border-radius: 5px;
    padding: 1px 7px;
    font-size: 12px;
    white-space: nowrap;
  }

  .dir:hover {
    background: var(--hover);
  }

  .dir.static {
    border-color: transparent;
    color: var(--muted);
  }

  .icon {
    display: inline-flex;
    border: none;
    background: none;
    color: var(--muted);
    border-radius: 4px;
    padding: 3px;
  }

  .icon:hover:not(:disabled) {
    color: var(--ink);
    background: var(--hover);
  }

  .icon:disabled {
    opacity: 0.3;
  }

  .add {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 4px 10px 6px;
    font-size: 12px;
    max-width: 300px;
  }

  .chip {
    border: 1px dashed var(--line);
    background: none;
    color: var(--ink);
    border-radius: 10px;
    padding: 1px 8px;
    font-size: 12px;
  }

  .chip:hover {
    background: var(--hover);
  }

  .scope {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px 6px;
    font-size: 13px;
  }
</style>
