<script lang="ts">
  import { ask, open as openDialog, save } from "@tauri-apps/plugin-dialog";
  import Reply from "@lucide/svelte/icons/reply";
  import ReplyAll from "@lucide/svelte/icons/reply-all";
  import Forward from "@lucide/svelte/icons/forward";
  import Archive from "@lucide/svelte/icons/archive";
  import AlarmClock from "@lucide/svelte/icons/alarm-clock";
  import Trash from "@lucide/svelte/icons/trash-2";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import Flag from "@lucide/svelte/icons/flag";
  import Mail from "@lucide/svelte/icons/mail";
  import MailOpen from "@lucide/svelte/icons/mail-open";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import ListX from "@lucide/svelte/icons/list-x";
  import Folder from "@lucide/svelte/icons/folder";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import Download from "@lucide/svelte/icons/download";
  import Pencil from "@lucide/svelte/icons/pencil";
  import ImageOff from "@lucide/svelte/icons/image-off";
  import MessageSquareReply from "@lucide/svelte/icons/message-square-reply";
  import { app } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { addrFull, avatarColor, initials, linkify, listDate, longDate, size } from "../lib/format";
  import { emptyDraft, fromDraft, withSignature } from "../lib/compose";
  import { t, tn } from "../lib/i18n.svelte";
  import Puzzle from "@lucide/svelte/icons/puzzle";
  import { extensions, fromRow } from "../lib/extensions.svelte";
  import { registry } from "../plugin-host/registry.svelte";
  import type { Banner as PluginBanner } from "../plugin-api";
  import MailFrame from "./MailFrame.svelte";
  import Popover from "./Popover.svelte";
  import type { Addr, AttachmentInfo } from "../lib/types";

  let { onReply, onForward }: { onReply: (all: boolean) => void; onForward: () => void } = $props();

  const msg = $derived(app.opened);
  const account = $derived(msg ? app.account(msg.row.account_id) : undefined);
  const folders = $derived(
    msg ? app.folders.filter((f) => f.account_id === msg.row.account_id && f.selectable && !f.hidden && f.name !== msg.row.folder) : [],
  );
  const isDraft = $derived(msg ? app.folder(msg.row.account_id, msg.row.folder)?.role === "drafts" : false);
  const files = $derived(msg ? msg.view.attachments.filter((a) => !(a.inline && a.content_id)) : []);
  const showRemoteBanner = $derived(!!msg && msg.view.has_remote_content && !app.allowRemote && !msg.trusted_sender);
  /** "To: me" says nothing: shown only when someone else got it too. */
  const onlyToMe = $derived.by(() => {
    const s = msg?.view.summary;
    const me = account?.email.toLowerCase();
    return !!s && !!me && s.cc.length === 0 && s.to.length === 1 && s.to[0].email.toLowerCase() === me;
  });
  const bulk = $derived(app.selected.size > 1);
  const bulkAccount = $derived.by(() => {
    const ids = [...app.selected];
    const accs = new Set(app.messages.filter((m) => ids.includes(m.id)).map((m) => m.account_id));
    return accs.size === 1 ? [...accs][0] : null;
  });
  const bulkFolders = $derived(bulkAccount ? app.folders.filter((f) => f.account_id === bulkAccount && f.selectable && !f.hidden) : []);

  async function link(href: string) {
    if (href.toLowerCase().startsWith("mailto:")) {
      const acc = account ?? app.accounts[0];
      if (!acc) return;
      const to = decodeURIComponent(href.slice(7).split("?")[0]);
      const draft = emptyDraft({ name: acc.display_name, email: acc.email });
      draft.to = to ? to.split(",").map((email) => ({ name: null, email: email.trim() })) : [];
      const subject = new URLSearchParams(href.split("?")[1] ?? "").get("subject");
      if (subject) draft.subject = subject;
      app.compose = { account_id: acc.id, draft: withSignature(draft, acc.signature), draft_id: null };
      return;
    }
    const ok = await ask(`${t("link.open")}\n\n${href}`, { title: t("app.name"), okLabel: t("link.openButton"), cancelLabel: t("cancel") });
    if (ok) api.openLink(href).catch((e) => app.fail(e));
  }

  async function openAttachment(a: AttachmentInfo) {
    if (!msg) return;
    try {
      await api.attachmentOpen(msg.row.id, a.index);
    } catch (e) {
      app.fail(e);
    }
  }

  async function saveAttachment(a: AttachmentInfo) {
    if (!msg) return;
    const path = await save({ defaultPath: a.name, title: t("file.saveTitle") });
    if (!path) return;
    try {
      await api.attachmentSave(msg.row.id, a.index, path);
      app.toast(t("file.saved", { name: a.name }));
    } catch (e) {
      app.fail(e);
    }
  }

  async function saveAll() {
    if (!msg) return;
    const dir = await openDialog({ directory: true, title: t("file.saveAllTitle") });
    if (!dir || Array.isArray(dir)) return;
    try {
      const n = await api.attachmentsSaveAll(msg.row.id, dir);
      app.toast(tn("file.savedAll", n));
    } catch (e) {
      app.fail(e);
    }
  }

  let moreOpen = $state(false);
  let moveOpen = $state(false);
  const banners = $derived(msg ? extensions.banners.filter((b) => b.messageId === msg.row.id) : []);
  const messageCommands = $derived(msg ? extensions.commands().filter((c) => c.message) : []);
  const pluginBanners = $derived(msg ? registry.collect<PluginBanner, typeof msg>("banners", msg) : []);
  const pluginActions = $derived(
    msg ? registry.items("messageActions").filter((a) => { try { return !a.when || a.when(msg); } catch { return false; } }) : [],
  );

  function extMessage() {
    return msg ? fromRow(msg.row, account?.email ?? "", msg.view.text) : null;
  }

  function bannerAction(extId: string, actionId: string) {
    const ext = extensions.enabled().find((e) => e.id === extId);
    if (ext) extensions.command(ext, actionId, extMessage());
  }

  /** Every letter of this sender, wherever it lies. */
  function fromSender() {
    const email = msg?.view.summary.from?.email;
    if (email) app.setView({ kind: "search", text: `from:${email}` });
  }


  async function trustSender() {
    const email = msg?.view.summary.from?.email;
    if (!email || !msg) return;
    await api.trustSender(email).catch((e) => app.fail(e));
    app.open(msg.row.id, true);
  }

  function editDraft() {
    if (!msg || !account) return;
    app.compose = {
      account_id: account.id,
      draft: fromDraft(msg, { name: account.display_name, email: account.email }),
      draft_id: msg.row.id,
    };
  }

  function list(addrs: Addr[]): string {
    return addrs.map(addrFull).join(", ");
  }
