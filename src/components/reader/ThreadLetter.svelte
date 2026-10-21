<script lang="ts">
  // One letter of a conversation read as an accordion (0.8.4, #180; decision 4.0 Б): a folded row
  // (sender, preview, date, folder) or an unfolded letter with its own header and its own line of
  // buttons. The pane (Reader.svelte) keeps the letter that is open; Conversation.svelte holds the
  // group and which letters are unfolded — this draws one of them and its own actions.
  //
  // Quick reply and the attachment viewer stay with the letter the pane has open (4.3 А), so an
  // unfolded letter here carries its own buttons but no answer box of its own.
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Trash from "@lucide/svelte/icons/trash-2";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import Flag from "@lucide/svelte/icons/flag";
  import Mail from "@lucide/svelte/icons/mail";
  import MailOpen from "@lucide/svelte/icons/mail-open";
  import Archive from "@lucide/svelte/icons/archive";
  import Printer from "@lucide/svelte/icons/printer";
  import Reply from "@lucide/svelte/icons/reply";
  import Forward from "@lucide/svelte/icons/forward";
  import Popover from "../Popover.svelte";
  import ReaderHeader from "./ReaderHeader.svelte";
  import ReaderBody from "./ReaderBody.svelte";
  import AttachmentChip from "./AttachmentChip.svelte";
  import { api } from "../../lib/api";
  import { app } from "../../lib/store.svelte";
  import { addrName, avatarColor, initials, listDate } from "../../lib/format";
  import { t } from "../../lib/i18n.svelte";
  import { avatarOf } from "../../lib/avatars.svelte";
  import { printRow } from "../../lib/print";
  import type { AttachmentInfo, MessageRow, OpenedMessage } from "../../lib/types";

  let {
    m,
    open,
    body,
    onToggle,
    onReply,
    onForward,
  }: {
    /** The letter this row is about. */
    m: MessageRow;
    /** The letter is unfolded: its body and its buttons are shown. */
    open: boolean;
    /** The unfolded letter's body; undefined while the backend is still answering. */
    body: OpenedMessage | undefined;
    /** A click or a key folds the letter back or unfolds it. */
    onToggle: () => void;
    onReply: (all: boolean) => void;
    onForward: () => void;
  } = $props();

  let menuOpen = $state(false);

  function isMine(row: MessageRow): boolean {
    const mine = app.mailboxes.accounts.map((a) => a.email.toLowerCase());
    return !!row.from && mine.includes(row.from.email.toLowerCase());
  }

  function roleOf(row: MessageRow) {
    return app.mailboxes.folder(row.account_id, row.folder)?.role;
  }

  /** The folder of the letter, when it is not the one the pane reads (разбор №8). */
  function folderLabel(row: MessageRow): string | null {
    const f = app.mailboxes.folder(row.account_id, row.folder);
    const here = app.list.view.kind === "folder" ? app.list.view.folder : null;
    if (here === row.folder) return null;
    if (here === null && (f?.role ?? "") === "inbox") return null;
    return f?.display_name ?? row.folder;
  }

  const pic = $derived(avatarOf(m.account_id, m.from?.email, null));
  /** The letter's mailbox, for the header of the unfolded letter (дата, размер, ящик). */
  const account = $derived(app.mailboxes.account(m.account_id));

  /** The letter's files, minus the pictures drawn in its text: the reader's list (4.8). */
  const attachments = $derived((body?.view.attachments ?? []).filter((a) => !(a.inline && a.content_id)));
  /** The folder the files go to without asking; the pane's viewer reads the same. */
  const saveDir = $derived(app.mailboxes.account(m.account_id)?.attachments_dir?.trim() || app.settingsCtl.settings.attachments_dir?.trim() || "");

  /** Saving a file of a letter unfolded here: the pane's viewer saves for the open letter, this
   *  saves for the letter's own id (4.8). No viewer: the name is not a button. */
  async function saveAttachment(a: AttachmentInfo) {
    if (!saveDir) return saveAttachmentAs(a);
    try {
      const path = await app.ui.track(api.attachmentSaveIn(m.id, a.index));
      app.ui.toast(t("file.savedTo", { name: path.split(/[\\/]/).pop() ?? a.name, dir: saveDir }));
    } catch (e) {
      app.ui.fail(e);
    }
  }

  async function saveAttachmentAs(a: AttachmentInfo) {
    try {
      const path = await api.pickSaveFile(t("file.saveTitle"), a.name);
      if (!path) return;
      await app.ui.track(api.attachmentSave(m.id, a.index, path));
      app.ui.toast(t("file.saved", { name: a.name }));
    } catch (e) {
      app.ui.fail(e);
    }
  }

  /** The keyboard does what a click does; the button's own activation is taken over, so the
   *  letter is not unfolded twice. */
  function headKey(e: KeyboardEvent) {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    e.preventDefault();
    onToggle();
  }
</script>

