<script lang="ts">
  import { untrack } from "svelte";
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
  import Select from "./Select.svelte";
  import Popover from "./Popover.svelte";
  import { keyLabel } from "../lib/composeKeys";
  import { shortcuts } from "../lib/shortcuts.svelte";
  import { ComposeFormat } from "../lib/compose/format.svelte";
  import { ComposeAutosave } from "../lib/compose/autosave.svelte";
  import { ComposeSending } from "../lib/compose/sending.svelte";
  import { ComposeAttachments } from "../lib/compose/attachments.svelte";

  let { c }: { c: ComposeWindow } = $props();
  // The window's own state, which the markup binds; the letter's logic lives in
  // src/lib/compose/ (format, attachments, autosave, sending). A window keeps its
  // composition for life (keyed by id in App.svelte).
  let error = $state("");
  let showCc = $state(untrack(() => c.draft.cc.length > 0 || c.draft.bcc.length > 0));
  let toInput = $state<AddressInput | null>(null);
  let ccInput = $state<AddressInput | null>(null);
  let bccInput = $state<AddressInput | null>(null);
  /** The window's width: the formatting row folds in a narrow one. */
  let width = $state(640);
  /** The format button's menu; the draft's actions keep their own "⋯" beside it. */
  let menuOpen = $state(false);
  let moreOpen = $state(false);

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
  });

  const files = new ComposeAttachments({
    get win() {
      return c;
    },
    format: fmt,
    fail: (e, prefix) => app.fail(e, prefix),
    toastBig: (name) => app.toast(t("compose.picture.attachedBig", { name })),
    useCtrlV: () => app.toast(t("compose.picture.useCtrlV")),
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
    get composeCtx() { return sending.composeCtx; },
    get FORMATS() { return FORMATS; },
    putSignature: (sig: Signature | null) => fmt.putSignature(sig),
    setAccount: (id: string) => fmt.setAccount(id),
    setFormat: (next: BodyFormat) => fmt.setFormat(next),
    onBodyFocus: () => fmt.onBodyFocus(),
    onKey: (e: KeyboardEvent) => sending.onKey(e),
    close: () => sending.close(),
    discard: () => sending.discard(),
    saveDraft: () => sending.saveDraft(),
    get menuOpen() { return menuOpen; },
    set menuOpen(v: boolean) { menuOpen = v; },
    get moreOpen() { return moreOpen; },
    set moreOpen(v: boolean) { moreOpen = v; },
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
  <PersonCard short {email} name={peopleBook.find(email)?.name ?? ""} onAllMail={() => app.setView({ kind: "search", text: `from:${email}` })} />
{/snippet}

{#if c.mode === "max"}
  <div class="backdrop" role="presentation" onclick={() => (c.mode = "open")}></div>
{/if}
<div
  class="compose"
  class:min={c.mode === "min"}
  class:max={c.mode === "max"}
  bind:clientWidth={m.width}
  role="dialog"
  aria-label={c.draft.subject.trim() || t("compose.newMessage")}
  tabindex="-1"
  onkeydown={m.onKey}
>
  <header>
    <button class="title" onclick={() => (c.mode === "min" ? app.showCompose(c.id) : m.minimize())} title={c.mode === "min" ? "" : shortcuts.titled(t("compose.minimize"), "compose.fold")}>
      {c.draft.subject.trim() || t("compose.newMessage")}
    </button>
    {#if c.mode !== "min"}<span class="saved" aria-live="polite">{m.savingNow ? t("compose.saving") : m.savedText}</span>{/if}
    <button class="hb" onclick={() => (c.mode === "min" ? app.showCompose(c.id) : m.minimize())} title={c.mode === "min" ? t("compose.restore") : shortcuts.titled(t("compose.minimize"), "compose.fold")} aria-label={c.mode === "min" ? t("compose.restore") : t("compose.minimize")}>
      <Minus size={15} />
    </button>
    <button class="hb" onclick={m.toggleMax} title={c.mode === "max" ? t("compose.restore") : t("compose.maximize")} aria-label={c.mode === "max" ? t("compose.restore") : t("compose.maximize")}>
      {#if c.mode === "max"}<Minimize size={14} />{:else}<Maximize size={14} />{/if}
    </button>
    <button class="hb" onclick={m.close} title={t("compose.closeHint")} aria-label={t("close")}><X size={15} /></button>
  </header>

  <div class="panel" hidden={c.mode === "min"}>
    <div class="fields">
      <div class="row from-row">
        <span class="label">{t("compose.fwd.from")}</span>
        {#each m.controls.filter((x) => x.slot === "from") as x (x)}<x.component {...x.props} compose={m.composeCtx} />{/each}
        <Select
          class="from"
          label={t("compose.fwd.from")}
          value={c.account_id}
          options={app.accounts.map((a) => ({
            value: a.id,
            label: (a.label?.trim() ? `${accountLabel(a)} — ` : "") + (a.display_name ? `${a.display_name} <${a.email}>` : a.email),
          }))}
          onchange={m.setAccount}
        />
        {#if !m.showCc}<button class="btn ghost small" onclick={() => (m.showCc = true)}>{t("compose.fwd.cc")}</button>{/if}
      </div>
      <AddressInput label={t("compose.fwd.to")} bind:value={c.draft.to} bind:this={m.toInput} autofocus={c.draft.to.length === 0} card={personCard} />
      {#if m.showCc}
        <AddressInput label={t("compose.fwd.cc")} bind:value={c.draft.cc} bind:this={m.ccInput} card={personCard} />
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
        bind:markup={m.markup}
        onpicturefile={m.pictureFromFile}
        onpictureclipboard={m.pictureFromClipboard}
      />
    {/if}

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
    {#if m.format === "markdown"}<MarkdownPartsNote />{/if}

    {#if line}
      <HintLine
        hint={line}
        onAccept={acceptHint}
        onNotNow={() => { line = null; void hints.notNow(); }}
        onNeverThis={() => { line = null; void hints.neverThis(); }}
        onNeverAnyone={() => { line = null; void hints.neverAnyone(); }}
        onAll={() => app.openSettings("general")}
        onUndo={() => void undoHint(line!)}
      />
    {/if}

    <RecipientRule accountId={c.account_id} to={c.draft.to} cc={c.draft.cc} bcc={c.draft.bcc} format={m.format} empty={!fmt.hasOwnText} quote={fmt.hasHtmlQuote} onFormat={(f) => void fmt.ruleFormat(f)} onBack={(f) => fmt.ruleReturn(f)} />

    {#if m.format !== "html" && m.quote}
      <div class="quote" class:open={m.quoteOpen}>
        <button class="quote-bar" onclick={() => (m.quoteOpen = !m.quoteOpen)} aria-expanded={m.quoteOpen}>
          {#if m.quoteOpen}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if}
          <span class="quote-who">{m.quoteHeader}</span>
          <span class="quote-act">{m.quoteOpen ? t("compose.quoteHide") : t("compose.quoteShow")}</span>
        </button>
        {#if m.quoteOpen}
          <textarea class="quote-text" bind:value={m.quote} readonly={m.switching} spellcheck="false" aria-label={t("compose.quote")}></textarea>
        {/if}
      </div>
    {/if}

    {#if c.draft.attachments.length || m.textPictures}
      <div class="files">
        {#each c.draft.attachments as a, i (i)}
          <span class="file"><Paperclip size={12} /> {a.name} <span class="muted">{size(a.size)}</span>
            <button onclick={() => c.draft.attachments.splice(i, 1)} aria-label={t("remove")}>×</button></span>
        {/each}
        <span class="muted total" class:danger-text={m.total > 25 * 1024 * 1024}>
          {t("compose.total", { size: size(m.total) })}{m.total > 25 * 1024 * 1024 ? t("compose.tooBig") : ""}
        </span>
      </div>
    {/if}

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

    {#each m.controls.filter((x) => x.slot === "line") as x (x)}<x.component {...x.props} compose={m.composeCtx} />{/each}
    <footer>
      <span class="split-btn anchor">
        <button class="btn primary main" onclick={() => m.send()} disabled={m.busy}>{m.options.at ? t("compose.schedule") : t("compose.send")}{#if keyLabel("send")} <kbd>{keyLabel("send")}</kbd>{/if}</button>
        {#each m.controls.filter((x) => x.slot === "send") as x (x)}<x.component {...x.props} compose={m.composeCtx} />{/each}
      </span>
      {#if m.options.at}
        <span class="scheduled">
          <Clock size={14} />
          {t("compose.scheduledFor", { when: shortDateTime(m.options.at) })}
          <button class="btn ghost icon" onclick={() => (m.options.at = null)} title={t("compose.unschedule")} aria-label={t("compose.unschedule")}><X size={13} /></button>
        </span>
      {/if}
      <button class="btn" onclick={m.attach} disabled={m.busy} title={t("compose.attachHint")} aria-label={t("compose.files")}><Paperclip size={15} />{#if m.width >= 460} {t("compose.files")}{/if}</button>
      {#each m.controls.filter((x) => !x.slot || x.slot === "footer") as x (x)}<x.component {...x.props} compose={m.composeCtx} />{/each}
      <span class="spacer"></span>
      <!-- The format of this letter: a button beside "⋯" whose label says the current one
           (frame 6 Б of the 0.7 mockup). In a narrow window only its icon shows. -->
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
        </button>
        <Popover bind:open={m.menuOpen}>
          <div class="mt">{t("compose.format.title")}</div>
          {#each m.FORMATS as f (f.value)}
            <button class="mi" role="menuitemradio" aria-checked={m.format === f.value} onclick={() => { m.menuOpen = false; void m.setFormat(f.value); }}>
              <span class="tick">{#if m.format === f.value}<Check size={14} />{/if}</span>{f.label()}
            </button>
          {/each}
        </Popover>
      </span>
      <span class="anchor">
        <button class="btn ghost icon" onclick={() => (m.moreOpen = !m.moreOpen)} disabled={m.busy} title={t("act.more")} aria-label={t("act.more")} aria-haspopup="menu" aria-expanded={m.moreOpen}><Ellipsis size={15} /></button>
        <Popover bind:open={m.moreOpen}>
          <button class="mi" onclick={() => { m.moreOpen = false; m.saveDraft(); }}>{t("compose.saveDraft")}<span class="hint">{keyLabel("save")}</span></button>
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

  /* The dark bar of Gmail's composer: folded windows are told apart by it. */
  header {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 6px 4px 4px;
    background: var(--side);
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

  .hb {
    border: none;
    background: none;
    color: var(--side-muted);
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
    color: var(--side-muted);
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

  /* The «From» row anchors the mailbox tint: `position: relative` makes it the containing
     block for the layer below, and `isolation` keeps that layer over the row's background
     but behind its content. Without `z-index: 1` the row's own stacking context would paint
     before `.body-area` and bury the Select's dropdown — a `position: fixed` descendant of
     this row. */
  .row.from-row {
    position: relative;
    isolation: isolate;
    z-index: 1;
  }

  /* A plugin names the mailbox colour in `--row-tint` on this row (account-color does, in
     its FromTint). The core draws the surface, because only the core knows how far the row
     is inset by `.fields`. `var(--row-tint, transparent)`: with no plugin the variable is
     unset and the layer mixes transparent into transparent — a no-op, so the row stays
     exactly as before, to the last bit.

     The layer bleeds over the field's padding — 4px up to the header, 18px to each edge of
     the window — so the tint runs flush with the compose window instead of stopping at the
     fields' borders. 14% is the plugin's chosen strength: it reads from across the room while
     a resting row stays well below a selected one. */
  .row.from-row::before {
    content: "";
    position: absolute;
    inset: -4px -18px 0;
    z-index: -1;
    pointer-events: none;
    background: color-mix(in srgb, var(--row-tint, transparent) 14%, transparent);
  }

  .label {
    width: 64px;
    color: var(--muted);
    flex: none;
  }

  .row :global(.from) {
    flex: 1;
  }

  .row :global(.from .trigger) {
    border-color: transparent;
    padding-left: 0;
  }

  /* The address field fills with the tint too, so no paper box is left in the middle of a
     full-width tint. Same colour as the layer: 14% of the mailbox colour over paper — the
     paper fallback keeps the field exactly `--paper` when no plugin sets `--row-tint`. */
  .row.from-row :global(.from .trigger) {
    background: color-mix(in srgb, var(--row-tint, var(--paper)) 14%, var(--paper));
  }

  .row :global(.from .trigger:focus) {
    box-shadow: none;
  }

  .subject {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    padding: 6px 2px;
    font-weight: 600;
  }

  .small {
    font-size: 12px;
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

  /* The quote of a reply: one line until asked for. */
  .quote {
    border-top: 1px solid var(--line);
    background: var(--paper);
    display: flex;
    flex-direction: column;
  }

  .quote.open {
    flex: 1;
    min-height: 0;
  }

  .quote-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 18px;
    border: none;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .quote-bar:hover .quote-act,
  .quote-bar:focus-visible .quote-act {
    text-decoration: underline;
  }

  .quote-who {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .quote-act {
    color: var(--accent);
    white-space: nowrap;
  }

  .quote-text {
    padding-top: 4px;
    color: var(--muted);
  }

  /* The tick of the current format in the «⋯» menu. */
  .tick {
    display: inline-flex;
    width: 14px;
    color: var(--accent);
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
  .body-area.signed {
    overflow-y: auto;
  }

  .body-area.signed textarea {
    flex: none;
    min-height: calc(5 * 1.55em + 28px);
    overflow: hidden;
  }

  .body-area.signed .sig-plain {
    max-height: none;
    overflow: visible;
    margin-bottom: 14px;
  }

  .body-area.signed :global(.md-editor) {
    flex: none;
    min-height: calc(5 * 1.55em + 28px);
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

  .files {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 18px;
    border-top: 1px solid var(--line);
    align-items: center;
  }

  .file {
    background: var(--hover);
    border-radius: 6px;
    padding: 3px 4px 3px 8px;
    font-size: 13px;
  }

  .file button {
    border: none;
    background: none;
    color: var(--muted);
  }

  .total {
    font-size: 12px;
  }

  .error {
    padding: 6px 18px;
  }

  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px 14px;
    border-top: 1px solid var(--line);
  }

  footer kbd {
    border-color: rgb(255 255 255 / 40%);
    color: var(--accent-ink);
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
</style>
