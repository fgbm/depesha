<script lang="ts">
  // The reader's states that are not the letter itself: a bulk of rows, a failure, the
  // letter still on its way, and the resting placeholder. The pane (Reader.svelte) keeps
  // one place for them; the letter, its title and its toolbar make the other component.
  import Archive from "@lucide/svelte/icons/archive";
  import Flag from "@lucide/svelte/icons/flag";
  import Trash from "@lucide/svelte/icons/trash-2";
  import Folder from "@lucide/svelte/icons/folder";
  import Popover from "../Popover.svelte";
  import { app } from "../../lib/store.svelte";
  import { addrName, longDate, size } from "../../lib/format";
  import { t, tn } from "../../lib/i18n.svelte";
  import { registry } from "../../plugin-host/registry.svelte";

  let {
    which,
    waited,
  }: {
    /** Which state is shown: none of them is the letter. */
    which: "bulk" | "error" | "opening" | "placeholder";
    /** How far the opening has gone: 0 at once, then a blink, then seconds. */
    waited: 0 | 1 | 2 | 3;
  } = $props();

  let bulkMoveOpen = $state(false);
  const selectedSize = $derived(app.selectedSize());
  const canSelectAll = $derived(app.view.kind === "search" && app.messages.length > app.selected.size);
  const bulkAccount = $derived.by(() => {
    const ids = [...app.selected];
    const accs = new Set(app.messages.filter((m) => ids.includes(m.id)).map((m) => m.account_id));
    return accs.size === 1 ? [...accs][0] : null;
  });
  const bulkFolders = $derived(bulkAccount ? app.folders.filter((f) => f.account_id === bulkAccount && f.selectable && !f.hidden) : []);
</script>

{#if which === "bulk"}
  <div class="center">
    <h3>{tn("bulk.selected", app.selected.size, { n: app.selected.size, size: size(selectedSize) })}</h3>
    <div class="actions">
      <button class="btn" onclick={() => app.archive()}><Archive size={15} /> {t("act.done")}</button>
      {#each registry.lists.bulkToolbar as b (b)}<b.item.component {...b.item.props ?? {}} />{/each}
      <button class="btn" onclick={() => app.flag("seen", true)}>{t("act.read")}</button>
      <button class="btn" onclick={() => app.flag("seen", false)}>{t("act.unread")}</button>
      <button class="btn" onclick={() => app.flag("flagged", true)}><Flag size={15} /> {t("act.flag")}</button>
      <button class="btn" onclick={() => app.remove()}><Trash size={15} /> {t("act.delete")}</button>
      {#if bulkFolders.length}
        <span class="anchor">
          <button class="btn" onclick={() => (bulkMoveOpen = !bulkMoveOpen)}><Folder size={15} /> {t("act.toFolder")}</button>
          <Popover bind:open={bulkMoveOpen} align="left">
            <div class="mt">{t("act.moveTitle")}</div>
            <div class="folder-list">
              {#each bulkFolders as f (f.name)}
                <button class="mi" onclick={() => { bulkMoveOpen = false; app.moveTo(f.name); }}><Folder size={15} /> {f.display_name}</button>
              {/each}
            </div>
          </Popover>
        </span>
      {/if}
    </div>
    {#if canSelectAll}
      <button class="btn ghost select-all" onclick={() => app.selectAll()}>
        {tn("bulk.selectAll", app.messages.length, { n: app.messages.length })} <kbd>Ctrl+A</kbd>
      </button>
    {/if}
  </div>
{:else if which === "error"}
  <div class="center">
    <p class="danger-text">{app.openError?.message}</p>
    {#if app.opened === null && app.selected.size === 1}
      <button class="btn" onclick={() => app.open([...app.selected][0])}>{t("retry")}</button>
    {/if}
  </div>
{:else if which === "opening"}
  {@const r = app.openingRow}
  <div class="opening" aria-busy="true" aria-live="polite">
    <div class="progress" role="progressbar" aria-label={t("reader.loading")}><span></span></div>
    {#if r}
      <div class="head">
        <p class="title">{r.subject || t("noSubject")}</p>
        <div class="muted">{addrName(r.from) || t("list.noSender")} · {longDate(r.date)}</div>
      </div>
    {/if}
    <div class="skeleton" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    {#if waited >= 2}
      <div class="slow muted">
        {waited === 3 ? t("reader.stuck") : t("reader.downloading")}
        {#if waited === 3 && r}<button class="btn" onclick={() => app.open(r.id)}>{t("retry")}</button>{/if}
      </div>
    {/if}
  </div>
{:else}
  <!-- One way in instead of a wall of keys: the palette lists every command with its key. -->
  <div class="center muted">
    <div class="hint">
      <p>{t("reader.choose")}</p>
      <p class="small"><kbd>Ctrl</kbd>+<kbd>K</kbd> — {t("keys.all")}</p>
    </div>
  </div>
{/if}
