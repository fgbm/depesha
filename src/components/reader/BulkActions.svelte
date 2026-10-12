<script lang="ts">
  // The set for several chosen rows (0.8.3, #176, decision 1.4 Б): «Готово», the plugins' bulk
  // buttons, «Прочитано / Не прочитано / Флаг / Удалить / В папку» and «Выбрать все найденные».
  // It stands in the action panel above the list and the letter, and in the reader of a narrow
  // window — one copy for both. The row never wraps: on a narrower panel the labels go and the
  // icons stay (decision 1.9 В); every button keeps a name for that mode.
  import Archive from "@lucide/svelte/icons/archive";
  import Flag from "@lucide/svelte/icons/flag";
  import Trash from "@lucide/svelte/icons/trash-2";
  import Folder from "@lucide/svelte/icons/folder";
  import Mail from "@lucide/svelte/icons/mail";
  import MailOpen from "@lucide/svelte/icons/mail-open";
  import CheckCheck from "@lucide/svelte/icons/check-check";
  import Popover from "../Popover.svelte";
  import { app } from "../../lib/store.svelte";
  import { i18n, t, tn } from "../../lib/i18n.svelte";
  import { shortcuts } from "../../lib/shortcuts.svelte";
  import { labelFit } from "../../lib/labelFit.svelte";
  import { registry } from "../../plugin-host/registry.svelte";
  import type { Rendered } from "../../plugin-api";

  let moveOpen = $state(false);

  const plugins = $derived(registry.lists.bulkToolbar);
  const canSelectAll = $derived(app.list.view.kind === "search" && app.list.messages.length > app.selection.selected.size);
  const bulkAccount = $derived.by(() => {
    const ids = [...app.selection.selected];
    const accs = new Set(app.list.messages.filter((m) => ids.includes(m.id)).map((m) => m.account_id));
    return accs.size === 1 ? [...accs][0] : null;
  });
  const bulkFolders = $derived(bulkAccount ? app.mailboxes.folders.filter((f) => f.account_id === bulkAccount && f.selectable && !f.hidden) : []);
  const selectAllText = $derived(tn("bulk.selectAll", app.list.messages.length, { n: app.list.messages.length }));

  const fit = labelFit(() => [plugins.length, bulkFolders.length, canSelectAll, app.list.messages.length, i18n.lang]);
</script>

{#snippet pluginBtn(r: Rendered)}
  <r.component {...r.props ?? {}} />
{/snippet}

<div class="row" class:icons={fit.icons} bind:this={fit.el} data-tauri-drag-region>
  <span class="it" data-key="done"><button class="btn ghost" onclick={() => app.actions.archive()} title={shortcuts.titled(t("act.doneHint"), "core.archive")} aria-label={t("act.done")}><Archive size={15} /> <span class="lbl">{t("act.done")}</span></button></span>
  {#each plugins as b, i (b)}
    <span class="it" data-key={"plugin-" + i}>{@render pluginBtn(b.item)}</span>
  {/each}
  <span class="it" data-key="read"><button class="btn ghost" onclick={() => app.selection.flag("seen", true)} title={t("act.read")} aria-label={t("act.read")}><MailOpen size={15} /> <span class="lbl">{t("act.read")}</span></button></span>
  <span class="it" data-key="unread"><button class="btn ghost" onclick={() => app.selection.flag("seen", false)} title={t("act.unread")} aria-label={t("act.unread")}><Mail size={15} /> <span class="lbl">{t("act.unread")}</span></button></span>
  <span class="it" data-key="flag"><button class="btn ghost" onclick={() => app.selection.flag("flagged", true)} title={t("act.flag")} aria-label={t("act.flag")}><Flag size={15} /> <span class="lbl">{t("act.flag")}</span></button></span>
  <span class="it" data-key="delete"><button class="btn ghost" onclick={() => app.actions.remove()} title={t("act.delete")} aria-label={t("act.delete")}><Trash size={15} /> <span class="lbl">{t("act.delete")}</span></button></span>
  {#if bulkFolders.length}
    <span class="it" data-key="toFolder">
      <span class="anchor">
        <button class="btn ghost" onclick={() => (moveOpen = !moveOpen)} title={t("act.toFolder")} aria-label={t("act.toFolder")}><Folder size={15} /> <span class="lbl">{t("act.toFolder")}</span></button>
        <Popover bind:open={moveOpen} align="left">
          <div class="mt">{t("act.moveTitle")}</div>
          <div class="folder-list">
            {#each bulkFolders as f (f.name)}
              <button class="mi" onclick={() => { moveOpen = false; app.actions.moveTo(f.name); }}><Folder size={15} /> {f.display_name}</button>
            {/each}
          </div>
        </Popover>
      </span>
    </span>
  {/if}
  {#if canSelectAll}
    <span class="it" data-key="selectAll">
      <button class="btn ghost" onclick={() => app.selection.selectAll()} title={selectAllText} aria-label={selectAllText}>
        <CheckCheck size={15} /> <span class="lbl">{selectAllText}</span> {#if shortcuts.key("core.select-all")}<kbd>{shortcuts.hint("core.select-all")}</kbd>{/if}
      </button>
    </span>
  {/if}
  <span class="sp" data-tauri-drag-region></span>
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    flex: 1;
  }

  /* Decision 1.9 В: the labels go and the icons stay when the row has no room for them. They are
     taken out of the flow, not removed, so the row can measure what the labels would take. The
     key hint of «Выбрать все» goes with them: a hint without its words says nothing. */
  .row.icons :global(.lbl),
  .row.icons :global(.lbl2),
  .row.icons :global(kbd) {
    position: absolute;
    visibility: hidden;
  }

  .it {
    display: inline-flex;
    flex: none;
  }

  .anchor {
    position: relative;
    display: inline-flex;
  }

  .sp {
    flex: 1;
  }

  .folder-list {
    max-height: 320px;
    overflow-y: auto;
  }
</style>