</script>

<section class="reader">
  {#if bulk}
    <div class="center">
      <h3>{t("bulk.selected", { n: app.selected.size })}</h3>
      <div class="actions">
        <button class="btn" onclick={() => app.archive()}><Archive size={15} /> {t("act.done")}</button>
        {#each registry.lists.bulkToolbar as b (b)}<b.item.component {...b.item.props ?? {}} />{/each}
        <button class="btn" onclick={() => app.flag("seen", true)}>{t("act.read")}</button>
        <button class="btn" onclick={() => app.flag("seen", false)}>{t("act.unread")}</button>
        <button class="btn" onclick={() => app.flag("flagged", true)}><Flag size={15} /> {t("act.flag")}</button>
        <button class="btn" onclick={() => app.remove()}><Trash size={15} /> {t("act.delete")}</button>
        {#if bulkFolders.length}
          <select class="input" onchange={(e) => { const v = e.currentTarget.value; e.currentTarget.value = ""; if (v) app.moveTo(v); }}>
            <option value="">{t("act.toFolder")}</option>
            {#each bulkFolders as f (f.name)}<option value={f.name}>{f.display_name}</option>{/each}
          </select>
        {/if}
      </div>
    </div>
  {:else if app.openError}
    <div class="center">
      <p class="danger-text">{app.openError.message}</p>
      {#if app.opened === null && app.selected.size === 1}
        <button class="btn" onclick={() => app.open([...app.selected][0])}>{t("retry")}</button>
      {/if}
    </div>
  {:else if msg}
    <div class="toolbar" data-tauri-drag-region>
      {#if isDraft}
        <button class="btn primary" onclick={editDraft}><Pencil size={15} /> {t("act.continueDraft")}</button>
      {:else}
        <button class="btn ghost" onclick={() => onReply(false)} title={t("act.replyHint")}><Reply size={16} /> {t("act.reply")}</button>
        <button class="btn ghost" onclick={() => onReply(true)} title={t("act.replyAllHint")}><ReplyAll size={16} /><span class="lbl">{t("act.replyAll")}</span></button>
        <button class="btn ghost" onclick={onForward} title={t("act.forwardHint")}><Forward size={16} /><span class="lbl">{t("act.forward")}</span></button>
      {/if}
      <span class="sep" data-tauri-drag-region></span>
      <button class="btn ghost" onclick={() => app.archive()} title={t("act.doneHint")}><Archive size={16} /><span class="lbl2">{t("act.done")}</span></button>
      {#each registry.lists.readerToolbar as b (b)}<b.item.component {...b.item.props ?? {}} />{/each}
      <button class="btn ghost icon" onclick={() => app.remove()} title={t("act.deleteHint")} aria-label={t("act.delete")}><Trash size={16} /></button>
      <span class="anchor">
        <button class="btn ghost icon" onclick={() => (moreOpen = !moreOpen)} title={t("act.more")} aria-label={t("act.more")}><Ellipsis size={16} /></button>
        <Popover bind:open={moreOpen}>
          <button class="mi" onclick={() => { moreOpen = false; app.flag("flagged", !msg.row.flags.flagged); }}>
            <Flag size={15} /> {msg.row.flags.flagged ? t("act.unflag") : t("act.setFlag")}<span class="hint">s</span>
          </button>
          <button class="mi" onclick={() => { moreOpen = false; app.flag("seen", !msg.row.flags.seen); }}>
            {#if msg.row.flags.seen}<Mail size={15} /> {t("act.markUnread")}{:else}<MailOpen size={15} /> {t("act.markRead")}{/if}<span class="hint">u</span>
          </button>
          {#if folders.length}
            <button class="mi" onclick={() => { moreOpen = false; moveOpen = true; }}><Folder size={15} /> {t("act.moveTo")}</button>
          {/if}
          <hr />
          <button class="mi" onclick={() => { moreOpen = false; app.spam(); }}><ShieldAlert size={15} /> {t("act.spam")}<span class="hint">!</span></button>
          {#each messageCommands as c (c.ext.id + c.id)}
            <button class="mi ext-cmd" onclick={() => { moreOpen = false; extensions.command(c.ext, c.id, extMessage()); }}><Puzzle size={15} /> {c.title}</button>
          {/each}
          {#each pluginActions as a (a.id)}
            <button class="mi" onclick={() => { moreOpen = false; a.run(msg); }}>{#if a.icon}<a.icon size={15} />{/if} {a.title()}{#if a.hint}<span class="hint">{a.hint}</span>{/if}</button>
          {/each}
        </Popover>
        <Popover bind:open={moveOpen}>
          <div class="mt">{t("act.moveTitle")}</div>
          <div class="folder-list">
            {#each folders as f (f.name)}
              <button class="mi" onclick={() => { moveOpen = false; app.moveTo(f.name); }}><Folder size={15} /> {f.display_name}</button>
            {/each}
          </div>
        </Popover>
      </span>
    </div>

    <div class="scroll">
      {#if app.conversation.length > 1}
        <div class="conversation" aria-label={t("conv.label")}>
          {#each app.conversation as m (m.id)}
            {#if m.id === msg.row.id}
              <div class="conv current"><span class="dot"></span>{m.from?.name ?? m.from?.email ?? ""}<span class="muted">· {t("conv.opened")}</span></div>
            {:else}
              <button class="conv" class:unread={!m.flags.seen} onclick={() => app.open(m.id)}>
                <span class="mini" style:background={avatarColor(m.from?.email ?? "")}>{initials(m.from)}</span>
                <span class="who">{m.from?.name ?? m.from?.email ?? ""}</span>
                {#if app.folder(m.account_id, m.folder)?.role === "sent"}<span class="muted">· {t("conv.youReplied")}</span>{/if}
                <span class="when muted">{listDate(m.date)}</span>
              </button>
            {/if}
          {/each}
        </div>
      {/if}

      <div class="head selectable">
        <h1>{msg.view.summary.subject || t("noSubject")}</h1>
        <div class="from">
          <span class="avatar" style:background={avatarColor(msg.view.summary.from?.email ?? "")}>{initials(msg.view.summary.from)}</span>
          <div class="who">
            <div>
              <button class="sender" onclick={fromSender} title={t("reader.fromSender")}>
                {msg.view.summary.from?.name ?? msg.view.summary.from?.email ?? t("list.noSender")}
              </button>
              {#if msg.view.summary.from?.name}<span class="muted">&lt;{msg.view.summary.from.email}&gt;</span>{/if}
              {#each registry.lists.readerHeader as h (h)}<h.item.component {...h.item.props ?? {}} />{/each}
            </div>
            {#if msg.view.summary.to.length && !onlyToMe}<div class="muted small">{t("compose.fwd.to")}: {list(msg.view.summary.to)}</div>{/if}
            {#if msg.view.summary.cc.length}<div class="muted small">{t("compose.fwd.cc")}: {list(msg.view.summary.cc)}</div>{/if}
          </div>
          <div class="date muted small">
            {longDate(msg.view.summary.date ?? msg.row.date)}
            {#if app.accounts.length > 1 && account}<div>{account.display_name || account.email}</div>{/if}
          </div>
        </div>
      </div>

      {#each banners as b (b.ext)}
        <div class="banner ext-banner" class:info={b.tone === "info"} data-ext={b.ext}>
          <Puzzle size={15} />
          <span><b>{b.name}:</b> {b.text}</span>
          {#each b.actions as a (a.id)}<button class="btn ghost" onclick={() => bannerAction(b.ext, a.id)}>{a.title}</button>{/each}
        </div>
      {/each}
      {#each pluginBanners as b, i (i)}
        <div class="banner" class:info={b.tone !== "warn"}>
          {#if b.icon}<b.icon size={15} />{/if}
          <span>{b.text}</span>
          {#each b.actions ?? [] as a (a.title)}<button class="btn" class:primary={a.primary} class:ghost={!a.primary} onclick={a.run}>{a.title}</button>{/each}
        </div>
      {/each}
      <!-- A quiet line, not a warning: hidden images are the normal state. -->
      {#if showRemoteBanner}
        <div class="remote" title={t("reader.remoteWhy")}>
          <ImageOff size={14} />
          <span>{t("reader.remoteHidden")}</span>
          <button class="link" onclick={() => app.open(msg.row.id, true)}>{t("reader.show")}</button>
          {#if msg.view.summary.from}
            <span aria-hidden="true">·</span>
            <button class="link" onclick={trustSender}>{t("reader.alwaysFor", { email: msg.view.summary.from.email })}</button>
          {/if}
        </div>
      {/if}

      {#if files.length}
        <div class="files">
          {#each files as a (a.index)}
            <div class="file">
              <button class="file-name" onclick={() => openAttachment(a)} title={t("file.open")}><Paperclip size={13} /> {a.name}</button>
              <span class="muted small">{size(a.size)}</span>
              <button class="btn ghost small-btn" onclick={() => saveAttachment(a)} title={t("file.save")} aria-label={t("file.save")}><Download size={14} /></button>
            </div>
          {/each}
          {#if files.length > 1}<button class="btn ghost small-btn" onclick={saveAll}>{t("file.saveAll")}</button>{/if}
        </div>
      {/if}

      <div class="body">
        {#if msg.view.html}
          <!-- WebKitGTK does not reload an iframe when srcdoc changes: recreate it instead. -->
          {#key `${msg.row.id}:${app.allowRemote || msg.trusted_sender}`}
            <MailFrame html={msg.view.html} allowRemote={app.allowRemote || msg.trusted_sender} onLink={link} />
          {/key}
        {:else}
          <div class="plain selectable">
            {#each linkify(msg.view.text ?? "") as part, i (i)}
              {#if part.href}<a href={part.href} onclick={(e) => { e.preventDefault(); link(part.href!); }}>{part.text}</a>{:else}{part.text}{/if}
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {:else if app.opening}
    <div class="center muted">{t("reader.loading")}</div>
  {:else}
    <!-- One way in instead of a wall of keys: the palette lists every command with its key. -->
    <div class="center muted">
      <div class="hint">
        <p>{t("reader.choose")}</p>
        <p class="small"><kbd>Ctrl</kbd>+<kbd>K</kbd> — {t("keys.all")}</p>
      </div>
    </div>
  {/if}
</section>

<style>
  .reader {
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--paper-2);
  }

  .center {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px;
    text-align: center;
  }

  .hint .small {
    max-width: 380px;
    line-height: 1.9;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    /* The right edge stays clear for the window controls (WindowControls.svelte). */
    padding: 8px 144px 8px 12px;
    flex-wrap: wrap;
  }

  .anchor {
    position: relative;
    display: inline-flex;
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

  .scroll {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  .conversation {
    margin: 12px 22px 0;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper);
    overflow: hidden;
  }

  .conv {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    border: none;
    border-bottom: 1px solid var(--line);
    background: none;
    text-align: left;
    font-size: 13px;
  }

  .conv:last-child {
    border-bottom: none;
  }

  .conv:hover {
    background: var(--hover);
  }

  .conv.current {
    background: var(--paper-2);
    font-weight: 600;
  }

  .conv.unread .who {
    font-weight: 650;
  }

  .conv .dot {
    width: 20px;
    display: inline-flex;
    justify-content: center;
  }

  .conv .dot::before {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }

  .conv .when {
    margin-left: auto;
    font-size: 12px;
  }

  .mini {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
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



  .banner.info {
    background: color-mix(in srgb, var(--link) 9%, var(--paper));
    border-color: color-mix(in srgb, var(--link) 28%, var(--paper));
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

  .head {
    padding: 16px 22px 10px;
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

  .banner {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin: 0 22px 10px;
    padding: 8px 12px;
    background: color-mix(in srgb, var(--warn) 12%, var(--paper));
    border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--paper));
    border-radius: 6px;
    font-size: 13px;
  }

  .banner span {
    flex: 1;
    min-width: 200px;
  }

  .remote {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0 22px 10px;
    font-size: 12px;
    color: var(--muted);
  }

  .link {
    border: none;
    background: none;
    padding: 0;
    font-size: inherit;
    color: var(--link);
  }

  .link:hover {
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
    gap: 4px;
    border: 1px solid var(--line);
    background: var(--paper);
    border-radius: 6px;
    padding: 2px 4px 2px 8px;
    max-width: 320px;
  }

  .file-name {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    padding: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--link);
  }

  .small-btn {
    padding: 2px 6px;
    font-size: 12px;
  }

  .body {
    flex: 1;
    min-height: 420px;
    display: flex;
    margin: 0 16px 16px;
  }

  /* Plain text reads as a column under the header, not as a card across the pane. */
  .plain {
    flex: 1;
    max-width: 72ch;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 4px 6px 24px;
    line-height: 1.6;
  }

  .plain a {
    color: var(--link);
  }
</style>
