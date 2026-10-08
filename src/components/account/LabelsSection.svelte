<script lang="ts">
  // Раздел «Метки» на странице ящика (#42, кадр 1А, 2): имя и цвет, где хранится, число
  // писем со знаком «≈» и действия. Имя правится прямо в строке (кадр 3А) — ключ на
  // сервере не меняется. Удаление снимает метку со всех писем фоном (кадр 4Б).
  import { onMount } from "svelte";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import { app } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";
  import { readOnly } from "../../lib/labels";
  import type { Label } from "../../lib/types";
  import type { SectionProps } from "./sections";
  import LabelMenu from "../LabelMenu.svelte";
  import LabelColors from "../LabelColors.svelte";

  let { account }: SectionProps = $props();

  onMount(() => void app.labels.refresh(account.id));

  const all = $derived(app.labels.of(account.id));
  let query = $state("");
  const list = $derived(
    all.filter((l) => !query.trim() || l.name.toLowerCase().includes(query.trim().toLowerCase())),
  );

  // «Где хранится» — по свойствам папок (04, кадр 2); у Exchange колонки нет.
  const storage = $derived.by(() => {
    const props = app.folders
      .filter((f) => f.account_id === account.id)
      .map((f) => app.labels.prop(account.id, f.name))
      .filter((p) => !!p);
    const checked = props.filter((p) => (p?.checked ?? 0) > 0 || !!p?.label_check);
    if (!checked.length) return "unknown";
    const local = checked.some(
      (p) =>
        p?.label_check === "not-saves" ||
        p?.label_check === "claimed-but-lost" ||
        p?.labels_on_server === false,
    );
    return local ? "local" : "server";
  });

  // Правка имени в строке (#42, кадр 3А).
  let editing = $state<string | null>(null);
  let draft = $state("");

  function startRename(l: Label) {
    if (l.stripping) return;
    editing = l.name;
    draft = l.name;
  }

  async function commit(l: Label) {
    const name = draft.trim();
    editing = null;
    if (!name || name === l.name) return;
    await app.labels.rename(account.id, l.name, name);
  }

  // Меню действий и палитра, открытые по точке.
  let menu = $state<{ at: { x: number; y: number }; label: Label } | null>(null);
  let colors = $state<{ at: { x: number; y: number }; label: Label } | null>(null);

  function openMenu(e: MouseEvent, label: Label) {
    menu = { at: { x: e.clientX, y: e.clientY }, label };
  }

  function openColors(label: Label) {
    colors = { at: { x: window.innerWidth / 2 - 160, y: window.innerHeight / 2 - 120 }, label };
  }

  /** Письма с меткой — сохранённый поиск `метка:Имя` (#42, кадр 6А). */
  function find(label: Label) {
    app.settingsOpen = false;
    app.setView({ kind: "search", text: `метка:${label.name}` });
  }

  /** Удаление: ключ снимается со всех писем на сервере, фоном (#42, кадр 4Б). */
  async function remove(label: Label) {
    const n = app.labels.count(account.id, label.keyword);
    const ok = await app.confirm({
      title: t("label.deleteTitle", { name: label.name }),
      text: t("label.deleteText", { n }),
      okLabel: t("label.deleteOk"),
      danger: true,
    });
    if (!ok) return;
    await app.labels.strip(account.id, label.name);
    app.toast(t("label.deleted"));
  }

  /** Нет прав в папке (#42, кадр 7): метку здесь не поставить. */
  const readOnlyFolder = $derived(
    app.folders.some((f) => {
      if (f.account_id !== account.id) return false;
      const rights = app.labels.prop(account.id, f.name)?.rights;
      return !!rights && readOnly(rights);
    }),
  );
</script>

