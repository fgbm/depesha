<script lang="ts">
  import ImageOff from "@lucide/svelte/icons/image-off";
  import Puzzle from "@lucide/svelte/icons/puzzle";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import { layout } from "../lib/layout.svelte";
  import { viewTitle } from "../lib/titles";
  import { app } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { t, tn } from "../lib/i18n.svelte";
  import { extensions, fromRow } from "../lib/extensions.svelte";
  import { registry } from "../plugin-host/registry.svelte";
  import type { Banner as PluginBanner } from "../plugin-api";
  import Viewer from "./Viewer.svelte";
  import PluginBannerView from "./PluginBanner.svelte";
  import { avatarOf } from "../lib/avatars.svelte";
  import ReaderHeader from "./reader/ReaderHeader.svelte";
  import ReaderToolbar from "./reader/ReaderToolbar.svelte";
  import ReaderBody from "./reader/ReaderBody.svelte";
  import ReaderStates from "./reader/ReaderStates.svelte";
  import Conversation from "./reader/Conversation.svelte";
  import QuickReply from "./reader/QuickReply.svelte";
  import ReplyActions from "./reader/ReplyActions.svelte";
  import { useQuickReply } from "./reader/useQuickReply.svelte";
  import { useAttachmentViewer } from "./reader/useAttachmentViewer.svelte";

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
  const isDraft = $derived(msg ? app.folder(msg.row.account_id, msg.row.folder)?.role === "drafts" : false);
  const showRemoteBanner = $derived(!!msg && msg.view.has_remote_content && !app.allowRemote && !msg.trusted_sender);
  const bulk = $derived(app.selected.size > 1);
  /** The letter with its toolbar is on screen, not a placeholder or an error. */
  const showsLetter = $derived(!bulk && !app.openError && !showOpening && !(app.opening && !msg) && !!msg);
  /** Which state the pane shows when there is no letter: none of them is the letter. */
  const stateToShow = $derived.by((): "bulk" | "error" | "opening" | "placeholder" | null => {
    if (bulk) return "bulk";
    if (app.openError) return "error";
    if (showOpening || (app.opening && !msg)) return "opening";
    if (!msg) return "placeholder";
    return null;
  });

  /** The attachment viewer of the reading pane (#23): it takes the letter's place. */
  const viewer = useAttachmentViewer({
    savedTo: (name, dir) => app.toast(t("file.savedTo", { name, dir })),
    saveInFailed: (message, again) => app.toast(message, true, { label: t("file.saveAs"), run: again }),
    saved: (name) => app.toast(t("file.saved", { name })),
    savedAll: (n) => app.toast(tn("file.savedAll", n)),
    saveTitle: () => t("file.saveTitle"),
    saveAllTitle: () => t("file.saveAllTitle"),
  });
  const viewing = $derived(viewer.viewingId !== null);
  const files = $derived(viewer.files);

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
    await api.trustSender(email).catch((e) => app.fail(e));
    app.open(msg.row.id, true);
  }

  // The conversation reads top to bottom around the opened letter, as in Gmail:
  // earlier letters fold into cards above it, later ones below, the middle of
  // each long side into its own "N more".
  const at = $derived(msg ? app.conversation.findIndex((m) => m.id === msg.row.id) : -1);
  const before = $derived(at > 0 ? app.conversation.slice(0, at) : []);
  const after = $derived(at >= 0 ? app.conversation.slice(at + 1) : []);
  let showAll = $state(false);
  let showAllAfter = $state(false);
  $effect(() => {
    void msg?.view.summary.message_id;
    showAll = false;
    showAllAfter = false;
  });
  const folded = $derived(!showAll && before.length > 3 ? before.length - 2 : 0);
  const foldedAfter = $derived(!showAllAfter && after.length > 3 ? after.length - 2 : 0);

  // Quick reply under the conversation: write without leaving it, unfold into a window when it grows.
  const quick = useQuickReply({
    keptAsDraft: (open) => app.toast(t("reader.quickKept"), false, { label: t("file.open"), run: open }),
  });
</script>

