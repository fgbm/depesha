<script lang="ts">
  // The one action panel over the list and the letter (0.8.3, decision 1.1 В, settled by the
  // operator in step 2): a single row above both columns, as in Yandex Mail, instead of the
  // reader's own toolbar. It carries the search too — question 1.2 «Б»: the search over the
  // list column, the actions to its right, one row.
  //
  // The settled answers are plain code here: an empty strip when no letter is open (1.3 Б),
  // the set for several chosen rows with a bare «Выбрано N» in the reader (1.4 Б), every
  // button with its label (1.6 Б), the panel on the reader's ground with a line under it
  // (1.7 В), «Ещё» at the right edge (1.8 Б). A narrow window has no panel at all — its
  // compact toolbar stays as it was (1.5 А) — so the panel is mounted for the wide and
  // medium window only.
  //
  // Question 1.9 (how the panel behaves at a medium width, where the labels do not fit one
  // row) is not decided: the actions simply wrap, as the reader's toolbar does today.
  import Archive from "@lucide/svelte/icons/archive";
  import Trash from "@lucide/svelte/icons/trash-2";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import Flag from "@lucide/svelte/icons/flag";
  import Mail from "@lucide/svelte/icons/mail";
  import MailOpen from "@lucide/svelte/icons/mail-open";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import Folder from "@lucide/svelte/icons/folder";
  import Tag from "@lucide/svelte/icons/tag";
  import AppWindow from "@lucide/svelte/icons/app-window";
  import Printer from "@lucide/svelte/icons/printer";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Puzzle from "@lucide/svelte/icons/puzzle";
  import Popover from "./Popover.svelte";
  import Keys from "./Keys.svelte";
  import { app } from "../lib/store.svelte";
  import { fromDraft } from "../lib/compose";
  import { printOpened } from "../lib/print";
  import { t } from "../lib/i18n.svelte";
  import { shortcuts } from "../lib/shortcuts.svelte";
  import { extensions, fromRow } from "../lib/extensions.svelte";
  import type { ExtMessage } from "../lib/extensions.svelte";
  import { registry } from "../plugin-host/registry.svelte";
  import { labels } from "../lib/labels.svelte";
  import { layout } from "../lib/layout.svelte";
  import type { Snippet } from "svelte";
  import type { AccountView } from "../lib/types";

  let { search }: { search: Snippet } = $props();

  const msg = $derived(app.reader.opened);
  const account = $derived<AccountView | undefined>(msg ? app.mailboxes.account(msg.row.account_id) : undefined);
  const isDraft = $derived(msg ? app.mailboxes.folder(msg.row.account_id, msg.row.folder)?.role === "drafts" : false);
  const message = $derived<ExtMessage | null>(msg ? fromRow(msg.row, account?.email ?? "", msg.view.text) : null);

  /** One open letter and no explicit choice of several: the panel shows its actions. */
  const single = $derived(app.selection.selected.size <= 1 && !!msg);
  /** Several chosen rows: the panel switches to the set for many (1.4 Б). */
  const multi = $derived(app.selection.selected.size > 1);

  // The search box stands inside the list column with the same 12 px on each side as the
  // list's own header (the title on the left, «По дате» on the right), so it follows the
  // column separator. The panel begins one hairline (the column's separator) left of the
  // list, so the slot is nudged by that hairline.
  const slotWidth = $derived(Math.max(120, layout.listWidth - 24));

  let moreOpen = $state(false);
  let moveOpen = $state(false);
  let bulkMoveOpen = $state(false);

  /** The folders the letter may be moved to: every selectable one but its own. */
  const folders = $derived(msg ? app.mailboxes.folders.filter((f) => f.account_id === msg.row.account_id && f.selectable && !f.hidden && f.name !== msg.row.folder) : []);
  const canLabel = $derived(msg ? labels.writable([msg.row]) : false);
  const messageCommands = $derived(extensions.commands().filter((c) => c.message));
  const pluginActions = $derived(registry.items("messageActions").filter((a) => { try { return !a.when || (msg ? a.when(msg) : false); } catch { /* a faulty plugin hides its item */ return false; } }));

  /** The folders of several chosen rows, when they all lie in one account. */
  const bulkAccount = $derived.by(() => {
    const ids = [...app.selection.selected];
    const accs = new Set(app.list.messages.filter((m) => ids.includes(m.id)).map((m) => m.account_id));
    return accs.size === 1 ? [...accs][0] : null;
  });
  const bulkFolders = $derived(bulkAccount ? app.mailboxes.folders.filter((f) => f.account_id === bulkAccount && f.selectable && !f.hidden) : []);

  function editDraft() {
    if (!account || !msg) return;
    app.compose.open({
      account_id: account.id,
      draft: fromDraft(msg, { name: account.display_name, email: account.email }),
      draft_id: msg.row.id, draft_message_id: msg.row.message_id,
    });
  }