<article class="letter" class:unread={!m.flags.seen}>
  <button class="head" class:bare={open} aria-expanded={open} onclick={onToggle} onkeydown={headKey}>
    {#if open}
      <span class="chev open"><ChevronDown size={14} /></span>
    {:else}
      <span class="mini" class:pic style:background={pic ? null : avatarColor(m.from?.email ?? "")}>
        {#if pic}<img src={pic} alt="" />{:else}{initials(m.from)}{/if}
      </span>
      <!-- Folded: the name alone, the address on hover; the unfolded letter wears the pane's
           full header (4.6 revised 2026-10-14). -->
      <span class="who" title={m.from?.email || undefined}>{isMine(m) ? t("list.me") : addrName(m.from) || t("list.noSender")}</span>
      {#if roleOf(m) === "drafts"}<span class="draft-tag">{t("conv.draft")}</span>
      {:else if roleOf(m) === "sent" && !isMine(m)}<span class="muted">· {t("conv.youReplied")}</span>{/if}
      {#if m.snippet}<span class="peek muted">{m.snippet}</span>{/if}
      <span class="when muted">{listDate(m.date)}</span>
      {#if folderLabel(m)}<span class="folder muted">{folderLabel(m)}</span>{/if}
      <span class="chev"><ChevronDown size={14} /></span>
    {/if}
  </button>

  {#if open}
    {#if body}
      <!-- The same header as the letter open in the pane (4.6 revised 2026-10-14): the sender
           with the address, «Кому» and «Копия», the marks, the date, the size and the mailbox. -->
      <ReaderHeader
        msg={body}
        picture={pic}
        {account}
        files={[]}
        viewing={false}
        viewingAt={0}
        onViewAttachment={() => {}}
        onSaveAttachment={() => {}}
        onSaveAttachmentAs={() => {}}
        onSaveAll={() => {}}
        saveDir=""
      />
      <div class="letter-body"><ReaderBody msg={body} viewing={false} /></div>
    {:else}
      <p class="loading muted">{t("loading")}</p>
    {/if}
    <!-- The letter's files: name, size, a button that saves each (4.8). No viewer here. -->
    {#if attachments.length}
      <div class="files">
        {#each attachments as a (a.index)}
          <AttachmentChip {a} {saveDir} onSave={saveAttachment} onSaveAs={saveAttachmentAs} />
        {/each}
      </div>
    {/if}
    <div class="acts">
      <button class="btn ghost" onclick={() => onReply(false)}><Reply size={14} /> {t("act.reply")}</button>
      <button class="btn ghost" onclick={onForward}><Forward size={14} /> {t("act.forward")}</button>
      <button class="btn ghost" onclick={() => app.actions.remove([m.id], true)}><Trash size={14} /> {t("act.delete")}</button>
      <span class="anchor">
        <button class="btn ghost icon" onclick={() => (menuOpen = !menuOpen)} title={t("act.more")} aria-label={t("act.more")}><Ellipsis size={14} /></button>
        <Popover bind:open={menuOpen} align="left">
          <button class="mi" onclick={() => { menuOpen = false; app.selection.flag("flagged", !m.flags.flagged, [m.id]); }}>
            <Flag size={15} /> {m.flags.flagged ? t("act.unflag") : t("act.setFlag")}
          </button>
          <button class="mi" onclick={() => { menuOpen = false; app.selection.flag("seen", !m.flags.seen, [m.id]); }}>
            {#if m.flags.seen}<Mail size={15} /> {t("act.markUnread")}{:else}<MailOpen size={15} /> {t("act.markRead")}{/if}
          </button>
          <button class="mi" onclick={() => { menuOpen = false; app.actions.archive([m.id], true); }}><Archive size={15} /> {t("act.done")}</button>
          <button class="mi" onclick={() => { menuOpen = false; printRow(m.id); }}><Printer size={15} /> {t("act.print")}</button>
        </Popover>
      </span>
    </div>
  {/if}
</article>

<style>
  .letter {
    border-bottom: 1px solid var(--line);
  }

  /* The last letter of a side closes it, whether «Ещё N писем» stands above or below it. */
  .letter:last-of-type {
    border-bottom: none;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 9px 12px;
    border: none;
    background: none;
    text-align: left;
    font-size: 13px;
  }

  .head:hover {
    background: var(--hover);
  }

  /* Unfolded: the strip above the pane's header only folds the letter back (4.6 revised). */
  .head.bare {
    justify-content: flex-end;
    padding: 4px 12px;
  }

  .unread .who {
    font-weight: 650;
  }

  .mini {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }

  /* A photo fills the circle; logos are drawn for a white ground. */
  .mini.pic {
    background: #fff;
    overflow: hidden;
    box-shadow: inset 0 0 0 1px var(--line);
  }

  .mini.pic img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .who {
    flex: none;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The preview of a folded letter takes the rest of the row and is cut to it. */
  .peek {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .when,
  .folder {
    flex: none;
    margin-left: auto;
    font-size: 12px;
  }

  .folder {
    margin-left: 0;
  }

  .chev {
    flex: none;
    display: inline-flex;
    color: var(--muted);
  }

  .chev.open {
    transform: rotate(180deg);
  }

  .draft-tag {
    flex: none;
    color: var(--accent-text);
    font-weight: 600;
    font-size: 12px;
  }

  .letter-body {
    padding: 0 12px 10px;
  }

  /* The letter's own card is the pane's (ReaderBody): inside the row it keeps the row's margins. */
  .letter-body :global(.body) {
    margin: 0;
  }

  /* The letter's files, as the pane's strip shows them (4.8): the same chips, wrapped. */
  .files {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0 12px 10px;
    align-items: center;
  }

  .loading {
    padding: 8px 12px 10px;
    margin: 0;
  }

  .acts {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 12px 10px;
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
</style>
