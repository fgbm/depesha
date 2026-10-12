<script lang="ts">
  // The letter's own actions and their menu (0.8.3, #176): «Готово», the plugins' buttons,
  // «Удалить» и «Ещё». They stand in the action panel above the list and the letter, and in the
  // toolbar of a narrow window or of a letter opened in a window of its own — one copy of the
  // buttons and the menu for every place.
  //
  // The panel shows every button with its label, and drops the labels for the icons when the row
  // has no room (decision 1.9 В). The toolbar keeps the look of main: «Готово» with its `.lbl2`,
  // «Удалить» and «Ещё» as icons alone (`.compact` hides the labels, the container queries take
  // over in a narrow reader). While another letter is being opened the buttons are not shown at
  // all: nothing may act on the letter leaving the pane.
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
  import Popover from "../Popover.svelte";
  import Keys from "../Keys.svelte";
  import { app } from "../../lib/store.svelte";
  import { fromDraft } from "../../lib/compose";
  import { printOpened } from "../../lib/print";
  import { i18n, t } from "../../lib/i18n.svelte";
  import { shortcuts } from "../../lib/shortcuts.svelte";
  import { labelFit } from "../../lib/labelFit.svelte";
  import { extensions } from "../../lib/extensions.svelte";
  import type { ExtMessage } from "../../lib/extensions.svelte";
  import { registry } from "../../plugin-host/registry.svelte";
  import type { Rendered } from "../../plugin-api";
  import { labels } from "../../lib/labels.svelte";
  import type { AccountView, OpenedMessage } from "../../lib/types";

  let {
    msg,
    account,
    isDraft,
    message,
    compact = false,
    inactive = false,
  }: {
    msg: OpenedMessage;
    /** The letter's mailbox; the draft opens a window from it. */
    account: AccountView | undefined;
    /** The letter is a draft: it offers «continue» instead of the actions of a letter. */
    isDraft: boolean;
    /** The letter as a plugin sees it; the menu items of extensions act on it. */
    message: ExtMessage | null;
    /** The reader's own toolbar: the labels as in main, no fitting of the row. */
    compact?: boolean;
    /** Another letter is being opened: the buttons stand aside, they must not act on this one. */
    inactive?: boolean;
  } = $props();

  let moreOpen = $state(false);
  let moveOpen = $state(false);

  /** The folders the letter may be moved to: every selectable one but its own. */
  const folders = $derived(app.mailboxes.folders.filter((f) => f.account_id === msg.row.account_id && f.selectable && !f.hidden && f.name !== msg.row.folder));
  const canLabel = $derived(labels.writable([msg.row]));
  const messageCommands = $derived(extensions.commands().filter((c) => c.message));
  const pluginActions = $derived(registry.items("messageActions").filter((a) => { try { return !a.when || a.when(msg); } catch { /* a faulty plugin hides its item */ return false; } }));
  const plugins = $derived(registry.lists.readerToolbar);

  // The row with labels: on a narrower panel the labels go and the icons stay (decision 1.9 В).
  // The reader's own toolbar keeps main's look, so it is not fitted.
  const fit = labelFit(() => [msg.row.id, isDraft, plugins.length, i18n.lang]);
  const icons = $derived(!compact && fit.icons);

  function editDraft() {
    if (!account) return;
    app.compose.open({
      account_id: account.id,
      draft: fromDraft(msg, { name: account.display_name, email: account.email }),
      draft_id: msg.row.id, draft_message_id: msg.row.message_id,
    });
  }
</script>