</script>

{#snippet moreMenu()}
  <Popover bind:open={moreOpen} align="left">
    <button class="mi" onclick={() => { moreOpen = false; if (msg) app.selection.flag("flagged", !msg.row.flags.flagged); }}>
      <Flag size={15} /> {msg?.row.flags.flagged ? t("act.unflag") : t("act.setFlag")}<span class="hint"><Keys of="core.flag" /></span>
    </button>
    <button class="mi" onclick={() => { moreOpen = false; if (msg) app.selection.flag("seen", !msg.row.flags.seen); }}>
      {#if msg?.row.flags.seen}<Mail size={15} /> {t("act.markUnread")}{:else}<MailOpen size={15} /> {t("act.markRead")}{/if}<span class="hint"><Keys of="core.unread" /></span>
    </button>
    <button class="mi" disabled={!canLabel} title={!canLabel ? t("label.noRightHint") : undefined} onclick={() => { moreOpen = false; if (msg) labels.openPick([msg.row.id]); }}>
      <Tag size={15} /> {t("act.labels")}<span class="hint"><Keys of="core.labels" /></span>
    </button>
    {#if folders.length}
      <button class="mi" onclick={() => { moreOpen = false; moveOpen = true; }}><Folder size={15} /> {t("act.moveTo")}</button>
    {/if}
    {#if app.windowOf === null && !isDraft && msg}
      <button class="mi" onclick={() => { moreOpen = false; if (msg) app.selection.openWindow(msg.row); }}><AppWindow size={15} /> {t("act.newWindow")}</button>
    {/if}
    <button class="mi" onclick={() => { moreOpen = false; printOpened(); }}><Printer size={15} /> {t("act.print")}<span class="hint"><Keys of="core.print" /></span></button>
    <hr />
    <button class="mi" onclick={() => { moreOpen = false; app.actions.spam(); }}><ShieldAlert size={15} /> {t("act.spam")}<span class="hint"><Keys of="core.spam" /></span></button>
    {#each messageCommands as c (c.ext.id + c.id)}
      <button class="mi ext-cmd" onclick={() => { moreOpen = false; extensions.command(c.ext, c.id, message); }}><Puzzle size={15} /> {c.title}</button>
    {/each}
    {#each pluginActions as a (a.id)}
      <button class="mi" onclick={() => { moreOpen = false; if (msg) a.run(msg); }}>{#if a.icon}<a.icon size={15} />{/if} {a.title()}{#if a.hint}<span class="hint">{a.hint}</span>{/if}</button>
    {/each}
  </Popover>
  <Popover bind:open={moveOpen} align="left">
    <div class="mt">{t("act.moveTitle")}</div>
    <div class="folder-list">
      {#each folders as f (f.name)}
        <button class="mi" onclick={() => { moveOpen = false; app.actions.moveTo(f.name); }}><Folder size={15} /> {f.display_name}</button>
      {/each}
    </div>
  </Popover>
{/snippet}

{#snippet letterActions()}
  {#if isDraft}
    <button class="btn primary" onclick={editDraft}><Pencil size={15} /> {t("act.continueDraft")}</button>
  {/if}
  <button class="btn ghost" onclick={() => app.actions.archive()} title={shortcuts.titled(t("act.doneHint"), "core.archive")}><Archive size={16} /> <span class="lbl">{t("act.done")}</span></button>
  {#each registry.lists.readerToolbar as b (b)}<b.item.component {...b.item.props ?? {}} />{/each}
  <button class="btn ghost" onclick={() => app.actions.remove()} title={shortcuts.titled(t("act.deleteHint"), "core.delete")}><Trash size={16} /> <span class="lbl">{t("act.delete")}</span></button>
  <span class="sp"></span>
  <span class="anchor">
    <button class="btn ghost" onclick={() => (moreOpen = !moreOpen)} title={t("act.more")}><Ellipsis size={16} /> <span class="lbl">{t("act.more")}</span></button>
    {@render moreMenu()}
  </span>
{/snippet}

{#snippet bulkActions()}
  <button class="btn ghost" onclick={() => app.actions.archive()}><Archive size={15} /> {t("act.done")}</button>
  {#each registry.lists.bulkToolbar as b (b)}<b.item.component {...b.item.props ?? {}} />{/each}
  <button class="btn ghost" onclick={() => app.selection.flag("seen", true)}>{t("act.read")}</button>
  <button class="btn ghost" onclick={() => app.selection.flag("seen", false)}>{t("act.unread")}</button>
  <button class="btn ghost" onclick={() => app.selection.flag("flagged", true)}><Flag size={15} /> {t("act.flag")}</button>
  <button class="btn ghost" onclick={() => app.actions.remove()}><Trash size={15} /> {t("act.delete")}</button>
  {#if bulkFolders.length}
    <span class="anchor">
      <button class="btn ghost" onclick={() => (bulkMoveOpen = !bulkMoveOpen)}><Folder size={15} /> {t("act.toFolder")}</button>
      <Popover bind:open={bulkMoveOpen} align="left">
        <div class="mt">{t("act.moveTitle")}</div>
        <div class="folder-list">
          {#each bulkFolders as f (f.name)}
            <button class="mi" onclick={() => { bulkMoveOpen = false; app.actions.moveTo(f.name); }}><Folder size={15} /> {f.display_name}</button>
          {/each}
        </div>
      </Popover>
    </span>
  {/if}
{/snippet}

<div class="unibar" data-tauri-drag-region>
  <div class="slot" style:width="{slotWidth}px">{@render search()}</div>
  <div class="actions" role="toolbar" aria-label={t("label.actions")}>
    {#if multi}
      {@render bulkActions()}
    {:else if single}
      {@render letterActions()}
    {/if}
  </div>
</div>

<style>
  /* The panel stands on the reader's ground with a line under it (1.7 В), so it reads as a
     layer of its own above the letter, not as its header. */
  .unibar {
    grid-row: 1;
    grid-column: 2 / -1;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    background: var(--paper-2);
    border-bottom: 1px solid var(--line);
    /* The right edge stays clear for the window controls (WindowControls.svelte). */
    padding: 6px 144px 6px 12px;
  }

  /* The list column begins one hairline (its separator) right of the panel: the slot takes
     that hairline so the search's left edge is the header's, with 12 px on both sides. */
  .slot {
    flex: none;
    min-width: 0;
    margin-left: 1px;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    flex: 1;
    /* Question 1.9 (a medium width) is not decided: the actions wrap as the reader's toolbar
       does today. */
    flex-wrap: wrap;
  }

  .sp {
    flex: 1;
  }

  .anchor {
    position: relative;
    display: inline-flex;
  }

  .folder-list {
    max-height: 320px;
    overflow-y: auto;
  }
</style>
