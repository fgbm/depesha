<script lang="ts">
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import { app } from "../lib/store.svelte";
  import { t } from "../lib/i18n.svelte";
  import { labelState, labelStorage, pickAccount } from "../lib/labels";
  import type { Label, MessageRow } from "../lib/types";
  import LabelMenu from "./LabelMenu.svelte";
  import LabelColors from "./LabelColors.svelte";
  import { labels } from "../lib/labels.svelte";

  /** Выбор меток (#42, кадр 10): галочки на метках ящика, пустое состояние и форма
   *  новой метки, внизу — где метки хранятся. Общий для меню строки, панели письма
   *  и команды «Метки…». На части писем метка даёт промежуточную галочку.
   *  «⋯» у метки — быстрые правки: переименовать, цвет, удалить (кадр 1В). */
  let { rows }: { rows: MessageRow[] } = $props();

  const account = $derived(pickAccount(rows));
  const known = $derived((account ? labels.of(account) : []).filter((l) => !l.stripping));
  const ids = $derived(rows.map((m) => m.id));
  const storage = $derived(labelStorage(rows.map((m) => labels.prop(m.account_id, m.folder))));

  let newLabel = $state("");
  let newColor = $state("#3f7fd0");
  let menu = $state<{ at: { x: number; y: number }; label: Label } | null>(null);
  let colors = $state<{ at: { x: number; y: number }; label: Label } | null>(null);
  let editing = $state<string | null>(null);
  let draft = $state("");

  async function toggle(keyword: string, on: boolean) {
    const l = known.find((x) => x.keyword === keyword);
    if (l) await labels.set(ids, l.name, on);
  }

  async function add() {
    const name = newLabel.trim();
    if (!account || !name) return;
    const label = await labels.save(account, name, newColor);
    newLabel = "";
    if (label) await labels.set(ids, label.name, true);
  }

  function startRename(l: Label) {
    editing = l.keyword;
    draft = l.name;
  }

  async function commit(l: Label) {
    const name = draft.trim();
    editing = null;
    if (!account || !name || name === l.name) return;
    await labels.rename(account, l.name, name);
  }

  function openMenu(e: MouseEvent, l: Label) {
    menu = { at: { x: e.clientX, y: e.clientY }, label: l };
  }

  function find(l: Label) {
    app.selection.setView({ kind: "search", text: `метка:${l.name}` });
  }

  async function remove(l: Label) {
    if (!account) return;
    const n = labels.count(account, l.keyword);
    const ok = await app.ui.confirm({
      title: t("label.deleteTitle", { name: l.name }),
      text: t("label.deleteText", { n }),
      okLabel: t("label.deleteOk"),
      danger: true,
    });
    if (!ok) return;
    await labels.strip(account, l.name);
    app.ui.toast(t("label.deleted"));
  }
</script>

<div class="mt">{t("label.pick")}</div>
<div class="folder-list">
  {#each known as l (l.keyword)}
    {@const state = labelState(rows, l.keyword)}
    {#if editing === l.keyword}
      <div class="row edit">
        <span class="lsw" style:--c={l.color}></span>
        <input
          class="input"
          bind:value={draft}
          aria-label={t("label.rename")}
          onkeydown={(e) => {
            if (e.key === "Enter") commit(l);
            else if (e.key === "Escape") editing = null;
          }}
          onblur={() => commit(l)}
        />
      </div>
    {:else}
      <div class="row">
        <button class="mi" onclick={() => toggle(l.keyword, state !== "all")}>
          <input type="checkbox" checked={state === "all"} indeterminate={state === "some"} tabindex="-1" />
          <span class="lsw" style:--c={l.color}></span>{l.name}
        </button>
        <button class="dots" aria-label={t("label.actions")} onclick={(e) => openMenu(e, l)}><Ellipsis size={15} /></button>
      </div>
    {/if}
  {:else}
    <div class="empty">{t("label.empty")}</div>
  {/each}
</div>
<hr />
<form class="new" onsubmit={(e) => { e.preventDefault(); add(); }}>
  <span class="lsw" style:--c={newColor}></span>
  <input class="input" bind:value={newLabel} placeholder={t("label.new")} aria-label={t("label.new")} />
  <input class="color" type="color" bind:value={newColor} aria-label={t("label.color")} />
  <button class="btn primary" type="submit" disabled={!newLabel.trim()}>{t("label.create")}</button>
</form>
<div class="stat">
  {#if storage === "unconfirmed"}{t("label.whereUnknown")}
  {:else if storage === "local"}{t("label.whereLocal")}
  {:else}{t("label.whereServer")}{/if}
</div>

{#if menu}
  {#key menu.label.keyword}
    <LabelMenu
      at={menu.at}
      label={menu.label}
      onclose={() => (menu = null)}
      onrename={(l) => startRename(l)}
      oncolor={(l) => (colors = { at: { x: window.innerWidth / 2 - 160, y: window.innerHeight / 2 - 120 }, label: l })}
      ondelete={(l) => void remove(l)}
      onfind={(l) => find(l)}
    />
  {/key}
{/if}
{#if colors && account}
  <LabelColors at={colors.at} account={account} label={colors.label} onclose={() => (colors = null)} />
{/if}

<style>
  .folder-list {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    max-height: 50vh;
  }

  .row {
    display: flex;
    align-items: center;
  }

  .row .mi {
    flex: 1;
    min-width: 0;
  }

  .row .dots {
    flex: none;
    display: inline-flex;
    align-items: center;
    border: none;
    background: none;
    color: var(--muted);
    padding: 4px 8px;
    cursor: pointer;
  }

  .row .dots:hover {
    color: var(--ink);
  }

  .row.edit {
    gap: 8px;
    padding: 4px 10px;
  }

  .row.edit .input {
    flex: 1;
    min-width: 0;
  }

  .mi input[type="checkbox"] {
    flex: none;
  }

  .empty {
    padding: 8px 10px;
    color: var(--muted);
    font-size: 13px;
  }

  .lsw {
    display: inline-block;
    width: 11px;
    height: 11px;
    border-radius: 3px;
    background: var(--c, var(--muted));
    flex: none;
  }

  .new {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px 6px;
  }

  .new .input {
    flex: 1;
    min-width: 0;
  }

  .new .color {
    flex: none;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: none;
  }

  .stat {
    display: flex;
    gap: 6px;
    padding: 6px 10px 8px;
    color: var(--muted);
    font-size: 11.5px;
    line-height: 1.4;
  }
</style>