<!-- A narrow window shows the letter instead of the list: the way back and to the neighbours. -->
{#snippet nav()}
  {#if layout.single && app.windowOf === null}
    {@const list = viewTitle(app.view)}
    <button class="btn back" onclick={() => layout.showList()} title={t("nav.backHint", { list })} aria-label={t("nav.back", { list })}>
      <ChevronLeft size={16} /><span class="back-lbl">{list}</span>
    </button>
    <button class="btn ghost icon" onclick={() => app.move(-1)} title={t("nav.prevHint")} aria-label={t("nav.prev")}><ChevronUp size={16} /></button>
    <button class="btn ghost icon" onclick={() => app.move(1)} title={t("nav.nextHint")} aria-label={t("nav.next")}><ChevronDown size={16} /></button>
  {/if}
{/snippet}

<section class="reader">
  {#if layout.single && app.windowOf === null && !showsLetter}
    <div class="toolbar compact" data-tauri-drag-region>{@render nav()}</div>
  {/if}
  {#if stateToShow}
    <ReaderStates which={stateToShow} waited={waited} />
  {:else if msg}
    <ReaderToolbar {msg} {account} {isDraft} {message} {nav} />

    <div class="scroll" class:viewing bind:this={viewer.scrollBox}>
      {#if before.length && !viewing}
        <div class="thread" aria-label={t("conv.label")}>
          <Conversation messages={before} folded={folded} onShowAll={() => (showAll = true)} />
        </div>
      {/if}

      <ReaderHeader
        {msg}
        {picture}
        {account}
        {files}
        {viewing}
        viewingAt={viewer.at}
        onViewAttachment={(a) => viewer.viewAttachment(a)}
        onSaveAttachment={(a) => viewer.saveAttachment(a)}
        onSaveAttachmentAs={(a) => viewer.saveAttachmentAs(a)}
        onSaveAll={() => viewer.saveAll()}
        saveDir={viewer.saveDir}
      >
        {#snippet headerActions()}
          {#each registry.lists.readerHeader as h (h)}<h.item.component {...h.item.props ?? {}} />{/each}
        {/snippet}
      </ReaderHeader>

      <ReplyActions manyRecipients={quick.manyRecipients} reply={onReply} forward={onForward} />

      {#each banners as b (b.ext)}
        <div class="banner ext-banner" class:info={b.tone === "info"} data-ext={b.ext}>
          <Puzzle size={15} />
          <span><b>{b.name}:</b> {b.text}</span>
          {#each b.actions as a (a.id)}<button class="btn ghost" onclick={() => bannerAction(b.ext, a.id)}>{a.title}</button>{/each}
        </div>
      {/each}
      {#each pluginBanners as b, i (i)}<PluginBannerView banner={b} />{/each}
      <!-- A quiet line, not a warning: hidden images are the normal state. -->
      {#if showRemoteBanner}
        <div class="remote" title={t("reader.remoteWhy")}>
          <ImageOff size={14} />
          <span>{t("reader.remoteHidden")}</span>
          <button class="link" onclick={() => app.open(msg.row.id, true)}>{t("reader.show")}</button>
          {#if msg.view.summary.from}
            <span aria-hidden="true">·</span>
            {#if msg.sender_unverified}
              <!-- Anyone can write a trusted address into From: the trust waits for a confirmed sender. -->
              <span>{t("reader.unverifiedSender", { email: msg.view.summary.from.email })}</span>
            {:else}
              <button class="link" onclick={trustSender}>{t("reader.alwaysFor", { email: msg.view.summary.from.email })}</button>
            {/if}
          {/if}
        </div>
      {/if}

      {#if viewing && files.length}
        <Viewer id={msg.row.id} {files} bind:at={viewer.at} onClose={() => viewer.closeViewer()} onSave={(a) => viewer.saveAttachment(a)} onOpenApp={(a) => viewer.openAttachment(a)} />
      {/if}

      <ReaderBody {msg} {account} {viewing} />

      {#if after.length && !viewing}
        <div class="thread after" aria-label={t("conv.label")}>
          <Conversation messages={after} folded={foldedAfter} onShowAll={() => (showAllAfter = true)} />
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

  /* Folded letters of the conversation: one line each, the opened letter between them.
     Never shrinks: with overflow hidden a long letter would squeeze it to its border. */
  .thread {
    flex: none;
    margin: 12px 22px 0;
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
    overflow: hidden;
  }
</style>
