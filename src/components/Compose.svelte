<script lang="ts">
  import { tick, untrack } from "svelte";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Minus from "@lucide/svelte/icons/minus";
  import Maximize from "@lucide/svelte/icons/maximize-2";
  import Minimize from "@lucide/svelte/icons/minimize-2";
  import X from "@lucide/svelte/icons/x";
  import Trash from "@lucide/svelte/icons/trash-2";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import Check from "@lucide/svelte/icons/check";
  import Type from "@lucide/svelte/icons/type";
  import Hash from "@lucide/svelte/icons/hash";
  import AlignLeft from "@lucide/svelte/icons/align-left";
  import Clock from "@lucide/svelte/icons/clock";
  import ImageIcon from "@lucide/svelte/icons/image";
  import CornerUpLeft from "@lucide/svelte/icons/corner-up-left";
  import { app, type ComposeWindow } from "../lib/store.svelte";
  import { SIGNATURE_CLASS } from "../lib/richtext";
  import { signatureShown } from "../lib/signatures";
  import { cleanRemoteHtml } from "../lib/sanitize";
  import { accountLabel, listDate, shortDateTime, size } from "../lib/format";
  import { t } from "../lib/i18n.svelte";
  import type { BodyFormat, Signature } from "../lib/types";
  import type { MarkdownField } from "../lib/markdown/types";
  import RichEditor from "./RichEditor.svelte";
  import SignaturePicker from "./SignaturePicker.svelte";
  import FormatBar from "./FormatBar.svelte";
  import MarkdownEditor from "./MarkdownEditor.svelte";
  import MarkdownPartsNote from "./MarkdownPartsNote.svelte";
  import RecipientRule from "./RecipientRule.svelte";
  import HintLine from "./HintLine.svelte";
  import PersonCard from "./reader/PersonCard.svelte";
  import { peopleBook } from "../lib/peopleBook.svelte";
  import { hints } from "../lib/hints.svelte";
  import type { Hint } from "../lib/hints";
  import AddressInput from "./AddressInput.svelte";
  import Popover from "./Popover.svelte";
  import AttachmentMenu from "./AttachmentMenu.svelte";
  import { shortcuts } from "../lib/shortcuts.svelte";
  import { pasteKey } from "../lib/platform";
  import { ComposeFormat } from "../lib/compose/format.svelte";
  import { ComposeAutosave } from "../lib/compose/autosave.svelte";
  import { ComposeSending } from "../lib/compose/sending.svelte";
  import { ComposeAttachments } from "../lib/compose/attachments.svelte";
  import { FULL_STRIP_ROWS, MIN_BODY_PX, mailboxName, visibleChips } from "../lib/compose/layout";
  import type { WindowPart } from "../lib/compose/sending.svelte";

  let { c }: { c: ComposeWindow } = $props();
  // The window's own state, which the markup binds; the letter's logic lives in
  // src/lib/compose/ (format, attachments, autosave, sending). A window keeps its
  // composition for life (keyed by id in App.svelte).
  let error = $state("");
  // Cc and Bcc are folded while empty; a draft that has them shows them (#103, 1.2 А, 1.3 А).
  let showCc = $state(untrack(() => c.draft.cc.length > 0));
  let showBcc = $state(untrack(() => c.draft.bcc.length > 0));
  let toInput = $state<AddressInput | null>(null);
  let bodyFrame = $state<HTMLDivElement | null>(null);
  let ccInput = $state<AddressInput | null>(null);
  let bccInput = $state<AddressInput | null>(null);
  /** The window's width: the formatting row folds in a narrow one. */
  let width = $state(640);
  /** The format button's menu; the draft's actions keep their own "⋯" beside it. */
  let menuOpen = $state(false);
  let moreOpen = $state(false);
  /** The «From» menu of the title and the attachments' list (#103). */
  let fromOpen = $state(false);
  let filesOpen = $state(false);

  /** The format as the button's label shows it. */
  function formatLabel(format: BodyFormat): string {
    return format === "html" ? t("format.short.html") : format === "markdown" ? t("format.short.markdown") : t("format.plain");
  }

  function commitAll(): boolean {
    const ok = [toInput, ccInput, bccInput].map((i) => i?.commit() ?? true);
    return ok.every(Boolean);
  }

  const fmt = new ComposeFormat({
    get win() {
      return c;
    },
    get windowOf() {
      return app.windowOf;
    },
    account: (id) => app.account(id),
    openSettings: (page, section) => app.openSettings(page, section),
    fail: (e, prefix) => app.fail(e, prefix),
    confirmToPlain: () =>
      app.confirm({
        title: t("compose.format.toPlainTitle"),
        text: t("compose.format.loseHtml"),
        okLabel: t("compose.format.toPlain"),
        cancelLabel: t("compose.format.stayHtml"),
      }),
    formatChanged: (from, to, undo) => {
      const name = (f: BodyFormat) => (f === "html" ? t("format.short.html") : f === "markdown" ? t("format.short.markdown") : t("format.plain"));
      app.toast(t("compose.format.changed", { format: name(to) }), false, { label: t("undo"), run: undo });
    },
  });

  const auto = new ComposeAutosave({
    get win() {
      return c;
    },
    setError: (m) => (error = m),
    clearError: () => (error = ""),
    draftNotSaved: (err) => t("compose.draftNotSaved", { error: err }),
  });

  // A quit or a closing window saves this draft through the manager, before it goes (#71).
  $effect(() => {
    const save = () => auto.save(true);
    app.compose.onSaver(c.id, save);
    return () => app.compose.onSaver(c.id, null);
  });

  const sending = new ComposeSending({
    get win() {
      return c;
    },
    format: fmt,
    autosave: auto,
    account: (id) => app.account(id),
    accountColor: (id) => app.accountColor(id),
    fail: (e, prefix) => app.fail(e, prefix),
    toast: (text) => app.toast(text),
    sendApp: (a, d, id, mid, at, secs, f) => {
      // The detector of #69 counts a Markdown letter sent to a person without a rule.
      void hints.recordSend(d);
      return app.send(a, d, id, mid, at, secs, f);
    },
    closeCompose: (id) => app.closeCompose(id),
    showCompose: (id, mode) => app.showCompose(id, mode),
    commitAll,
    setError: (m) => (error = m),
    clearError: () => (error = ""),
    badAddresses: () => t("compose.badAddresses"),
    noRecipients: () => t("compose.noRecipients"),
    draftSaved: () => t("compose.draftSaved"),
    confirmClose: () => app.confirm({ text: t("compose.closeAnyway"), okLabel: t("close"), cancelLabel: t("compose.goBack"), danger: true }),
    confirmDiscard: () => app.confirm({ text: t("compose.discardConfirm"), okLabel: t("act.delete"), danger: true }),
    openPart: (part) => void openPart(part),
  });

  const files = new ComposeAttachments({
    get win() {
      return c;
    },
    format: fmt,
    fail: (e, prefix) => app.fail(e, prefix),
    toastBig: (name) => app.toast(t("compose.picture.attachedBig", { name })),
    useCtrlV: () => app.toast(t("compose.picture.useCtrlV", { key: pasteKey() })),
    noneInClipboard: () => app.toast(t("compose.picture.noneInClipboard")),
    pickTitle: () => t("compose.picture.pickTitle"),
    attachTitle: () => t("compose.attachTitle"),
    get dragging() {
      return app.compose.dragging;
    },
    activeComposeId: () => app.activeCompose()?.id,
    pictureTarget: (id, insert) => app.compose.pictureTarget(id, insert),
    imageMaxPx: () => app.settings.image_max_px,
  });

  // What the markup reads and writes: the window's own state, the letter's (fmt) and the
  // controllers' — one name for each, as the markup always had.
  const m = {
    get width() { return width; },
    set width(v: number) { width = v; },
    get error() { return error; },
    get showCc() { return showCc; },
    set showCc(v: boolean) { showCc = v; },
    get showBcc() { return showBcc; },
    set showBcc(v: boolean) { showBcc = v; },
    get toInput() { return toInput; },
    set toInput(v: AddressInput | null) { toInput = v; },
    get ccInput() { return ccInput; },
    set ccInput(v: AddressInput | null) { ccInput = v; },
    get bccInput() { return bccInput; },
    set bccInput(v: AddressInput | null) { bccInput = v; },
    get rich() { return fmt.rich; },
    set rich(v: RichEditor | null) { fmt.rich = v; },
    get bar() { return fmt.bar; },
    set bar(v: FormatBar | null) { fmt.bar = v; },
    get body() { return fmt.body; },
    set body(v: HTMLTextAreaElement | MarkdownField | null) { fmt.body = v; },
    get areaWidth() { return fmt.areaWidth; },
    set areaWidth(v: number) { fmt.areaWidth = v; },
    get head() { return fmt.head; },
    set head(v: string) { fmt.head = v; },
    get htmlBody() { return fmt.htmlBody; },
    set htmlBody(v: string) { fmt.htmlBody = v; },
    get quote() { return fmt.quote; },
    set quote(v: string) { fmt.quote = v; },
    get quoteOpen() { return fmt.quoteOpen; },
    set quoteOpen(v: boolean) { fmt.quoteOpen = v; },
    get markup() { return fmt.markup; },
    set markup(v: boolean) { fmt.markup = v; },
    get format() { return fmt.format; },
    get switching() { return fmt.switching; },
    get signature() { return fmt.signature; },
    get signatureView() { return signatureShown(fmt.format, fmt.signature); },
    get signatures() { return fmt.signatures; },
    get quoteHeader() { return fmt.quoteHeader; },
    get signatureSettings() { return fmt.signatureSettings; },
    get textPictures() { return fmt.textPictures; },
    get total() { return c.draft.attachments.reduce((n, a) => n + a.size, 0) + fmt.pictures; },
    get zones() { return files.zones; },
    get savedText() { return c.savedAt ? t("compose.savedAt", { time: listDate(Math.floor(c.savedAt / 1000)) }) : ""; },
    get savingNow() { return auto.savingNow; },
    get busy() { return sending.busy; },
    get warnings() { return sending.warnings; },
    set warnings(v: string[] | null) { sending.warnings = v; },
    get pendingAt() { return sending.pendingAt; },
    get options() { return sending.options; },
    get controls() { return sending.controls; },
    get FORMATS() { return FORMATS; },
    putSignature: (sig: Signature | null) => fmt.putSignature(sig),
    setAccount: (id: string) => fmt.setAccount(id),
    setFormat: (next: BodyFormat) => fmt.setFormat(next),
    onBodyFocus: () => fmt.onBodyFocus(),
    onKey: (e: KeyboardEvent) => sending.onKey(e),
    close: () => sending.close(),
    discard: () => sending.discard(),
    saveDraft: () => sending.saveDraft(),
    get important() { return c.draft.importance === "high"; },
    toggleImportance: () => sending.toggleImportance(),
    get menuOpen() { return menuOpen; },
    set menuOpen(v: boolean) { menuOpen = v; },
    get moreOpen() { return moreOpen; },
    set moreOpen(v: boolean) { moreOpen = v; },
    get fromOpen() { return fromOpen; },
    set fromOpen(v: boolean) { fromOpen = v; },
    get filesOpen() { return filesOpen; },
    set filesOpen(v: boolean) { filesOpen = v; },
    minimize: () => sending.minimize(),
    toggleMax: () => sending.toggleMax(),
    send: (at: number | null = null, force = false) => sending.send(at, force),
    pictureFromFile: () => files.pictureFromFile(),
    pictureFromClipboard: () => files.pictureFromClipboard(),
    pastedPictures: (blobs: Blob[]) => files.pastedPictures(blobs),
    attach: () => files.attach(),
  };

  const FORMATS: { value: BodyFormat; label: () => string }[] = [
    { value: "plain", label: () => t("format.plain") },
    { value: "html", label: () => t("format.short.html") },
    { value: "markdown", label: () => t("format.short.markdown") },
  ];

  peopleBook.load();

  /** Alt+C and Alt+B: open the field and stand in it; an empty one with the caret in it folds again. */
  async function openCopyField(cc: boolean) {
    const shown = cc ? showCc : showBcc;
    const list = cc ? c.draft.cc : c.draft.bcc;
    const field = cc ? ccInput : bccInput;
    // The caret goes back to «To», not to nowhere; from anywhere else the key takes it to the field.
    if (shown && list.length === 0 && field && !field.hasText() && field.hasFocus()) {
      if (cc) showCc = false;
      else showBcc = false;
      await tick();
      toInput?.focus();
      return;
    }
    if (cc) showCc = true;
    else showBcc = true;
    await tick();
    (cc ? ccInput : bccInput)?.focus();
  }

  /** The window's Alt keys (#103, 4.1 А): open the field or the menu, or close it again. */
  async function openPart(part: WindowPart) {
    if (c.mode === "min") return;
    if (part === "cc" || part === "bcc") {
      await openCopyField(part === "cc");
    } else if (part === "from") {
      if (app.accounts.length > 1) fromOpen = !fromOpen;
    } else if (part === "files") {
      if (c.draft.attachments.length) filesOpen = !filesOpen;
      else void files.attach();
    } else if (part === "quote") {
      if (fmt.format !== "html" && fmt.quote) fmt.quoteOpen = !fmt.quoteOpen;
    } else if (part === "format") {
      if (!sending.busy) menuOpen = !menuOpen;
    } else if (!sending.busy) {
      moreOpen = !moreOpen;
    }
  }

  const fromAccount = $derived(app.account(c.account_id));
  const fromFull = $derived(fromAccount ? (fromAccount.display_name ? `${fromAccount.display_name} <${fromAccount.email}>` : fromAccount.email) : "");
  const hasQuote = $derived(fmt.format !== "html" && !!fmt.quote);
  /** Whether a plugin has a control for the line of state (the wait's box and reminder). */
  const hasState = $derived(sending.controls.some((x) => x.slot === "line"));

  // The mailboxes' list opens on the mailbox the letter is from, so that the arrows go on from it
  // (#103, Alt+M). A frame later: the list takes no focus while it is not yet shown.
  $effect(() => {
    if (!fromOpen) return;
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-compose="${c.id}"] header [role="menuitemradio"][aria-checked="true"]`)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  });

  // Files dragged over the letter offer their zones in the text area: in a low window it may be
  // scrolled out of sight under the strips, and a drop target must be where the pointer can reach it.
  // Once the zones are gone (the drag left, or dropped) the letter is scrolled back to where it was.
  $effect(() => {
    if (!m.zones || !bodyFrame) return;
    const scroller = bodyFrame.closest<HTMLElement>(".scroll");
    const was = scroller?.scrollTop ?? 0;
    bodyFrame.scrollIntoView({ block: "nearest" });
    return () => {
      if (scroller) scroller.scrollTop = was;
    };
  });

  /** The chips of the one-line strip; at full screen all of them, in up to two rows. */
  const chips = $derived(c.mode === "max" ? c.draft.attachments.length : visibleChips(width, c.draft.attachments.length));

  /** Takes a file off the letter from the list; the focus stays in the list, on its neighbour. */
  function dropFile(i: number) {
    c.draft.attachments.splice(i, 1);
    if (!c.draft.attachments.length) {
      filesOpen = false;
      fmt.focusText();
      return;
    }
    requestAnimationFrame(() => {
      const rows = document.querySelectorAll<HTMLElement>(`[data-compose="${c.id}"] [data-att]`);
      rows[Math.min(i, rows.length - 1)]?.focus();
    });
  }

  function onFileKey(e: KeyboardEvent, i: number) {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    e.preventDefault();
    dropFile(i);
  }

  /** The format menu's note is closed for good; Settings → Hints brings it back (#103, 3.3 А). */
  function closePartsNote() {
    void app.patchSettings({ markdown_parts_note: false });
  }

  // The hint line of #69 (frame 14А): a hint about a recipient of this letter stays while
  // the letter is written; it goes when the recipient does or the first words are typed.
  let line = $state<Hint | null>(null);
  const recipients = $derived([...c.draft.to, ...c.draft.cc, ...c.draft.bcc].map((a) => a.email.toLowerCase()));
  $effect(() => {
    const a = hints.active;
    if (a && a.id !== "incoming-view" && recipients.includes(a.subject)) {
      line = a;
    } else if (line && !recipients.includes(line.subject)) {
      line = null;
    }
  });
  $effect(() => {
    // Fades with the first typed word, as the format line of #44 does.
    if (line && fmt.hasOwnText) line = null;
  });

  /** The send-format hint (#69) waits for the next letter to that person: it is offered as
   *  the quiet line of this window, once per window, while the letter is written in Markdown. */
  let offered = false;
  $effect(() => {
    if (offered || line || (c.draft.format ?? "plain") !== "markdown") return;
    for (const a of [...c.draft.to, ...c.draft.cc, ...c.draft.bcc]) {
      if (peopleBook.find(a.email)?.send_format) continue;
      const h = hints.sendFormatHint(a.email, a.name?.trim() || a.email);
      if (!h) continue;
      offered = true;
      void hints.show(h);
      return;
    }
  });

  /** The accepting button of the hint: the rule is set by the runtime, marked «by a hint». */
  async function acceptHint() {
    await hints.accept();
  }

  /** «Undo» of the accepted hint: the rule it set is taken off the person. */
  async function undoHint(h: Hint) {
    const person = peopleBook.find(h.subject);
    if (person) {
      try {
        await peopleBook.save({ ...person, send_format: "", view: "", via: "" });
      } catch (e) {
        app.fail(e);
      }
    }
    line = null;
  }
</script>


{#snippet signatureChip()}
  <SignaturePicker variant="chip" signatures={m.signatures} current={m.signature} onpick={m.putSignature} onsettings={m.signatureSettings} />
{/snippet}

{#snippet formatIcon(format: BodyFormat)}
  {#if format === "html"}<Type size={15} />{:else if format === "markdown"}<Hash size={15} />{:else}<AlignLeft size={15} />{/if}
{/snippet}

<!-- The short card of a person (#66, frame 13): opened by a click on a chip of an address. -->
{#snippet personCard(email: string)}
  <PersonCard short {email} name={peopleBook.find(email)?.name ?? ""} onAllMail={() => app.setView({ kind: "search", text: peopleBook.allMail(email) })} />
{/snippet}

{#if c.mode === "max"}
  <div class="backdrop" role="presentation" onclick={() => (c.mode = "open")}></div>
{/if}
<div
  class="compose"
  class:min={c.mode === "min"}
  class:max={c.mode === "max"}
  data-compose={c.id}
  style:--min-body="{MIN_BODY_PX}px"
  bind:clientWidth={m.width}
  role="dialog"
  aria-label={c.draft.subject.trim() || t("compose.newMessage")}
  tabindex="-1"
  onkeydown={m.onKey}
>
  <!-- The mailbox is in the title (#103, 1.1 Б): there is no «From» row. A plugin that names the
       mailbox colour puts it on this bar through `--row-tint` (account-color). -->
  <header>
    {#each m.controls.filter((x) => x.slot === "from") as x (x)}<x.component {...x.props} compose={sending.contextFor(x)} />{/each}
    <button class="title" onclick={() => (c.mode === "min" ? app.showCompose(c.id) : m.minimize())} title={c.draft.subject.trim() || (c.mode === "min" ? "" : shortcuts.titled(t("compose.minimize"), "compose.fold"))}>
      {c.draft.subject.trim() || t("compose.newMessage")}
    </button>
    {#if c.mode !== "min"}
      <span class="saved" aria-live="polite">{m.savingNow ? t("compose.saving") : m.savedText}</span>
      {#if fromAccount}
        <span class="anchor mailbox-anchor">
          {#if app.accounts.length > 1}
            <button
              class="mailbox"
              onclick={() => (m.fromOpen = !m.fromOpen)}
              title={t("compose.mailbox.change", { name: fromFull })}
              aria-label={t("compose.mailbox.change", { name: fromFull })}
              aria-haspopup="menu"
              aria-expanded={m.fromOpen}
            >
              <i class="dot" style:background={app.accountColor(c.account_id)}></i><span class="mb-name">{mailboxName(fromAccount)}</span><ChevronDown size={12} />
            </button>
            <Popover bind:open={m.fromOpen}>
              <div class="mt">{t("compose.fwd.from")}</div>
              {#each app.accounts as a (a.id)}
                <button class="mi" role="menuitemradio" aria-checked={a.id === c.account_id} data-value={a.id} onclick={() => { m.fromOpen = false; m.setAccount(a.id); }}>
                  <span class="tick">{#if a.id === c.account_id}<Check size={14} />{/if}</span>
                  <i class="dot" style:background={app.accountColor(a.id)}></i>
                  {(a.label?.trim() ? `${accountLabel(a)} — ` : "") + (a.display_name ? `${a.display_name} <${a.email}>` : a.email)}
                </button>
              {/each}
            </Popover>
          {:else}
            <span class="mailbox fixed" title={t("compose.mailbox.is", { name: fromFull })}>
              <i class="dot" style:background={app.accountColor(c.account_id)}></i><span class="mb-name">{mailboxName(fromAccount)}</span>
            </span>
          {/if}
        </span>
      {/if}
    {/if}
    <button class="hb" onclick={() => (c.mode === "min" ? app.showCompose(c.id) : m.minimize())} title={c.mode === "min" ? t("compose.restore") : shortcuts.titled(t("compose.minimize"), "compose.fold")} aria-label={c.mode === "min" ? t("compose.restore") : t("compose.minimize")}>
      <Minus size={15} />
    </button>
    <button class="hb" onclick={m.toggleMax} title={c.mode === "max" ? t("compose.restore") : t("compose.maximize")} aria-label={c.mode === "max" ? t("compose.restore") : t("compose.maximize")}>
      {#if c.mode === "max"}<Minimize size={14} />{:else}<Maximize size={14} />{/if}
    </button>
    <button class="hb" onclick={m.close} title={t("compose.closeHint")} aria-label={t("close")}><X size={15} /></button>
  </header>

  <div class="panel" hidden={c.mode === "min"}>
    <!-- The text keeps its least height (160 px): a window too low for the strips scrolls here. -->
    <div class="scroll">
      <div class="fields">
        <AddressInput label={t("compose.fwd.to")} bind:value={c.draft.to} bind:this={m.toInput} autofocus={c.draft.to.length === 0} card={personCard}>
          {#snippet trailing()}
            {#if !m.showCc}<button class="lnk" onclick={() => void openPart("cc")}>{t("compose.fwd.cc")}</button>{/if}
            {#if !m.showBcc}<button class="lnk" onclick={() => void openPart("bcc")}>{t("compose.bcc")}</button>{/if}
          {/snippet}
        </AddressInput>
        {#if m.showCc}
          <AddressInput label={t("compose.fwd.cc")} bind:value={c.draft.cc} bind:this={m.ccInput} card={personCard} />
        {/if}
        {#if m.showBcc}
          <AddressInput label={t("compose.bcc")} bind:value={c.draft.bcc} bind:this={m.bccInput} card={personCard} />
        {/if}
        <div class="row">
          <span class="label">{t("compose.fwd.subject")}</span>
          <input class="subject" bind:value={c.draft.subject} />
        </div>
      </div>

      {#if m.format !== "plain"}
        <FormatBar
          bind:this={m.bar}
          format={m.format}
          width={m.width}
          rich={m.rich}
          field={m.body}
          onpicturefile={m.pictureFromFile}
          onpictureclipboard={m.pictureFromClipboard}
        />
      {/if}

      <!-- The frame does not scroll: the drop zones lie on it, and stay in view when a signed letter's text is scrolled. -->
      <div class="body-frame" bind:this={bodyFrame} class:signed={m.format !== "html" && !!m.signature}>
      <div class="body-area" bind:clientWidth={m.areaWidth} class:signed={m.format !== "html" && !!m.signature}>
        {#if m.format === "html"}
          <RichEditor
            bind:this={m.rich}
            bind:html={m.htmlBody}
            class="body"
            label={t("compose.body")}
            placeholder={t("compose.bodyPlaceholder")}
            onselection={() => m.bar?.refresh()}
            onpictures={m.pastedPictures}
            locked={SIGNATURE_CLASS}
            lockedBar={m.signature ? signatureChip : undefined}
            readonly={m.switching}
          />
        {:else}
          {#if m.format === "markdown"}
            <MarkdownEditor
              bind:field={() => (m.body && "apply" in m.body ? m.body : null), (v) => (m.body = v)}
              bind:value={m.head}
              markup={m.markup}
              readonly={m.switching}
              label={t("compose.body")}
              placeholder={t("compose.markdownPlaceholder")}
              onfocus={m.onBodyFocus}
              onselection={() => m.bar?.refresh()}
              onpictures={m.pastedPictures}
            />
          {:else}
            <textarea
              bind:this={m.body}
              bind:value={m.head}
              onfocus={m.onBodyFocus}
              readonly={m.switching}
              spellcheck="true"
              aria-label={t("compose.body")}
              placeholder={t("compose.bodyPlaceholder")}
            ></textarea>
          {/if}
          {#if m.signature}
            {@const shown = m.signatureView}
            <!-- The signature under the text, shown, not edited: formatted in an HTML or
                 Markdown letter (frame 13 of #45), its text under "-- " in a plain one. -->
            <div class="sig-plain" role="group" aria-label={t("compose.signature.title")}>
              {#if shown && "html" in shown}
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- the user's own signature -->
                <div class="sig-html">{@html cleanRemoteHtml(shown.html)}</div>
              {:else}
                <div class="sig-text">{(shown && shown.text) || t("compose.signature.noText")}</div>
              {/if}
              <div class="sig-bar">{@render signatureChip()}</div>
            </div>
          {/if}
        {/if}
        {#if !m.signature && m.signatures.length}
          <div class="sig-none">
            <SignaturePicker variant="line" signatures={m.signatures} current={null} onpick={m.putSignature} onsettings={m.signatureSettings} />
          </div>
        {/if}
      </div>
        {#if m.zones}
          <div class="zones">
            <div class="zone inline" class:hover={app.compose.dragging?.zone === "inline"} data-drop-zone="inline">
              <ImageIcon size={22} />
              <b>{t("compose.drop.inline")}</b>
              <span>{t("compose.drop.inlineNote")}</span>
            </div>
            <div class="zone attach" class:hover={app.compose.dragging?.zone === "attach"} data-drop-zone="attach">
              <Paperclip size={22} />
              <b>{t("compose.drop.attach")}</b>
              <span>{t("compose.drop.attachNote")}</span>
            </div>
          </div>
        {/if}
      </div>

      {#if line}
        <HintLine
          hint={line}
          onAccept={acceptHint}
          onNotNow={() => { line = null; void hints.notNow(); }}
          onNeverThis={() => { line = null; void hints.neverThis(); }}
          onNeverAnyone={() => { line = null; void hints.neverAnyone(); }}
          onAll={() => app.openSettings("look")}
          onUndo={() => void undoHint(line!)}
        />
      {/if}

      <RecipientRule accountId={c.account_id} to={c.draft.to} cc={c.draft.cc} bcc={c.draft.bcc} format={m.format} empty={!fmt.hasOwnText} quote={fmt.hasHtmlQuote} onFormat={(f) => void fmt.ruleFormat(f)} onBack={(f) => fmt.ruleReturn(f)} />

      <!-- One line of state (#103, 3.1 А): the quote, then the wait's box and the reminder of the plugin. -->
      {#if hasQuote || hasState}
        <div class="state" role="group" aria-label={t("compose.state")}>
          {#if hasQuote}
            <button class="chip-btn quote-chip" class:on={m.quoteOpen} onclick={() => (m.quoteOpen = !m.quoteOpen)} aria-expanded={m.quoteOpen} title={m.quoteHeader}>
              <CornerUpLeft size={13} />{t("compose.quote")}{#if m.quoteOpen}<ChevronDown size={13} />{:else}<ChevronRight size={13} />{/if}
            </button>
          {/if}
          {#each m.controls.filter((x) => x.slot === "line") as x (x)}<x.component {...x.props} compose={sending.contextFor(x)} />{/each}
        </div>
      {/if}
      {#if hasQuote && m.quoteOpen}
        <textarea class="quote-text" bind:value={m.quote} readonly={m.switching} spellcheck="false" aria-label={t("compose.quote")}></textarea>
      {/if}

      {#if c.draft.attachments.length || m.textPictures}
        <div class="files" class:full={c.mode === "max"} style:--rows={FULL_STRIP_ROWS}>
          {#each c.draft.attachments.slice(0, chips) as a, i (i)}
            <span class="file" title={`${a.name} · ${size(a.size)}`}><Paperclip size={12} /><span class="fname">{a.name}</span> <span class="muted">{size(a.size)}</span>
              <button onclick={() => c.draft.attachments.splice(i, 1)} aria-label={t("remove")}>×</button></span>
          {/each}
          <span class="anchor">
            {#if c.draft.attachments.length > chips}
              <button class="more" onclick={() => (m.filesOpen = !m.filesOpen)} aria-haspopup="menu" aria-expanded={m.filesOpen}>
                {t("compose.attach.more", { n: c.draft.attachments.length - chips })} ›
              </button>
            {/if}
            <AttachmentMenu
              bind:open={m.filesOpen}
              title={t("compose.attach.list", { n: c.draft.attachments.length })}
              files={c.draft.attachments}
              rowTitle={t("remove")}
              hint={(a) => `${size(a.size)} ×`}
              onPick={dropFile}
              onRowKey={onFileKey}
            >
              {#snippet footer()}
                <button class="mi" role="menuitem" onclick={() => { m.filesOpen = false; m.attach(); }}>{t("compose.attach.add")}</button>
              {/snippet}
            </AttachmentMenu>
          </span>
          <span class="muted total" class:danger-text={m.total > 25 * 1024 * 1024}>
            {t("compose.total", { size: size(m.total) })}{m.total > 25 * 1024 * 1024 ? t("compose.tooBig") : ""}
          </span>
        </div>
      {/if}
    </div>

    {#if m.error}<div class="error danger-text selectable">{m.error}</div>{/if}

    {#if m.warnings}
      <div class="warnings" role="alert">
        <TriangleAlert size={18} />
        <div class="list">
          {#each m.warnings as w, i (i)}<div>{w}</div>{/each}
        </div>
        <button class="btn" onclick={() => (m.warnings = null)}>{t("compose.fix")}</button>
        <button class="btn primary" onclick={() => m.send(m.pendingAt, true)}>{t("compose.sendAnyway")}</button>
      </div>
    {/if}

    <footer>
      <span class="split-btn anchor">
        <button class="btn primary main" onclick={() => m.send()} disabled={m.busy}>{m.options.at ? t("compose.schedule") : t("compose.send")}</button>
        {#each m.controls.filter((x) => x.slot === "send") as x (x)}<x.component {...x.props} compose={sending.contextFor(x)} />{/each}
      </span>
      {#if m.options.at}
        <span class="scheduled">
          <Clock size={14} />
          {t("compose.scheduledFor", { when: shortDateTime(m.options.at) })}
          <button class="btn ghost icon" onclick={() => (m.options.at = null)} title={t("compose.unschedule")} aria-label={t("compose.unschedule")}><X size={13} /></button>
        </span>
      {/if}
      {#if m.important}
        <!-- The state of the letter, as the schedule above: a chip that takes it off (#72, 4.1 А). -->
        <span class="scheduled important">
          <span class="bang" aria-hidden="true">!</span>
          {t("compose.importance")}
          <button class="btn ghost icon" onclick={m.toggleImportance} title={t("compose.importance.off")} aria-label={t("compose.importance.off")}><X size={13} /></button>
        </span>
      {/if}
      <button class="btn" onclick={m.attach} disabled={m.busy} title={t("compose.attachHint")} aria-label={t("compose.files")}><Paperclip size={15} />{#if m.width >= 460} {t("compose.files")}{/if}</button>
      {#each m.controls.filter((x) => !x.slot || x.slot === "footer") as x (x)}<x.component {...x.props} compose={sending.contextFor(x)} />{/each}
      <span class="spacer"></span>
      <!-- The format of this letter, the only place it is shown (#103, 3.2 А): a button whose
           label says the current one. In a narrow window only its icon shows. -->
      <span class="anchor">
        <button
          class="btn ghost fmt"
          onclick={() => (m.menuOpen = !m.menuOpen)}
          disabled={m.busy}
          title={t("compose.format.current", { format: formatLabel(m.format) })}
          aria-label={t("compose.format.title")}
          aria-haspopup="menu"
          aria-expanded={m.menuOpen}
        >
          {@render formatIcon(m.format)}
          {#if m.width >= 460}<span>{formatLabel(m.format)}</span>{/if}
          <ChevronDown size={12} />
        </button>
        <Popover bind:open={m.menuOpen}>
          <div class="mt">{t("compose.format.title")}</div>
          {#each m.FORMATS as f (f.value)}
            <button class="mi" role="menuitemradio" aria-checked={m.format === f.value} onclick={() => { m.menuOpen = false; void m.setFormat(f.value); }}>
              <span class="tick">{#if m.format === f.value}<Check size={14} />{/if}</span>{f.label()}
            </button>
          {/each}
          {#if m.format === "markdown"}
            <hr />
            <button class="mi" role="menuitemcheckbox" aria-checked={m.markup} onclick={() => { m.menuOpen = false; m.markup = !m.markup; }}>
              <span class="tick">{#if m.markup}<Check size={14} />{/if}</span>{t("compose.markdown.showMarkup")}
            </button>
            {#if app.settings.markdown_parts_note}<MarkdownPartsNote onclose={closePartsNote} />{/if}
          {/if}
        </Popover>
      </span>
      <span class="anchor">
        <button class="btn ghost icon" onclick={() => (m.moreOpen = !m.moreOpen)} disabled={m.busy} title={t("act.more")} aria-label={t("act.more")} aria-haspopup="menu" aria-expanded={m.moreOpen}><Ellipsis size={15} /></button>
        <Popover bind:open={m.moreOpen}>
          <button class="mi" role="menuitemcheckbox" aria-checked={m.important} onclick={() => { m.moreOpen = false; m.toggleImportance(); }}>
            <span class="tick">{#if m.important}<Check size={14} />{/if}</span>{t("compose.importance")}
          </button>
          <button class="mi" onclick={() => { m.moreOpen = false; m.saveDraft(); }}>{t("compose.saveDraft")}</button>
          <button class="mi danger-text" onclick={() => { m.moreOpen = false; m.discard(); }}>{t("compose.discardDraft")}</button>
        </Popover>
      </span>
      <button class="btn ghost icon" onclick={m.discard} disabled={m.busy} title={t("compose.discardDraft")} aria-label={t("compose.discardDraft")}><Trash size={15} /></button>
    </footer>
  </div>
</div>

<style>
  .compose {
    display: flex;
    flex-direction: column;
    width: min(640px, calc(100vw - 32px));
    height: min(640px, calc(100vh - 56px));
    background: var(--paper);
    border-radius: 10px 10px 0 0;
    box-shadow: 0 8px 40px rgb(0 0 0 / 28%), 0 0 0 1px rgb(0 0 0 / 6%);
    overflow: hidden;
  }

  .compose.min {
    width: 280px;
    height: auto;
  }

  .compose.max {
    position: fixed;
    inset: 32px max(32px, calc((100vw - 1040px) / 2));
    width: auto;
    height: auto;
    border-radius: 12px;
    z-index: 1;
  }

  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(10 14 20 / 45%);
  }

  .panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .panel[hidden] {
    display: none;
  }

  /* Everything above the buttons scrolls together; the buttons stay (#103, 2.2 Б). */
  .scroll {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  /* Nothing but the text gives way: a low window scrolls instead of squeezing the strips. */
  .scroll > :global(:not(.body-frame)) {
    flex-shrink: 0;
  }

  /* The dark bar of Gmail's composer: folded windows are told apart by it. */
  header {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 6px 4px 4px;
    /* A plugin names the mailbox colour in `--row-tint` on this bar (account-color); 14% of it
       over the bar. Without one the variable falls back to the bar's own colour: no change. */
    background: color-mix(in srgb, var(--row-tint, var(--side)) 14%, var(--side));
    color: var(--side-ink);
    flex: none;
  }

  .title {
    flex: 1;
    min-width: 0;
    border: none;
    background: none;
    color: inherit;
    text-align: left;
    padding: 6px 10px;
    font-size: 14px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The mailbox of the letter: a label that keeps its size while the subject is cut with «…». */
  .mailbox-anchor {
    flex: none;
    margin-right: 4px;
  }

  .mailbox {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 180px;
    border: 1px solid color-mix(in srgb, var(--side-ink) 25%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--side-ink) 8%, transparent);
    color: var(--side-ink);
    padding: 2px 7px;
    font: inherit;
    font-size: 12px;
    line-height: 20px;
    cursor: pointer;
    white-space: nowrap;
  }

  .mailbox.fixed {
    cursor: default;
  }

  .mailbox:hover:not(.fixed),
  .mailbox:focus-visible {
    background: color-mix(in srgb, var(--side-ink) 16%, transparent);
  }

  .mb-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dot {
    display: inline-block;
    flex: none;
    width: 9px;
    height: 9px;
    border-radius: 50%;
  }

  /* The quiet text of the bar is the bar's own ink at 80%: over a mailbox tint (14%) it keeps
     6:1 in every theme, which `--side-muted` does not. */
  .hb {
    border: none;
    background: none;
    color: color-mix(in srgb, var(--side-ink) 80%, transparent);
    width: 28px;
    height: 28px;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }

  .hb:hover {
    background: rgb(255 255 255 / 12%);
    color: var(--side-ink);
  }

  .saved {
    font-size: 12px;
    white-space: nowrap;
    color: color-mix(in srgb, var(--side-ink) 80%, transparent);
    padding: 0 6px;
  }

  .icon {
    min-width: 32px;
    justify-content: center;
  }

  .fields {
    padding: 4px 18px 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid var(--line);
    padding: 4px 0;
  }

  .subject {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    padding: 6px 2px;
    font-weight: 600;
  }

  textarea {
    flex: 1;
    margin: 0;
    border: none;
    outline: none;
    resize: none;
    padding: 14px 18px;
    background: var(--paper);
    line-height: 1.55;
    user-select: text;
  }

  /* One line of state (#103, 3.1 А): the quote, the wait's box, the reminder. */
  .state {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 14px;
    flex: none;
    min-height: 30px;
    padding: 2px 18px;
    border-top: 1px solid var(--line);
    font-size: 12px;
    color: var(--muted);
  }

  .chip-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: none;
    border-radius: 6px;
    background: none;
    padding: 3px 4px;
    font: inherit;
    color: var(--muted);
    cursor: pointer;
  }

  .chip-btn:hover,
  .chip-btn:focus-visible,
  .chip-btn.on {
    background: var(--hover);
    color: var(--ink);
  }

  /* The quote opens under the line, at a fixed height: the text above it keeps its room. */
  .quote-text {
    flex: none;
    height: 96px;
    padding: 4px 18px 6px 32px;
    border-top: 1px dashed var(--line);
    font-size: 12.5px;
    color: var(--muted);
  }

  /* The tick of the current format in the «⋯» menu. */
  .tick {
    display: inline-flex;
    width: 14px;
    color: var(--accent);
  }

  .body-frame {
    position: relative;
    flex: 1 0 var(--min-body, 160px);
    min-height: var(--min-body, 160px);
    display: flex;
    flex-direction: column;
  }

  .body-area {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* The signature of a plain letter: under the text, apart, not edited; its menu on it. */
  .sig-plain {
    position: relative;
    flex: none;
    margin: 0 18px;
    padding: 8px 0 10px;
    border-top: 1px dashed var(--line);
    max-height: 40%;
    overflow: auto;
  }

  .sig-text {
    white-space: pre-wrap;
    line-height: 1.55;
    color: var(--ink);
    opacity: 0.9;
    user-select: text;
  }

  /* An HTML or Markdown letter's signature: shown as it is, its own colours and pictures. */
  .sig-html {
    line-height: 1.5;
    color: var(--ink);
    user-select: text;
    overflow: hidden;
  }

  .sig-html :global(img) {
    max-width: 100%;
  }

  .sig-bar {
    position: absolute;
    right: 0;
    top: 2px;
    opacity: 0;
    transition: opacity 0.12s;
  }

  .sig-plain:hover .sig-bar,
  .sig-bar:focus-within,
  .sig-bar:has(:global(.open)) {
    opacity: 1;
  }

  .sig-none {
    flex: none;
    padding: 2px 18px 8px;
  }

  /* The field grows with its text; the area scrolls the letter and its signature together. */
  .body-frame.signed {
    /* The text keeps its 160 px and the signature shows a few lines under it. */
    flex-basis: calc(var(--min-body, 160px) + 72px);
    min-height: calc(var(--min-body, 160px) + 72px);
  }

  .body-area.signed {
    overflow-y: auto;
  }

  .body-area.signed textarea {
    flex: none;
    min-height: var(--min-body, 160px);
    overflow: hidden;
  }

  .body-area.signed .sig-plain {
    max-height: none;
    overflow: visible;
    margin-bottom: 14px;
  }

  .body-area.signed :global(.md-editor) {
    flex: none;
    min-height: var(--min-body, 160px);
  }

  /* Files dragged over an HTML letter: into the text, or attached. */
  .zones {
    position: absolute;
    inset: 10px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    z-index: 2;
  }

  .zone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    text-align: center;
    padding: 12px;
    border: 2px dashed var(--line);
    border-radius: 10px;
    background: color-mix(in srgb, var(--paper) 92%, var(--ink));
    color: var(--muted);
    font-size: 12.5px;
  }

  .zone b {
    color: var(--ink);
    font-size: 14px;
  }

  .zone.hover {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--paper));
  }

  /* The strip of attachments: one line and «+N more» (#103, 2.1 А); at full screen up to
     two rows with its own scroll (2.1 Б). */
  .files {
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
    min-height: 36px;
    padding: 4px 18px;
    border-top: 1px solid var(--line);
    overflow: hidden;
  }

  .files.full {
    flex-wrap: wrap;
    max-height: calc(var(--rows) * 30px + 8px);
    overflow-y: auto;
  }

  .file {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 180px;
    background: var(--hover);
    border-radius: 6px;
    padding: 3px 4px 3px 8px;
    font-size: 13px;
    white-space: nowrap;
  }

  .file :global(svg) {
    flex: none;
  }

  .fname {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .file button {
    border: none;
    background: none;
    color: var(--muted);
  }

  .more {
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 13px;
    white-space: nowrap;
    cursor: pointer;
  }

  .more:hover,
  .more:focus-visible {
    text-decoration: underline;
  }

  .total {
    margin-left: auto;
    padding-left: 8px;
    font-size: 12px;
    white-space: nowrap;
  }

  /* «Cc» and «Bcc» beside «To»: quiet links, the keys not printed (#103, 1.2 А). */
  .lnk {
    flex: none;
    align-self: center;
    border: none;
    background: none;
    padding: 0 3px;
    font: inherit;
    font-size: 12px;
    color: var(--accent);
    cursor: pointer;
    white-space: nowrap;
  }

  .lnk:hover,
  .lnk:focus-visible {
    text-decoration: underline;
  }

  .error {
    padding: 6px 18px;
  }

  footer {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    padding: 10px 18px 14px;
    border-top: 1px solid var(--line);
  }

  .anchor {
    position: relative;
    display: inline-flex;
  }

  .split-btn .main {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }



  .warnings {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 18px 8px;
    padding: 10px 12px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--warn) 12%, var(--paper));
    border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--paper));
    color: var(--ink);
  }

  .warnings :global(svg) {
    color: var(--warn);
    flex: none;
  }

  .warnings .list {
    flex: 1;
    line-height: 1.45;
  }

  .spacer {
    flex: 1;
  }

  .scheduled {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--accent);
    font-size: 13px;
    white-space: nowrap;
  }

  /* Amber, not red: red is the flag, the cursor and «Send» (#72). */
  .scheduled.important {
    color: var(--imp);
  }

  .bang {
    font-weight: 800;
  }
</style>