<section class="labels" data-section-labels>
  <h4>
    {t("label.pick")} · {all.length}
    {#if readOnlyFolder}<span class="r small muted">{t("label.noRightHint")}</span>{/if}
  </h4>

  {#if all.length}
    <div class="filter field"><input bind:value={query} placeholder={t("label.findPlaceholder")} aria-label={t("label.findPlaceholder")} /></div>
  {/if}

  {#if !all.length}
    <p class="muted small">{t("label.empty")}</p>
  {:else}
    <table class="tbl">
      <thead>
        <tr>
          <th>{t("label.pick")}</th>
          {#if !account.ews}<th>{t("label.storage")}</th>{/if}
          <th class="num">{t("label.count")}</th>
          <th>{t("label.actions")}</th>
        </tr>
      </thead>
      <tbody>
        {#each list as l (l.keyword)}
          <tr class:editing={editing === l.name}>
            <td>
              <span class="lname">
                <span class="chip" class:local={storage === "local"} style:--c={l.color || "#6b7480"}></span>
                {#if editing === l.name}
                  <input
                    class="field rename"
                    bind:value={draft}
                    aria-label={t("label.rename")}
                    onkeydown={(e) => {
                      if (e.key === "Enter") commit(l);
                      else if (e.key === "Escape") editing = null;
                    }}
                    onblur={() => commit(l)}
                  />
                {:else}
                  <button class="link" onclick={() => startRename(l)} title={t("label.renameHint")}>{l.name}</button>
                  {#if l.stripping}
                    <span class="strip small muted">{t("label.stripping")}</span>
                  {:else}
                    <Pencil size={12} color="var(--muted)" />
                  {/if}
                {/if}
              </span>
            </td>
            {#if !account.ews}
              <td>
                <span class="keep {storage === 'server' ? 'srv' : storage === 'local' ? 'loc' : 'unk'}">
                  {#if storage === "server"}{t("label.storage.server")}{:else if storage === "local"}{t("label.storage.local")}{:else}{t("label.storage.unknown")}{/if}
                </span>
              </td>
            {/if}
            <td class="num" title={t("label.countHint")}>≈{app.labels.count(account.id, l.keyword)}</td>
            <td>
              <button
                class="btn icon sm"
                aria-label={t("label.actions")}
                disabled={l.stripping}
                onclick={(e) => openMenu(e, l)}
              ><Ellipsis size={15} /></button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <p class="small muted">{t("label.listHint")}</p>
</section>

{#if menu}
  {#key menu.label.keyword}
    <LabelMenu
      at={menu.at}
      label={menu.label}
      onclose={() => (menu = null)}
      onrename={(l) => startRename(l)}
      oncolor={(l) => openColors(l)}
      ondelete={(l) => void remove(l)}
      onfind={(l) => find(l)}
    />
  {/key}
{/if}
{#if colors}
  <LabelColors at={colors.at} account={account.id} label={colors.label} onclose={() => (colors = null)} />
{/if}

<style>
  h4 {
    margin: 0 0 10px;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .r {
    font-weight: 400;
  }

  .small {
    font-size: 11.5px;
  }

  .field {
    max-width: 280px;
    margin: 0 0 10px;
  }

  .field input {
    flex: 1;
    min-width: 0;
    border: none;
    background: none;
    padding: 0;
  }

  .tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
    line-height: 1.4;
  }

  th {
    padding: 6px 8px 6px 0;
    border-bottom: 1px solid var(--line);
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    text-align: left;
  }

  td {
    padding: 6px 8px 6px 0;
    border-bottom: 1px solid var(--line);
    vertical-align: middle;
  }

  tbody tr:last-child td {
    border-bottom: none;
  }

  tr.editing td {
    background: var(--selected);
  }

  .lname {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .chip {
    width: 14px;
    height: 14px;
    border-radius: 4px;
    background: var(--c);
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 12%);
    flex: none;
  }

  .chip.local {
    border-radius: 50%;
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--c);
  }

  .link {
    border: none;
    background: none;
    color: var(--ink);
    font: inherit;
    padding: 0;
    cursor: pointer;
  }

  .link:hover {
    text-decoration: underline;
  }

  .rename {
    padding: 3px 7px;
  }

  .num {
    font-variant-numeric: tabular-nums;
    width: 80px;
  }

  .keep.srv {
    color: var(--ok);
  }

  .keep.loc {
    color: var(--warn);
  }

  .keep.unk {
    color: var(--muted);
  }
</style>
