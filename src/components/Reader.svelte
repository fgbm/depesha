<script lang="ts">
  import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
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
  import { accountLabel, addrFull, addrName, avatarColor, initials, linkify, listDate, longDate, size } from "../lib/format";
  import { emptyDraft, fromDraft, reply, withSignature } from "../lib/compose";
  import { t, tn } from "../lib/i18n.svelte";
  import Puzzle from "@lucide/svelte/icons/puzzle";
  import { extensions, fromRow } from "../lib/extensions.svelte";
  import { registry } from "../plugin-host/registry.svelte";
  import type { Banner as PluginBanner } from "../plugin-api";
  import MailFrame from "./MailFrame.svelte";
  import Popover from "./Popover.svelte";
  import type { Addr, AttachmentInfo, ComposeDraft, MessageRow } from "../lib/types";
  import { untrack } from "svelte";
  import { avatarOf } from "../lib/avatars.svelte";

  let { onReply, onForward }: { onReply: (all: boolean) => void; onForward: () => void } = $props();

  const msg = $derived(app.opened);
  /** The sender's photo from Exchange, or a brand logo when the message passed DMARC. */
  const picture = $derived(
    msg ? avatarOf(msg.row.account_id, msg.view.summary.from?.email, msg.view.authenticated && app.settings.sender_logos) : null,
  );

  /**
   * Opening another message: after a blink (cached mail opens faster than that) its
   * header from the list shows at once with a progress line; a slow server is said so.
   */
  let waited = $state<0 | 1 | 2 | 3>(0);
  $effect(() => {
    if (!app.opening) {
      waited = 0;
      return;
    }
    waited = 0;
    const timers = [
      setTimeout(() => (waited = 1), 120),
      setTimeout(() => (waited = 2), 3000),
      setTimeout(() => (waited = 3), 15000),
    ];
    return () => timers.forEach(clearTimeout);
  });
  const showOpening = $derived(app.opening && waited > 0 && (!msg || app.openingRow?.id !== msg.row.id));
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
  /** "Reply all" is offered only when it reaches someone a plain reply does not. */
  const manyRecipients = $derived.by(() => {
    if (!msg || !account) return false;
    const me = { name: account.display_name, email: account.email };
    const one = reply(msg, me, false);
    const all = reply(msg, me, true);
    return all.to.length + all.cc.length > one.to.length + one.cc.length;
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
      app.openCompose({ account_id: acc.id, draft: withSignature(draft, acc.signature), draft_id: null });
      return;
    }
    await app.openLink(href);
  }

  async function openAttachment(a: AttachmentInfo) {
    if (!msg) return;
    try {
      await app.track(api.attachmentOpen(msg.row.id, a.index));
    } catch (e) {
      app.fail(e);
    }
  }

  async function saveAttachment(a: AttachmentInfo) {
    if (!msg) return;
    const path = await save({ defaultPath: a.name, title: t("file.saveTitle") });
    if (!path) return;
    try {
      await app.track(api.attachmentSave(msg.row.id, a.index, path));
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
      const n = await app.track(api.attachmentsSaveAll(msg.row.id, dir));
      app.toast(tn("file.savedAll", n));
    } catch (e) {
      app.fail(e);
    }
  }

  let moreOpen = $state(false);
  let moveOpen = $state(false);
  let bulkMoveOpen = $state(false);
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
    app.openCompose({
      account_id: account.id,
      draft: fromDraft(msg, { name: account.display_name, email: account.email }),
      draft_id: msg.row.id,
    });
  }

  function list(addrs: Addr[]): string {
    return addrs.map(addrFull).join(", ");
  }

  // The conversation reads top to bottom around the opened letter, as in Gmail:
  // earlier letters fold into cards above it, later ones below, the middle of a
  // long conversation into "N more".
  const at = $derived(msg ? app.conversation.findIndex((m) => m.id === msg.row.id) : -1);
  const before = $derived(at > 0 ? app.conversation.slice(0, at) : []);
  const after = $derived(at >= 0 ? app.conversation.slice(at + 1) : []);
  let showAll = $state(false);
  $effect(() => {
    void msg?.view.summary.message_id;
    showAll = false;
  });
  const folded = $derived(!showAll && before.length > 3 ? before.length - 2 : 0);

  function isMine(m: MessageRow): boolean {
    const mine = app.accounts.map((a) => a.email.toLowerCase());
    return !!m.from && mine.includes(m.from.email.toLowerCase());
  }

  function roleOf(m: MessageRow) {
    return app.folder(m.account_id, m.folder)?.role;
  }

  // Quick reply under the conversation: write without leaving it, unfold into a window when it grows.
  /** The answer being typed: built from the letter when the box opened. */
  let quick = $state<{ account_id: string; email: string; draft: ComposeDraft; all: boolean; to: number } | null>(null);
  let quickText = $state("");
  let quickBox = $state<HTMLTextAreaElement | null>(null);
  let quickBusy = $state(false);

  function openQuick(all: boolean) {
    if (!msg || !account) return;
    const me = { name: account.display_name, email: account.email };
    const draft = withSignature(reply(msg, me, all), account.signature);
    quick = { account_id: account.id, email: account.email, draft, all, to: msg.row.id };
    queueMicrotask(() => quickBox?.focus());
  }

  /** "All" in the open box: the recipients change, what was typed stays. */
  function setQuickAll(all: boolean) {
    if (!msg || !account || !quick) return;
    const me = { name: account.display_name, email: account.email };
    quick = { ...quick, all, draft: withSignature(reply(msg, me, all), account.signature) };
    quickBox?.focus();
  }

  function quickDraft(q: NonNullable<typeof quick>): ComposeDraft {
    return { ...q.draft, text: quickText.trimEnd() + q.draft.text };
  }

  /** Moves what was typed into a composition window; nothing typed is lost. */
  function quickToWindow(mode: "open" | "min" = "open") {
    if (quick) app.openCompose({ account_id: quick.account_id, draft: quickDraft(quick), draft_id: null, unsaved: true }, mode);
    quick = null;
    quickText = "";
  }

  async function quickSend() {
    const q = quick;
    if (!q || !quickText.trim() || quickBusy) return;
    const draft = quickDraft(q);
    quickBusy = true;
    try {
      const found: string[] = [];
      for (const check of registry.items("sendChecks")) {
        try {
          found.push(...check(draft, q.email));
        } catch (err) {
          console.error("send check failed:", err);
        }
      }
      found.push(...(await extensions.beforeSend(draft, q.email)));
      // Warnings are read and answered in the full window.
      if (found.length) return quickToWindow();
      await app.send(q.account_id, draft, null, null, null);
      quick = null;
      quickText = "";
    } catch (e) {
      app.fail(e);
    } finally {
      quickBusy = false;
    }
  }

  function onQuickKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      quickSend();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (quickText.trim()) quickToWindow("min");
      else quick = null;
    }
  }

  // Another letter opened with an answer half-written: it waits folded in the corner.
  $effect(() => {
    const id = msg?.row.id;
    untrack(() => {
      if (!quick || quick.to === id) return;
      if (quickText.trim()) quickToWindow("min");
      quick = null;
      quickText = "";
    });
  });
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
    </div>
  {:else if app.openError}
    <div class="center">
      <p class="danger-text">{app.openError.message}</p>
      {#if app.opened === null && app.selected.size === 1}
        <button class="btn" onclick={() => app.open([...app.selected][0])}>{t("retry")}</button>
      {/if}
    </div>
  {:else if showOpening || (app.opening && !msg)}
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
  {:else if msg}
    <div class="toolbar" data-tauri-drag-region>
      {#if isDraft}
        <button class="btn primary" onclick={editDraft}><Pencil size={15} /> {t("act.continueDraft")}</button>
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
      {#snippet card(m: MessageRow)}
        {@const pic = avatarOf(m.account_id, m.from?.email, false)}
        <button class="card" class:unread={!m.flags.seen} onclick={() => app.open(m.id)}>
          <span class="mini" class:pic style:background={pic ? null : avatarColor(m.from?.email ?? "")}>
            {#if pic}<img src={pic} alt="" />{:else}{initials(m.from)}{/if}
          </span>
          <span class="who">{isMine(m) ? t("list.me") : (m.from?.name ?? m.from?.email ?? "")}</span>
          {#if roleOf(m) === "drafts"}<span class="draft-tag">{t("conv.draft")}</span>
          {:else if roleOf(m) === "sent" && !isMine(m)}<span class="muted">· {t("conv.youReplied")}</span>{/if}
          <span class="when muted">{listDate(m.date)}</span>
        </button>
      {/snippet}

      {#if before.length}
        <div class="thread" aria-label={t("conv.label")}>
          {#if folded}
            {@render card(before[0])}
            <button class="card more" onclick={() => (showAll = true)}><span class="more-line"></span>{tn("conv.more", folded)}<span class="more-line"></span></button>
            {#each before.slice(-1) as m (m.id)}{@render card(m)}{/each}
          {:else}
            {#each before as m (m.id)}{@render card(m)}{/each}
          {/if}
        </div>
      {/if}

      <div class="head selectable">
        <h1>{msg.view.summary.subject || t("noSubject")}</h1>
        <div class="from">
          <span class="avatar" class:pic={picture} style:background={picture ? null : avatarColor(msg.view.summary.from?.email ?? "")}>
            {#if picture}<img src={picture} alt="" />{:else}{initials(msg.view.summary.from)}{/if}
          </span>
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
            {#if app.accounts.length > 1 && account}<div>{accountLabel(account)}</div>{/if}
          </div>
        </div>
      </div>

      <!-- Answering sits between the header and the letter, as in Yandex Mail; the toolbar keeps sorting. -->
      {#if !isDraft}
        <div class="acts">
          <button class="act" onclick={() => onReply(false)} title={t("act.replyHint")}><Reply size={16} /> {t("act.reply")}</button>
          {#if manyRecipients}
            <button class="act" onclick={() => onReply(true)} title={t("act.replyAllHint")}><ReplyAll size={16} /> {t("act.replyAllFull")}</button>
          {/if}
          <button class="act" onclick={onForward} title={t("act.forwardHint")}><Forward size={16} /> {t("act.forward")}</button>
        </div>
      {/if}

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
              <button class="file-name" onclick={() => openAttachment(a)} title={`${t("file.open")}: ${a.name}`}><Paperclip size={13} /><span class="fname">{a.name}</span></button>
              <span class="fsize muted">{size(a.size)}</span>
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

      {#if after.length}
        <div class="thread after" aria-label={t("conv.label")}>
          {#each after as m (m.id)}{@render card(m)}{/each}
        </div>
      {/if}

      {#if !isDraft}
        <div class="quick">
          {#if quick}
            <div class="quick-box">
              <div class="quick-to muted">
                {#if quick.all}<ReplyAll size={14} />{:else}<Reply size={14} />{/if}
                <span class="quick-who">{[...quick.draft.to, ...quick.draft.cc].map(addrFull).join(", ")}</span>
                {#if manyRecipients}
                  <button class="quick-all" class:on={quick.all} aria-pressed={quick.all} onclick={() => quick && setQuickAll(!quick.all)} title={t("act.replyAllHint")}>{t("act.replyAll")}</button>
                {/if}
              </div>
              <textarea bind:this={quickBox} bind:value={quickText} onkeydown={onQuickKey} spellcheck="true" rows="4" placeholder={t("compose.bodyPlaceholder")}></textarea>
              <div class="quick-actions">
                <button class="btn primary" onclick={quickSend} disabled={quickBusy || !quickText.trim()}>{t("compose.send")} <kbd>Ctrl+Enter</kbd></button>
                <button class="btn ghost" onclick={() => quickToWindow()}>{t("reader.toWindow")}</button>
                <span class="sep"></span>
                <button class="btn ghost icon" onclick={() => { quick = null; quickText = ""; }} title={t("compose.discardDraft")} aria-label={t("compose.discardDraft")}><Trash size={15} /></button>
              </div>
            </div>
          {:else}
            <button class="quick-bar" onclick={() => openQuick(false)}><Reply size={16} /> {t("act.reply")}</button>
          {/if}
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

  .opening {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* The same place and size as the opened message's title: nothing jumps when it arrives. */
  .opening .title {
    margin: 0 0 12px;
    font-size: 20px;
    font-weight: 650;
    line-height: 1.3;
  }

  /* An indeterminate line: work is going on, its length is unknown. */
  .progress {
    height: 2px;
    overflow: hidden;
    background: transparent;
  }

  .progress span {
    display: block;
    width: 30%;
    height: 100%;
    background: var(--accent);
    animation: slide 1.1s ease-in-out infinite;
  }

  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(340%);
    }
  }

  .skeleton {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px 22px;
  }

  .skeleton i {
    height: 10px;
    border-radius: 5px;
    background: var(--hover);
  }

  .skeleton i:nth-child(1) {
    width: 72%;
  }

  .skeleton i:nth-child(2) {
    width: 90%;
  }

  .skeleton i:nth-child(3) {
    width: 64%;
  }

  .skeleton i:nth-child(4) {
    width: 40%;
  }

  .slow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 22px;
  }

  @media (prefers-reduced-motion: reduce) {
    .progress span {
      animation-duration: 3s;
    }
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

  /* Folded letters of the conversation: one line each, the opened letter between them. */
  .thread {
    margin: 12px 22px 0;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper);
    overflow: hidden;
  }

  .thread.after {
    margin: 0 22px 12px;
  }

  .card {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 9px 12px;
    border: none;
    border-bottom: 1px solid var(--line);
    background: none;
    text-align: left;
    font-size: 13px;
  }

  .card:last-child {
    border-bottom: none;
  }

  .card:hover {
    background: var(--hover);
  }

  .card.unread .who {
    font-weight: 650;
  }

  .card .when {
    margin-left: auto;
    font-size: 12px;
  }

  .card.more {
    justify-content: center;
    color: var(--muted);
    font-size: 12px;
    padding: 6px 12px;
  }

  .more-line {
    flex: 1;
    height: 1px;
    background: var(--line);
  }

  .draft-tag {
    color: var(--accent);
    font-weight: 600;
    font-size: 12px;
  }

  .quick {
    display: flex;
    gap: 8px;
    margin: 0 22px 22px;
  }

  /* One wide bar that reads as a field: a click turns it into the answer. */
  .quick-bar {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 13px 16px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--paper);
    color: var(--muted);
    text-align: left;
  }

  .quick-bar:hover {
    color: var(--ink);
    border-color: color-mix(in srgb, var(--ink) 22%, var(--line));
  }

  /* Reply, reply all, forward: centred on a hairline between the header and the letter. */
  .acts {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    margin: 2px 22px 12px;
  }

  .acts::before,
  .acts::after {
    content: "";
    flex: 1;
    min-width: 12px;
    height: 1px;
    background: var(--line);
  }

  .act {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--ink);
    font-weight: 550;
    white-space: nowrap;
  }

  .act:hover {
    background: var(--hover);
  }

  .quick-who {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .quick-all {
    flex: none;
    padding: 2px 10px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: none;
    color: var(--muted);
    font-size: 12px;
  }

  .quick-all.on {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, var(--paper));
    color: var(--ink);
  }

  .quick-box {
    flex: 1;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--paper);
    box-shadow: 0 2px 10px rgb(0 0 0 / 6%);
  }

  .quick-to {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px 0;
    font-size: 13px;
    white-space: nowrap;
  }

  .quick-box textarea {
    border: none;
    outline: none;
    resize: vertical;
    min-height: 96px;
    padding: 10px 14px;
    background: transparent;
    line-height: 1.55;
    user-select: text;
  }

  .quick-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px 10px 14px;
  }

  .quick-actions kbd {
    border-color: rgb(255 255 255 / 40%);
    color: var(--accent-ink);
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

  /* A photo or a logo fills the circle; logos are drawn for a white ground. */
  .mini.pic,
  .avatar.pic {
    background: #fff;
    overflow: hidden;
    box-shadow: inset 0 0 0 1px var(--line);
  }

  .pic img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
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
