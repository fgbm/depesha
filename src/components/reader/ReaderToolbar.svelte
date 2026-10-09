<script lang="ts">
  // The toolbar above the letter: the way back and the neighbours in a narrow window, the
  // draft's "continue", the actions on the letter and the menus behind "more" and "move".
  // The pane (Reader.svelte) says which letter is open and hands its own nav snippet in.
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
  import { layout } from "../../lib/layout.svelte";
  import { app } from "../../lib/store.svelte";
  import { fromDraft } from "../../lib/compose";
  import { printOpened } from "../../lib/print";
  import { t } from "../../lib/i18n.svelte";
  import { shortcuts } from "../../lib/shortcuts.svelte";
  import { extensions } from "../../lib/extensions.svelte";
  import type { ExtMessage } from "../../lib/extensions.svelte";
  import { registry } from "../../plugin-host/registry.svelte";
  import type { AccountView, OpenedMessage } from "../../lib/types";
  import type { Snippet } from "svelte";

  let {
    msg,
    account,
    isDraft,
    message,
    nav,
  }: {
    msg: OpenedMessage;
    /** The letter's mailbox; the draft opens a window from it. */
    account: AccountView | undefined;
    /** The letter is a draft: it offers "continue" instead of the actions of a letter. */
    isDraft: boolean;
    /** The letter as a plugin sees it; the menuitems of extensions act on it. */
    message: ExtMessage | null;
    /** The way back and the neighbours in a narrow window; the pane's own. */
    nav: Snippet;
  } = $props();

  let moreOpen = $state(false);
  let moveOpen = $state(false);
  /** The folders the letter may be moved to: every selectable one but its own. */
  const folders = $derived(
    app.folders.filter((f) => f.account_id === msg.row.account_id && f.selectable && !f.hidden && f.name !== msg.row.folder),
  );
  const messageCommands = $derived(extensions.commands().filter((c) => c.message));
  const pluginActions = $derived(
    registry.items("messageActions").filter((a) => { try { return !a.when || a.when(msg); } catch { return false; } }),
  );
  /** Метки в папке письма: известный запрет гасит пункт с подсказкой (#42, кадр 7). */
  const canLabel = $derived(app.labels.writable([msg.row]));

  function editDraft() {
    if (!account) return;
    app.openCompose({
      account_id: account.id,
      draft: fromDraft(msg, { name: account.display_name, email: account.email }),
      draft_id: msg.row.id, draft_message_id: msg.row.message_id,
    });
  }
</script>

<div class="toolbar" class:compact={layout.single && app.windowOf === null} data-tauri-drag-region>
  {@render nav()}
  {#if isDraft}
    <button class="btn primary" onclick={editDraft}><Pencil size={15} /> {t("act.continueDraft")}</button>
  {/if}
  <button class="btn ghost" onclick={() => app.archive()} title={shortcuts.titled(t("act.doneHint"), "core.archive")}><Archive size={16} /><span class="lbl2">{t("act.done")}</span></button>
  {#each registry.lists.readerToolbar as b (b)}<b.item.component {...b.item.props ?? {}} />{/each}
  <button class="btn ghost icon" onclick={() => app.remove()} title={shortcuts.titled(t("act.deleteHint"), "core.delete")} aria-label={t("act.delete")}><Trash size={16} /></button>
  <span class="anchor">
    <button class="btn ghost icon" onclick={() => (moreOpen = !moreOpen)} title={t("act.more")} aria-label={t("act.more")}><Ellipsis size={16} /></button>
    <Popover bind:open={moreOpen} align="left">
      <button class="mi" onclick={() => { moreOpen = false; app.flag("flagged", !msg.row.flags.flagged); }}>
        <Flag size={15} /> {msg.row.flags.flagged ? t("act.unflag") : t("act.setFlag")}<span class="hint">s</span>
      </button>
      <button class="mi" onclick={() => { moreOpen = false; app.flag("seen", !msg.row.flags.seen); }}>
        {#if msg.row.flags.seen}<Mail size={15} /> {t("act.markUnread")}{:else}<MailOpen size={15} /> {t("act.markRead")}{/if}<span class="hint">u</span>
      </button>
      <button class="mi" disabled={!canLabel} title={!canLabel ? t("label.noRightHint") : undefined} onclick={() => { moreOpen = false; app.labels.openPick([msg.row.id]); }}>
        <Tag size={15} /> {t("act.labels")}<span class="hint"><Keys of="core.labels" /></span>
      </button>
      {#if folders.length}
        <button class="mi" onclick={() => { moreOpen = false; moveOpen = true; }}><Folder size={15} /> {t("act.moveTo")}</button>
      {/if}
      {#if app.windowOf === null && !isDraft}
        <button class="mi" onclick={() => { moreOpen = false; app.openWindow(msg.row); }}><AppWindow size={15} /> {t("act.newWindow")}</button>
      {/if}
      <button class="mi" onclick={() => { moreOpen = false; printOpened(); }}><Printer size={15} /> {t("act.print")}<span class="hint"><Keys of="core.print" /></span></button>
      <hr />
      <button class="mi" onclick={() => { moreOpen = false; app.spam(); }}><ShieldAlert size={15} /> {t("act.spam")}<span class="hint">!</span></button>
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
          <button class="mi" onclick={() => { moveOpen = false; app.moveTo(f.name); }}><Folder size={15} /> {f.display_name}</button>
        {/each}
      </div>
    </Popover>
  </span>
  <!-- The actions stand from the left, over the subject; the rest of the strip drags the window. -->
  <span class="sep" data-tauri-drag-region></span>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    /* The right edge stays clear for the window controls (WindowControls.svelte); the
       buttons stand at their height, the subject comes up right under them. */
    padding: 4px 144px 0 12px;
    flex-wrap: wrap;
  }

  /* A narrow window: the way back and the neighbours come first, the actions keep only their icons. */
  .toolbar.compact :global(.lbl),
  .toolbar.compact :global(.lbl2) {
    display: none;
  }

  /* A narrow reader keeps one toolbar row: secondary labels go, tooltips stay. */
  /* Plugins' toolbar buttons use the same classes, hence :global. */
  @container (max-width: 720px) {
    .toolbar :global(.lbl) {
      display: none;
    }
  }

  @container (max-width: 520px) {
    .toolbar :global(.lbl2) {
      display: none;
    }
  }

  .anchor {
    position: relative;
    display: inline-flex;
  }

  .folder-list {
    max-height: 320px;
    overflow-y: auto;
  }

  .sep {
    flex: 1;
  }

  .icon {
    min-width: 32px;
    justify-content: center;
    font-size: 15px;
  }
</style>
