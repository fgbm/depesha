<script lang="ts">
  import ImageOff from "@lucide/svelte/icons/image-off";
  import Info from "@lucide/svelte/icons/info";
  import Puzzle from "@lucide/svelte/icons/puzzle";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import { layout } from "../lib/layout.svelte";
  import { viewTitle } from "../lib/titles";
  import { app } from "../lib/store.svelte";
  import { boxName as boxInLine, unverifiedKey, unverifiedTip } from "../lib/reader.svelte";
  import { api } from "../lib/api";
  import { t, tn } from "../lib/i18n.svelte";
  import { shortcuts } from "../lib/shortcuts.svelte";
  import { extensions, fromRow } from "../lib/extensions.svelte";
  import { registry } from "../plugin-host/registry.svelte";
  import type { Banner as PluginBanner } from "../plugin-api";
  import Viewer from "./Viewer.svelte";
  import PluginBannerView from "./PluginBanner.svelte";
  import { avatarOf } from "../lib/avatars.svelte";
  import { mayAskLogo } from "../lib/listAvatar";
  import ReaderHeader from "./reader/ReaderHeader.svelte";
  import ReaderToolbar from "./reader/ReaderToolbar.svelte";
  import ReaderBody from "./reader/ReaderBody.svelte";
  import ReaderStates from "./reader/ReaderStates.svelte";
  import Conversation from "./reader/Conversation.svelte";
  import MeetingCard from "./reader/MeetingCard.svelte";
  import QuickReply from "./reader/QuickReply.svelte";
  import ReplyActions from "./reader/ReplyActions.svelte";
  import { useQuickReply } from "./reader/useQuickReply.svelte";
  import { peopleBook } from "../lib/peopleBook.svelte";
  import { hints } from "../lib/hints.svelte";
  import { useAttachmentViewer } from "./reader/useAttachmentViewer.svelte";

  let { onReply, onForward }: { onReply: (all: boolean) => void; onForward: () => void } = $props();

  const msg = $derived(app.reader.opened);
  /** The sender's photo from Exchange, or a brand logo when the message passed DMARC. */
  const picture = $derived(
    msg ? avatarOf(
        msg.row.account_id,
        msg.view.summary.from?.email,
        msg.view.authenticated && app.settingsCtl.settings.sender_logos && mayAskLogo(app.mailboxes.folder(msg.row.account_id, msg.row.folder)?.role)
          ? msg.row.id
          : null,
      ) : null,
  );

  /**
   * Opening another message: after a blink (cached mail opens faster than that) its
   * header from the list shows at once with a progress line; a slow server is said so.
   */
  let waited = $state<0 | 1 | 2 | 3>(0);
  $effect(() => {
    if (!app.reader.opening) {
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
  const showOpening = $derived(app.reader.opening && waited > 0 && (!msg || app.reader.openingRow?.id !== msg.row.id));
  const account = $derived(msg ? app.mailboxes.account(msg.row.account_id) : undefined);
  /** The name of the mailbox the letter came to: the line names it (0.8.13). */
  const boxName = $derived(
    account ? t("reader.boxName", { name: boxInLine(account.label, account.email) }) : "",
  );
  const isDraft = $derived(msg ? app.mailboxes.folder(msg.row.account_id, msg.row.folder)?.role === "drafts" : false);
  const showRemoteBanner = $derived(!!msg && msg.view.has_remote_content && !app.reader.allowRemote && !msg.trusted_sender);
  /** The mailbox trusts the sender by address where nothing could be checked: the pictures are
   *  shown, and the line says the address is not checked (0.8.13, 6.1 Б). */
  const showByAddressLine = $derived(!!msg && !!msg.why_unverified?.startsWith("address_only") && !msg.sender_unverified);
  const bulk = $derived(app.selection.selected.size > 1);
  /** The letter with its toolbar is on screen: the panel above asks app.reader for the same,
   *  and a narrow window keeps its own compact toolbar when it is not. */
  const showsLetter = $derived(!bulk && app.reader.showsLetter && !showOpening);
  /** The unified action panel carries the letter's toolbar (decision 1.1 В): in the main
   *  window's wide and medium layout; a narrow window keeps its own (1.5 А), and a letter in a
   *  window of its own has no panel at all — its own toolbar stays. */
  const toolbarInBar = $derived(app.windowOf === null && !layout.single && app.selection.selected.size <= 1 && !!msg);
  /** Which state the pane shows when there is no letter: none of them is the letter. Several
   *  chosen rows in the main window are the bare count — the panel above holds the actions (1.4 Б). */
  const stateToShow = $derived.by((): "bare" | "bulk" | "error" | "opening" | "placeholder" | null => {
    if (bulk) return app.windowOf === null && !layout.single ? "bare" : "bulk";
    if (app.reader.openError) return "error";
    if (showOpening || (app.reader.opening && !msg)) return "opening";
    if (!msg) return "placeholder";
    return null;
  });

  /** The attachment viewer of the reading pane (#23): it takes the letter's place. */
  const viewer = useAttachmentViewer({
    savedTo: (name, dir) => app.ui.toast(t("file.savedTo", { name, dir })),
    saveInFailed: (message, again) => app.ui.toast(message, true, { label: t("file.saveAs"), run: again }),
    saved: (name) => app.ui.toast(t("file.saved", { name })),
    savedAll: (n) => app.ui.toast(tn("file.savedAll", n)),
    saveTitle: () => t("file.saveTitle"),
    saveAllTitle: () => t("file.saveAllTitle"),
  });
  const viewing = $derived(viewer.viewingId !== null);
  const files = $derived(viewer.files);
  /** The meeting invitation of the letter (0.8.13): a card in place of the `.ics` chip, whose
   *  actions the card carries. A file that did not read keeps its chip and says why in the card. */
  const meeting = $derived(msg?.view.calendar ?? null);
  const meetingFile = $derived(
    meeting?.file !== null && meeting?.file !== undefined ? files.find((f) => f.index === meeting.file) : undefined,
  );
  const stripFiles = $derived(meetingFile && !meeting?.problem ? files.filter((f) => f !== meetingFile) : files);

  const banners = $derived(msg ? extensions.banners.filter((b) => b.messageId === msg.row.id) : []);
  const pluginBanners = $derived(msg ? registry.collect<PluginBanner, typeof msg>("banners", msg) : []);
  const message = $derived(msg ? fromRow(msg.row, account?.email ?? "", msg.view.text) : null);

  function bannerAction(extId: string, actionId: string) {
    const ext = extensions.enabled().find((e) => e.id === extId);
    if (ext) extensions.command(ext, actionId, message);
  }

  async function trustSender() {
    const email = msg?.view.summary.from?.email;
    if (!email || !msg) return;
    await api.trustSender(email).catch((e) => app.ui.fail(e));
    app.reader.open(msg.row.id, true);
  }

  // The conversation reads top to bottom around the open letter (0.8.4, #180): the letter the
  // list opened is the one unfolded, earlier letters are folded rows above it, later ones below.
  // Each side keeps the letters nearest it and folds its far end — the earliest above, the latest below — into «Ещё N писем».
  const at = $derived(msg ? app.reader.conversation.findIndex((m) => m.id === msg.row.id) : -1);
  const before = $derived(at > 0 ? app.reader.conversation.slice(0, at) : []);
  const after = $derived(at >= 0 ? app.reader.conversation.slice(at + 1) : []);
  // The folds close again when another letter opens (not when the same one is loaded again).
  const letterId = $derived(msg?.row.id);
  let showAll = $derived.by(() => (void letterId, false));
  let showAllAfter = $derived.by(() => (void letterId, false));
  const folded = $derived(!showAll && before.length > 3 ? before.length - 2 : 0);
  const foldedAfter = $derived(!showAllAfter && after.length > 3 ? after.length - 2 : 0);

  // Quick reply under the conversation: write without leaving it, unfold into a window when it grows.
  const quick = useQuickReply({
    keptAsDraft: (open) => app.ui.toast(t("reader.quickKept"), false, open ? { label: t("file.open"), run: open } : undefined),
  });

  /** A reply to a letter with a Markdown part, from a person without a rule (#69, frame 14А):
   *  the hint «answer in Markdown?» is offered in the compose window the reply opens. */
  function reply(all: boolean) {
    const m = msg;
    const sender = m?.view.summary.from;
    if (m?.view.markdown && sender?.email && !peopleBook.find(sender.email)?.send_format) {
      void hints.offerReply(sender.email, sender.name?.trim() || sender.email, true);
    }
    onReply(all);
  }
</script>

<!-- A narrow window shows the letter instead of the list: the way back and to the neighbours. -->
{#snippet nav()}
  {#if layout.single && app.windowOf === null}
    {@const list = viewTitle(app.list.view)}
    <button class="btn back" onclick={() => layout.showList()} title={t("nav.backHint", { list })} aria-label={t("nav.back", { list })}>
      <ChevronLeft size={16} /><span class="back-lbl">{list}</span>
    </button>
    <button class="btn ghost icon" onclick={() => app.selection.move(-1)} title={shortcuts.titled(t("nav.prevHint"), "core.prev")} aria-label={t("nav.prev")}><ChevronUp size={16} /></button>
    <button class="btn ghost icon" onclick={() => app.selection.move(1)} title={shortcuts.titled(t("nav.nextHint"), "core.next")} aria-label={t("nav.next")}><ChevronDown size={16} /></button>
  {/if}
{/snippet}

<section class="reader">
  {#if layout.single && app.windowOf === null && stateToShow}
    <div class="toolbar compact" data-tauri-drag-region>{@render nav()}</div>
  {/if}
  {#if stateToShow}
    <ReaderStates which={stateToShow} waited={waited} />
  {:else if msg}
    {#if !toolbarInBar}<ReaderToolbar {msg} {account} {isDraft} {message} {nav} inactive={!showsLetter} />{/if}

    <div class="scroll" class:viewing bind:this={viewer.scrollBox}>
      <!-- The subject of the conversation stands once, above all its letters (4.5): a letter of
           the thread carries no heading of its own. -->
      <h1 class="subject selectable">{msg.view.summary.subject || t("noSubject")}</h1>
      {#if before.length && !viewing}
        <div class="thread" aria-label={t("conv.label")}>
          <Conversation messages={before} folded={folded} onShowAll={() => (showAll = true)} focusId={msg.row.id} onReply={reply} onForward={onForward} />
        </div>
      {/if}

      <ReaderHeader
        {msg}
        {picture}
        {account}
        files={stripFiles}
        {viewing}
        viewingAt={viewer.at}
        onViewAttachment={(a) => viewer.viewAttachment(a)}
        onSaveAttachment={(a) => viewer.saveAttachment(a)}
        onSaveAttachmentAs={(a) => viewer.saveAttachmentAs(a)}
        onForwardAttachment={(a) => app.compose.forwardAttachmentsOpened(a)}
        onSaveAll={() => viewer.saveAll()}
        saveDir={viewer.saveDir}
      >
        {#snippet headerActions()}
          {#each registry.lists.readerHeader as h (h)}<h.item.component {...h.item.props ?? {}} />{/each}
        {/snippet}
      </ReaderHeader>

      {#if meeting && !viewing}
        <MeetingCard
          notice={meeting}
          attachment={meetingFile}
          onAdd={(a) => viewer.openAttachment(a)}
          onSave={(a) => viewer.saveAttachment(a)}
          onOpenAsText={(a) => viewer.viewAttachment(a)}
        />
      {/if}

      <ReplyActions manyRecipients={quick.manyRecipients} reply={reply} forward={onForward} />

      {#each banners as b (b.ext)}
        <div class="banner ext-banner" class:info={b.tone === "info"} data-ext={b.ext}>
          <Puzzle size={15} />
          <span><b>{b.name}:</b> {b.text}</span>
          {#each b.actions as a (a.id)}<button class="btn ghost" onclick={() => bannerAction(b.ext, a.id)}>{a.title}</button>{/each}
        </div>
      {/each}
      {#each pluginBanners as b, i (i)}<PluginBannerView banner={b} />{/each}
      <!-- The address alone was trusted: the pictures are shown, and the line says so. -->
      {#if showByAddressLine}
        <div class="remote">
          <Info size={14} />
          <span>{t("reader.addressNotChecked")}</span>
        </div>
      {/if}
      <!-- A quiet line, not a warning: hidden images are the normal state. -->
      {#if showRemoteBanner}
        <div class="remote" title={t("reader.remoteWhy")}>
          <ImageOff size={14} />
          <span>{t("reader.remoteHidden")}</span>
          <button class="link" onclick={() => app.reader.open(msg.row.id, true)}>{t("reader.show")}</button>
          {#if msg.view.summary.from}
            <span aria-hidden="true">·</span>
            {#if msg.sender_unverified}
              <!-- Anyone can write a trusted address into From: the trust waits for a confirmed sender. -->
              <span
                class="tip"
                title={unverifiedTip(msg.why_unverified, msg.server_checks_sender)
                  ? t(unverifiedTip(msg.why_unverified, msg.server_checks_sender)!)
                  : undefined}
              >{t(unverifiedKey(msg.why_unverified), { email: msg.view.summary.from.email, box: boxName })}</span>
            {:else}
              <button class="link" onclick={trustSender}>{t("reader.alwaysFor", { email: msg.view.summary.from.email })}</button>
            {/if}
          {/if}
        </div>
      {/if}

      {#if viewing && files.length}
        <Viewer id={msg.row.id} {files} bind:at={viewer.at} onClose={() => viewer.closeViewer()} onSave={(a) => viewer.saveAttachment(a)} onOpenApp={(a) => viewer.openAttachment(a)} />
      {/if}

      <ReaderBody {msg} {viewing} />

      {#if after.length && !viewing}
        <div class="thread after" aria-label={t("conv.label")}>
          <Conversation messages={after} folded={foldedAfter} foldAt="bottom" onShowAll={() => (showAllAfter = true)} focusId={msg.row.id} onReply={reply} onForward={onForward} />
        </div>
      {/if}
    </div>

    <!-- Outside the scroll: the answer stays at the bottom of the pane while the letter scrolls. -->
    {#if !isDraft && !viewing}
      <QuickReply state={quick} manyRecipients={quick.manyRecipients} />
    {/if}
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

  .scroll {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  /* The subject of the conversation, once, above its letters (4.5). */
  .subject {
    margin: 0;
    padding: 4px 22px 12px;
    font-size: 20px;
    font-weight: 650;
    line-height: 1.3;
  }

  /* Folded letters of the conversation: one line each, the opened letter between them.
     Never shrinks: with overflow hidden a long letter would squeeze it to its border. */
  .thread {
    flex: none;
    margin: 4px 22px 0;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper);
    overflow: hidden;
  }

  .thread.after {
    margin: 0 22px 12px;
  }

  /* The list's name, as much of it as fits: the button gives way before the actions wrap. */
  .back {
    /* Grows first, up to its whole name; the spacer takes the rest. */
    flex: 100 1 36px;
    min-width: 36px;
    max-width: max-content;
    overflow: hidden;
  }

  .back :global(svg) {
    flex: none;
  }

  .back-lbl {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .banner.info {
    background: color-mix(in srgb, var(--link) 9%, var(--paper));
    border-color: color-mix(in srgb, var(--link) 28%, var(--paper));
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
  /* The detail of the line is under the dotted bottom: the line itself stays short. */
  .remote .tip {
    border-bottom: 1px dotted var(--muted);
    cursor: help;
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


  /* An attachment in place of the text: the header and the attachments stay, the viewer takes the rest. */
  .scroll.viewing {
    overflow-x: hidden;
  }
</style>
