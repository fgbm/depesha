<script lang="ts">
  // The letter's title block: subject, sender with their photo or logo, recipients and the
  // date. The plugin toolbar buttons that stand beside the sender's name are handed in by
  // the pane (Reader.svelte) as a snippet: a plugin's component knows its own contract, so
  // its call stays where the plugins are read.
  import { app } from "../../lib/store.svelte";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import Download from "@lucide/svelte/icons/download";
  import FolderOutput from "@lucide/svelte/icons/folder-output";
  import { accountLabel, avatarColor, initials, longDate, size } from "../../lib/format";
  import { t } from "../../lib/i18n.svelte";
  import Recipients from "../Recipients.svelte";
  import type { AccountView, OpenedMessage } from "../../lib/types";
  import type { Snippet } from "svelte";
  import type { AttachmentInfo } from "../../lib/types";

  let {
    msg,
    picture,
    account,
    files,
    viewing,
    viewingAt,
    onViewAttachment,
    onSaveAttachment,
    onSaveAttachmentAs,
    onSaveAll,
    saveDir,
    headerActions,
  }: {
    msg: OpenedMessage;
    /** The sender's photo from Exchange, or a brand logo when the message passed DMARC. */
    picture: string | null;
    /** The letter's mailbox; shown only when there is more than one. */
    account: AccountView | undefined;
    /** The letter's files, minus the pictures drawn in its text. */
    files: AttachmentInfo[];
    /** An attachment is shown in place of the letter. */
    viewing: boolean;
    /** The shown attachment's place among the files. */
    viewingAt: number;
    onViewAttachment: (a: AttachmentInfo) => void;
    onSaveAttachment: (a: AttachmentInfo) => void;
    onSaveAttachmentAs: (a: AttachmentInfo) => void;
    onSaveAll: () => void;
    /** The folder the save button names; empty: the file dialog asks. */
    saveDir: string;
    /** A plugin's line beside the sender's name. */
    headerActions?: Snippet;
  } = $props();

  /** Who wrote it: the sender of the letter. */
  const from = $derived(msg.view.summary.from);
  /** "To: me" says nothing: shown only when someone else got it too. */
  const onlyToMe = $derived.by(() => {
    const s = msg.view.summary;
    const me = account?.email.toLowerCase();
    return !!me && s.cc.length === 0 && s.to.length === 1 && s.to[0].email.toLowerCase() === me;
  });

  /** Every letter of this sender, wherever it lies. */
  function fromSender() {
    if (from?.email) app.setView({ kind: "search", text: `from:${from.email}` });
  }
</script>

<div class="head selectable">
  <h1>{msg.view.summary.subject || t("noSubject")}</h1>
  <div class="from">
    <span class="avatar" class:pic={picture} style:background={picture ? null : avatarColor(from?.email ?? "")}>
      {#if picture}<img src={picture} alt="" />{:else}{initials(from)}{/if}
    </span>
    <div class="who">
      <div>
        <button class="sender" onclick={fromSender} title={t("reader.fromSender")}>
          {from?.name ?? from?.email ?? t("list.noSender")}
        </button>
        {#if from?.name}<span class="muted">&lt;{from.email}&gt;</span>{/if}
        {@render headerActions?.()}
      </div>
      {#key msg.row.id}<Recipients to={msg.view.summary.to} cc={msg.view.summary.cc} showTo={!onlyToMe} />{/key}
    </div>
    <div class="date muted small">
      {longDate(msg.view.summary.date ?? msg.row.date)}
      {#if msg.row.size}<div title={t("list.size")}>{size(msg.row.size)}</div>{/if}
      {#if app.accounts.length > 1 && account}<div>{accountLabel(account)}</div>{/if}
    </div>
  </div>
</div>

{#if files.length}
  <div class="files">
    {#each files as a (a.index)}
      {@const current = viewing && files[viewingAt] === a}
      <div class="file" class:current>
        <button class="file-name" onclick={() => onViewAttachment(a)} title={current ? t("viewer.close") : `${t("file.open")}: ${a.name}`} aria-pressed={current}><Paperclip size={13} /><span class="fname">{a.name}</span></button>
        <span class="fsize muted">{size(a.size)}</span>
        <button class="btn ghost small-btn" onclick={() => onSaveAttachment(a)} title={saveDir ? t("file.saveIn", { dir: saveDir }) : t("file.save")} aria-label={t("file.save")}><Download size={14} /></button>
        {#if saveDir}
          <button class="btn ghost small-btn" onclick={() => onSaveAttachmentAs(a)} title={t("file.saveAs")} aria-label={t("file.saveAs")}><FolderOutput size={14} /></button>
        {/if}
      </div>
    {/each}
    {#if files.length > 1}<button class="btn ghost small-btn" onclick={onSaveAll}>{t("file.saveAll")}</button>{/if}
  </div>
{/if}

<style>
  .head {
    padding: 4px 22px 10px;
  }

  /* Under the folded letters of the conversation it keeps a gap from their cards. */
  :global(.thread) + .head {
    padding-top: 12px;
  }

  h1 {
    margin: 0 0 12px;
    font-size: 20px;
    font-weight: 650;
    line-height: 1.3;
  }

  .from {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }

  .avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--side);
    color: #fff;
    font-size: 13px;
    letter-spacing: 0.02em;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    flex: none;
  }

  /* A photo or a logo fills the circle; logos are drawn for a white ground. */
  .avatar.pic {
    background: #fff;
    overflow: hidden;
    box-shadow: inset 0 0 0 1px var(--line);
  }

  .avatar.pic img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .who {
    flex: 1;
    min-width: 0;
    line-height: 1.45;
  }

  .who > div {
    overflow-wrap: anywhere;
  }

  .date {
    text-align: right;
    white-space: nowrap;
  }

  .small {
    font-size: 12px;
  }

  .sender {
    border: none;
    background: none;
    padding: 0;
    font-weight: 700;
    color: inherit;
  }

  .sender:hover {
    text-decoration: underline;
  }

  .files {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0 22px 10px;
    align-items: center;
  }

  .file {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 340px;
    height: 32px;
    border: 1px solid var(--line);
    background: var(--paper);
    border-radius: 6px;
    padding: 0 2px 0 8px;
  }

  /* The name shrinks with an ellipsis; the icon, size and button keep their room. */
  .file-name {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 5px;
    background: none;
    border: none;
    padding: 0;
    color: var(--link);
  }

  .file-name :global(svg) {
    flex: none;
  }

  .fname {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fname:hover {
    text-decoration: underline;
  }

  .fsize {
    flex: none;
    font-size: 12px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .file .small-btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
  }

  .small-btn {
    padding: 2px 6px;
    font-size: 12px;
  }

  .file.current {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--paper));
  }
</style>
