<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { t } from "../lib/i18n.svelte";
  import { labelState, labelStorage, pickAccount } from "../lib/labels";
  import type { MessageRow } from "../lib/types";

  /** Выбор меток (#42, кадр 10): галочки на метках ящика, пустое состояние и форма
   *  новой метки, внизу — где метки хранятся. Общий для меню строки, панели письма
   *  и команды «Метки…». На части писем метка даёт промежуточную галочку. */
  let { rows }: { rows: MessageRow[] } = $props();

  const account = $derived(pickAccount(rows));
  const known = $derived(account ? app.labels.of(account) : []);
  const ids = $derived(rows.map((m) => m.id));
  const storage = $derived(labelStorage(rows.map((m) => app.labels.prop(m.account_id, m.folder))));

  let newLabel = $state("");
  let newColor = $state("#3f7fd0");

  async function toggle(keyword: string, on: boolean) {
    const l = known.find((x) => x.keyword === keyword);
    if (l) await app.setLabel(ids, l.name, on);
  }

  async function add() {
    const name = newLabel.trim();
    if (!account || !name) return;
    const label = await app.labels.save(account, name, newColor);
    newLabel = "";
    if (label) await app.setLabel(ids, label.name, true);
  }
</script>

<div class="mt">{t("label.pick")}</div>
<div class="folder-list">
  {#each known as l (l.keyword)}
    {@const state = labelState(rows, l.keyword)}
    <button class="mi" onclick={() => toggle(l.keyword, state !== "all")}>
      <input type="checkbox" checked={state === "all"} indeterminate={state === "some"} tabindex="-1" />
      <span class="lsw" style:--c={l.color}></span>{l.name}
    </button>
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

<style>
  .folder-list {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    max-height: 50vh;
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