{#snippet draftBtn()}
  <button class="btn primary" onclick={editDraft}><Pencil size={15} /> {t("act.continueDraft")}</button>
{/snippet}

{#snippet doneBtn()}
  <button class="btn ghost" onclick={() => app.actions.archive()} title={shortcuts.titled(t("act.doneHint"), "core.archive")}><Archive size={16} /> <span class={compact ? "lbl2" : "lbl"}>{t("act.done")}</span></button>
{/snippet}

{#snippet pluginBtn(r: Rendered)}
  <r.component {...r.props ?? {}} />
{/snippet}

{#snippet deleteBtn()}
  {#if compact}
    <button class="btn ghost icon" onclick={() => app.actions.remove()} title={shortcuts.titled(t("act.deleteHint"), "core.delete")} aria-label={t("act.delete")}><Trash size={16} /></button>
  {:else}
    <button class="btn ghost" onclick={() => app.actions.remove()} title={shortcuts.titled(t("act.deleteHint"), "core.delete")} aria-label={t("act.delete")}><Trash size={16} /> <span class="lbl">{t("act.delete")}</span></button>
  {/if}
{/snippet}

{#snippet moreBtn()}
  {#if compact}
    <button class="btn ghost icon" onclick={() => (moreOpen = !moreOpen)} title={t("act.more")} aria-label={t("act.more")}><Ellipsis size={16} /></button>
  {:else}
    <button class="btn ghost" onclick={() => (moreOpen = !moreOpen)} title={t("act.more")} aria-label={t("act.more")}><Ellipsis size={16} /> <span class="lbl">{t("act.more")}</span></button>
  {/if}
{/snippet}

{#snippet moreMenu()}
  <Popover bind:open={moreOpen} align="left">
    <button class="mi" onclick={() => { moreOpen = false; app.selection.flag("flagged", !msg.row.flags.flagged); }}>
      <Flag size={15} /> {msg.row.flags.flagged ? t("act.unflag") : t("act.setFlag")}<span class="hint"><Keys of="core.flag" /></span>
    </button>
    <button class="mi" onclick={() => { moreOpen = false; app.selection.flag("seen", !msg.row.flags.seen); }}>
      {#if msg.row.flags.seen}<Mail size={15} /> {t("act.markUnread")}{:else}<MailOpen size={15} /> {t("act.markRead")}{/if}<span class="hint"><Keys of="core.unread" /></span>
    </button>
    <button class="mi" disabled={!canLabel} title={!canLabel ? t("label.noRightHint") : undefined} onclick={() => { moreOpen = false; labels.openPick([msg.row.id]); }}>
      <Tag size={15} /> {t("act.labels")}<span class="hint"><Keys of="core.labels" /></span>
    </button>
    {#if folders.length}
      <button class="mi" onclick={() => { moreOpen = false; moveOpen = true; }}><Folder size={15} /> {t("act.moveTo")}</button>
    {/if}
    {#if app.windowOf === null && !isDraft}
      <button class="mi" onclick={() => { moreOpen = false; app.selection.openWindow(msg.row); }}><AppWindow size={15} /> {t("act.newWindow")}</button>
    {/if}
    <button class="mi" onclick={() => { moreOpen = false; printOpened(); }}><Printer size={15} /> {t("act.print")}<span class="hint"><Keys of="core.print" /></span></button>
    <hr />
    <button class="mi" onclick={() => { moreOpen = false; app.actions.spam(); }}><ShieldAlert size={15} /> {t("act.spam")}<span class="hint"><Keys of="core.spam" /></span></button>
    {#each messageCommands as c (c.ext.id + c.id)}
      <button class="mi ext-cmd" onclick={() => { moreOpen = false; extensions.command(c.ext, c.id, message); }}><Puzzle size={15} /> {c.title}</button>
    {/each}
    {#each pluginActions as a (a.id)}
      <button class="mi" onclick={() => { moreOpen = false; a.run(msg); }}>{#if a.icon}<a.icon size={15} />{/if} {a.title()}{#if a.hint}<span class="hint">{a.hint}</span>{/if}</button>
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

<div class="row" class:grow={!compact} class:icons class:inactive bind:this={fit.el} data-tauri-drag-region>
  {#if isDraft}<span class="it" data-key="draft">{@render draftBtn()}</span>{/if}
  <span class="it" data-key="done">{@render doneBtn()}</span>
  {#each plugins as b, i (b)}
    <span class="it" data-key={"plugin-" + i}>{@render pluginBtn(b.item)}</span>
  {/each}
  <span class="it" data-key="delete">{@render deleteBtn()}</span>
  {#if !compact}<span class="sp" data-tauri-drag-region></span>{/if}
  <span class="anchor">
    {@render moreBtn()}
    {@render moreMenu()}
  </span>
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .row.grow {
    flex: 1;
  }

  /* Another letter is being opened: the buttons stand aside, they must not act on this one. */
  .row.inactive {
    visibility: hidden;
  }

  /* Decision 1.9 В: the labels go and the icons stay when the row has no room for them. They are
     taken out of the flow, not removed, so the row can measure what the labels would take. */
  .row.icons :global(.lbl),
  .row.icons :global(.lbl2) {
    position: absolute;
    visibility: hidden;
  }

  .it {
    display: inline-flex;
    flex: none;
  }

  .sp {
    flex: 1;
  }

  .anchor {
    position: relative;
    display: inline-flex;
  }

  .icon {
    min-width: 32px;
    justify-content: center;
    font-size: 15px;
  }

  .folder-list {
    max-height: 320px;
    overflow-y: auto;
  }
</style>
