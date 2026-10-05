<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { api } from "../lib/api";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import FileText from "@lucide/svelte/icons/file-text";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Minus from "@lucide/svelte/icons/minus";
  import Maximize from "@lucide/svelte/icons/maximize-2";
  import Minimize from "@lucide/svelte/icons/minimize-2";
  import X from "@lucide/svelte/icons/x";
  import Trash from "@lucide/svelte/icons/trash-2";
  import Clock from "@lucide/svelte/icons/clock";
  import ImageIcon from "@lucide/svelte/icons/image";
  import { app, type ComposeWindow } from "../lib/store.svelte";
  import { convertDraft, isDirty, losesFormatting, splitQuote, swapSignature, swapSignatureHtml } from "../lib/compose";
  import { GAP, htmlToText, letterText, splitHtmlQuote, textToHtml } from "../lib/richtext";
  import { cleanEditorHtml } from "../lib/sanitize";
  import {
    FIT_FROM,
    MAX_PICTURE,
    dataUrlSize,
    isPictureName,
    pictureHtml,
    pictureName,
    picturesSize,
    readAsDataUrl,
    shrinkPicture,
    takePictures,
  } from "../lib/images";
  import type { BodyFormat, ComposeDraft } from "../lib/types";
  import RichEditor from "./RichEditor.svelte";
  import FormatBar from "./FormatBar.svelte";
  import { composeAction } from "../lib/composeKeys";
  import { accountLabel, listDate, shortDateTime, size } from "../lib/format";
  import { t } from "../lib/i18n.svelte";
  import { sendWarnings } from "../lib/sendChecks";
  import AddressInput from "./AddressInput.svelte";
  import Select from "./Select.svelte";
  import { registry } from "../plugin-host/registry.svelte";
  import type { ComposeContext } from "../plugin-api";

  let { c }: { c: ComposeWindow } = $props();
  // A window keeps its composition for life (keyed by id in App.svelte).
  let showCc = $state(untrack(() => c.draft.cc.length > 0 || c.draft.bcc.length > 0));
  let busy = $state(false);
  let error = $state("");
  let toInput = $state<AddressInput | null>(null);
  let ccInput = $state<AddressInput | null>(null);
  let bccInput = $state<AddressInput | null>(null);
  let body = $state<HTMLTextAreaElement | null>(null);

  const format = $derived<BodyFormat>(c.draft.format ?? "plain");
  /** The window's width: the format switch and the formatting row fold in a narrow one. */
  let width = $state(640);

  // A reply's quote stays folded under the field; the draft keeps the whole text.
  const parts = untrack(() => splitQuote(c.draft.text));
  let head = $state(parts.head);
  let quote = $state(parts.quote);
  let quoteOpen = $state(false);
  const quoteHeader = $derived(quote.trim().split("\n")[0] ?? "");
  // An HTML letter is one editor: the quote of a reply stands in it, under the signature.
  let htmlBody = $state(untrack(() => c.draft.html ?? ""));
  /** The plain version last made of the HTML: a different text was set from outside. */
  let plainOfHtml = untrack(() => c.draft.text);
  /** The quote turned into text once, not on every key: a quoted letter may be long. */
  let quoteText = { html: "", text: "" };
  function plainOf(html: string): string {
    const split = splitHtmlQuote(html);
    if (split.quote !== quoteText.html) quoteText = { html: split.quote, text: htmlToText(split.quote) };
    return letterText(split.head, quoteText.text);
  }
  $effect(() => {
    if (format === "html") return;
    const text = head + quote;
    if (untrack(() => c.draft.text) !== text) c.draft.text = text;
  });
  $effect(() => {
    if (format !== "html") return;
    const html = htmlBody;
    untrack(() => {
      if (c.draft.html !== html) c.draft.html = html;
      plainOfHtml = plainOf(html);
      if (c.draft.text !== plainOfHtml) c.draft.text = plainOfHtml;
    });
  });
  // A plugin may set the text as a whole: split it again.
  $effect(() => {
    const text = c.draft.text;
    untrack(() => {
      if (format !== "html") {
        if (head + quote !== text) ({ head, quote } = splitQuote(text));
      } else if (text !== plainOfHtml) {
        plainOfHtml = text;
        htmlBody = textToHtml(text);
      }
    });
  });

  /** Files and the pictures in the text: both travel in the letter. */
  const pictures = $derived(format === "html" ? picturesSize(htmlBody) : 0);
  const total = $derived(c.draft.attachments.reduce((n, a) => n + a.size, 0) + pictures);
  /** Warnings the user has to look at before the message goes; null when not checked yet. */
  let warnings = $state<string[] | null>(null);
  let pendingAt: number | null = null;

  /** What plugins see of this window; they set the send options. */
  // The time belongs to the draft: it is saved with it and survives closing the window.
  let followupDays = $state<number | null>(null);
  let followupSecs = $state<number | null>(null);
  const options: ComposeContext["options"] = {
    get at() {
      return c.draft.send_at ?? null;
    },
    set at(v) {
      c.draft.send_at = v;
    },
    get followupDays() {
      return followupDays;
    },
    set followupDays(v) {
      followupDays = v;
    },
    get followupSecs() {
      return followupSecs;
    },
    set followupSecs(v) {
      followupSecs = v;
    },
  };
  const composeCtx: ComposeContext = {
    get draft() {
      return c.draft;
    },
    accountEmail: () => app.account(c.account_id)?.email ?? "",
    insertText,
    options,
    send: (at) => send(at ?? null),
  };
  const controls = $derived(
    [...registry.items("composeControls")].sort((a, b) => (a.order ?? 50) - (b.order ?? 50)),
  );

  function insertText(text: string) {
    if (format === "html") return rich?.insertText(text);
    const at = body ? body.selectionStart : 0;
    head = head.slice(0, at) + text + head.slice(at);
    queueMicrotask(() => {
      body?.focus();
      body?.setSelectionRange(at + text.length, at + text.length);
    });
  }

  // Entering the body of a fresh message puts the caret above the signature, once.
  let placed = false;
  function onBodyFocus() {
    if (placed || !body) return;
    placed = true;
    if (c.draft.text.startsWith("\n\n")) body.setSelectionRange(0, 0);
  }

  // Replies start typing above the quote and signature. Once, when the window opens:
  // an effect would rerun on every keystroke and throw the caret back to the start.
  // The field opens at its top, not at the end of a long quote: setting the value and
  // focusing scroll it to the end in WebKit, and moving the caret does not scroll back.
  onMount(() => {
    if (format === "html") {
      if (c.draft.to.length && htmlBody.startsWith(GAP)) {
        placed = true;
        rich?.focus(true);
      }
      return;
    }
    if (!body) return;
    if (c.draft.text.startsWith("\n\n") && c.draft.to.length) {
      placed = true;
      body.focus();
      body.setSelectionRange(0, 0);
    }
    body.scrollTop = 0;
    const field = body;
    requestAnimationFrame(() => (field.scrollTop = 0));
  });

  function setAccount(id: string) {
    const acc = app.account(id);
    if (!acc) return;
    const before = app.account(c.account_id)?.signature;
    if (format === "html") {
      // The signature stands above the quote: only the part above it is looked at.
      const split = splitHtmlQuote(htmlBody);
      htmlBody = swapSignatureHtml(split.head, before, acc.signature) + split.quote;
    } else head = swapSignature(head, before, acc.signature);
    c.account_id = id;
    c.draft.from = { name: acc.display_name, email: acc.email };
  }

  const FORMATS: { value: BodyFormat; label: () => string; short: () => string }[] = [
    { value: "plain", label: () => t("format.short.plain"), short: () => t("format.short.plain") },
    { value: "html", label: () => t("format.short.html"), short: () => t("format.short.html") },
    { value: "markdown", label: () => t("format.short.markdown"), short: () => t("format.short.md") },
  ];

  let switching = false;

  /** Rewrites the letter in another format; the settings stay as they are. */
  async function setFormat(next: BodyFormat) {
    if (next === format || switching) return;
    const signature = app.account(c.account_id)?.signature;
    let current = $state.snapshot(c.draft) as ComposeDraft;
    if (losesFormatting(current, next)) {
      const ok = await app.confirm({
        title: t("compose.format.toPlainTitle"),
        text: t("compose.format.loseHtml"),
        okLabel: t("compose.format.toPlain"),
        cancelLabel: t("compose.format.stayHtml"),
      });
      if (!ok) return;
    }
    switching = true;
    try {
      if (format === "html" && next === "markdown") {
        // Markdown has no pictures inside: they go with the letter as files.
        const { html, pictures } = takePictures(current.html ?? "");
        if (pictures.length) {
          const ok = await app.confirm({ text: t("compose.format.picturesAttach"), okLabel: t("compose.format.toMarkdown") });
          if (!ok) return;
          let n = c.draft.attachments.length;
          for (const p of pictures) {
            const name = pictureName(p.mime, ++n);
            const path = await api.tempAttachment(name, p.base64);
            c.draft.attachments.push({ kind: "file", path, name, size: Math.floor((p.base64.length * 3) / 4) });
          }
          current = { ...current, html };
        }
      }
      preview = false;
      const d = await convertDraft(current, next, signature, (text) => api.markdownHtml(text));
      if (d.format === "html") {
        htmlBody = d.html ?? "";
        plainOfHtml = d.text;
      } else {
        ({ head, quote } = splitQuote(d.text));
      }
      c.draft.html = d.html ?? null;
      c.draft.text = d.text;
      c.draft.format = d.format;
    } catch (e) {
      app.fail(e);
    } finally {
      switching = false;
    }
  }

  let rich = $state<RichEditor | null>(null);
  let bar = $state<FormatBar | null>(null);
  /** Markdown shown as it will look. */
  let preview = $state(false);
  let previewHtml = $state("");
  $effect(() => {
    if (!preview || format !== "markdown") return;
    const text = c.draft.text;
    api
      .markdownHtml(text)
      .then((html) => (previewHtml = cleanEditorHtml(html)))
      .catch((e) => app.fail(e));
  });

  // Pictures in the text of an HTML letter. A large photo is made smaller first; one
  // still too big goes as a file, as it would anyway.
  async function addPictures(found: { name: string; dataUrl: string }[]) {
    let fragment = "";
    for (const p of found) {
      try {
        const ready = await shrinkPicture(p.dataUrl);
        if (dataUrlSize(ready.dataUrl) > MAX_PICTURE) {
          const base64 = p.dataUrl.slice(p.dataUrl.indexOf(",") + 1);
          const path = await api.tempAttachment(p.name, base64);
          c.draft.attachments.push({ kind: "file", path, name: p.name, size: dataUrlSize(p.dataUrl) });
          app.toast(t("compose.picture.attachedBig", { name: p.name }));
          continue;
        }
        fragment += pictureHtml(ready.dataUrl, ready.width > FIT_FROM ? "fit" : "natural");
      } catch (e) {
        app.fail(e);
      }
    }
    if (fragment) rich?.insertHtml(fragment);
  }

  /** Picture files chosen or dropped "into the text"; a file that cannot go there is attached. */
  async function insertPictureFiles(paths: string[]) {
    const found: { name: string; dataUrl: string }[] = [];
    for (const path of paths) {
      const name = path.split(/[\\/]/).pop() ?? path;
      try {
        found.push({ name, dataUrl: await api.inlineImage(path) });
      } catch {
        const info = await api.fileInfo(path).catch(() => null);
        if (info) c.draft.attachments.push({ kind: "file", path, name: info.name, size: info.size });
        app.toast(t("compose.picture.attachedBig", { name }));
      }
    }
    await addPictures(found);
  }

  async function pictureFromFile() {
    try {
      const files = await api.pickFiles(t("compose.picture.pickTitle"), true);
      for (const f of files.filter((f) => !isPictureName(f.name))) c.draft.attachments.push({ kind: "file", ...f });
      await insertPictureFiles(files.filter((f) => isPictureName(f.name)).map((f) => f.path));
    } catch (e) {
      app.fail(e);
    }
  }

  async function pastedPictures(blobs: Blob[]) {
    const found: { name: string; dataUrl: string }[] = [];
    let n = 0;
    for (const blob of blobs) found.push({ name: blob instanceof File && blob.name ? blob.name : pictureName(blob.type, ++n), dataUrl: await readAsDataUrl(blob) });
    await addPictures(found);
  }

  async function pictureFromClipboard() {
    const blobs: Blob[] = [];
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((x) => /^image\/(png|jpeg|gif|webp)$/.test(x));
        if (type) blobs.push(await item.getType(type));
      }
    } catch {
      // The system did not give the clipboard to the page: Ctrl+V does it.
      return app.toast(t("compose.picture.useCtrlV"));
    }
    if (!blobs.length) return app.toast(t("compose.picture.noneInClipboard"));
    await pastedPictures(blobs);
  }

  // Dropped files go to the window's zones: "into the text" or "attach" (App.svelte).
  onMount(() => {
    app.compose.pictureTarget(c.id, insertPictureFiles);
    return () => app.compose.pictureTarget(c.id, null);
  });
  const zones = $derived(format === "html" && c.mode !== "min" && !!app.compose.dragging?.zones && app.activeCompose()?.id === c.id);

  async function attach() {
    try {
      for (const f of await api.pickFiles(t("compose.attachTitle"))) c.draft.attachments.push({ kind: "file", ...f });
    } catch (e) {
      app.fail(e);
    }
  }

  function commitAll(): boolean {
    const ok = [toInput, ccInput, bccInput].map((i) => i?.commit() ?? true);
    return ok.every(Boolean);
  }

  /** One send at a time: Ctrl+Enter pressed again while the checks run must not queue the letter twice. */
  let sending = false;

  /** `at`: scheduled time; `force`: the warnings were seen and accepted. */
  async function send(at: number | null = null, force = false) {
    if (sending) return;
    sending = true;
    try {
      await sendOnce(at, force);
    } finally {
      sending = false;
    }
  }

  async function sendOnce(at: number | null, force: boolean) {
    error = "";
    if (!commitAll()) {
      error = t("compose.badAddresses");
      return;
    }
    if (c.draft.to.length + c.draft.cc.length + c.draft.bcc.length === 0) {
      error = t("compose.noRecipients");
      return;
    }
    if (!force) {
      const email = app.account(c.account_id)?.email ?? "";
      const draft = $state.snapshot(c.draft);
      busy = true;
      const found = await sendWarnings(draft, email);
      busy = false;
      if (found.length) {
        warnings = found;
        pendingAt = at;
        return;
      }
    }
    warnings = null;
    busy = true;
    try {
      // The saved draft goes away once the letter is sent: the latest copy must be known.
      cancelAutosave();
      await saving;
      await app.send(c.account_id, $state.snapshot(c.draft), c.draft_id, at ?? options.at, options.followupSecs ?? (options.followupDays ? options.followupDays * 86_400 : null));
      app.closeCompose(c.id);
    } catch (e) {
      error = (e as { message: string }).message;
    } finally {
      busy = false;
    }
  }

  // Drafts save themselves a moment after typing stops, as in Gmail and Yandex Mail:
  // closing or folding the window never loses the letter.
  const AUTOSAVE_MS = 3000;
  /** The content as it was last saved; the opening content counts as saved unless it is kept nowhere. */
  let lastSaved = untrack(() => (c.unsaved ? "" : JSON.stringify($state.snapshot(c.draft))));
  let saving: Promise<boolean> | null = null;
  let savingNow = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancelAutosave() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  $effect(() => {
    const now = JSON.stringify($state.snapshot(c.draft));
    cancelAutosave();
    if (now !== lastSaved) timer = setTimeout(() => saveDraft(), AUTOSAVE_MS);
  });
  onDestroy(cancelAutosave);

  /** Saves the draft on the server unless nothing changed; one save at a time. */
  async function saveDraft(): Promise<boolean> {
    cancelAutosave();
    while (saving) await saving;
    const draft = $state.snapshot(c.draft);
    const text = JSON.stringify(draft);
    if (text === lastSaved) return true;
    if (!isDirty(draft, app.account(c.account_id)?.signature) && c.draft_id === null) return true;
    savingNow = true;
    saving = (async () => {
      try {
        c.draft_id = await api.draftSave(c.account_id, draft, c.draft_id);
        lastSaved = text;
        c.unsaved = false;
        c.savedAt = Date.now();
        error = "";
        return true;
      } catch (e) {
        error = t("compose.draftNotSaved", { error: (e as { message: string }).message });
        return false;
      } finally {
        saving = null;
        savingNow = false;
      }
    })();
    return saving;
  }

  async function close() {
    if (busy) return;
    commitAll();
    const changed = JSON.stringify($state.snapshot(c.draft)) !== lastSaved;
    if (changed && !(await saveDraft())) {
      const drop = await app.confirm({ text: t("compose.closeAnyway"), okLabel: t("close"), cancelLabel: t("compose.goBack"), danger: true });
      if (!drop) return;
    }
    if (c.draft_id !== null) app.toast(t("compose.draftSaved"));
    app.closeCompose(c.id);
  }

  async function discard() {
    if (busy) return;
    if (isDirty(c.draft, app.account(c.account_id)?.signature)) {
      const ok = await app.confirm({ text: t("compose.discardConfirm"), okLabel: t("act.delete"), danger: true });
      if (!ok) return;
    }
    cancelAutosave();
    await saving;
    if (c.draft_id !== null) api.draftDiscard(c.draft_id).catch((e) => app.fail(e));
    app.closeCompose(c.id);
  }

  function minimize() {
    commitAll();
    c.mode = "min";
    saveDraft();
  }

  function toggleMax() {
    if (c.mode === "max") c.mode = "open";
    else app.showCompose(c.id, "max");
  }

  const savedText = $derived(c.savedAt ? t("compose.savedAt", { time: listDate(Math.floor(c.savedAt / 1000)) }) : "");

  // The window's keys come from one table (lib/composeKeys.ts); Ctrl+K is left to the palette.
  function onKey(e: KeyboardEvent) {
    const action = composeAction(e);
    if (action === "send") {
      e.preventDefault();
      send(null, warnings !== null);
    } else if (action === "fold") {
      // Gmail's way: Esc leaves full screen, then folds the window; the draft stays.
      e.preventDefault();
      if (c.mode === "max") c.mode = "open";
      else minimize();
    } else if (action === "link" && format !== "plain") {
      e.preventDefault();
      bar?.startLink();
    } else if (action === "preview" && format === "markdown") {
      e.preventDefault();
      preview = !preview;
    } else if ((action === "bold" || action === "italic" || action === "underline") && format === "markdown" && !preview) {
      // The HTML editor does these itself; in Markdown they type the markup.
      e.preventDefault();
      bar?.run(action);
    }
  }
</script>

{#if c.mode === "max"}
  <div class="backdrop" role="presentation" onclick={() => (c.mode = "open")}></div>
{/if}
<div
  class="compose"
  class:min={c.mode === "min"}
  class:max={c.mode === "max"}
  bind:clientWidth={width}
  role="dialog"
  aria-label={c.draft.subject.trim() || t("compose.newMessage")}
  tabindex="-1"
  onkeydown={onKey}
>
  <header>
    <button class="title" onclick={() => (c.mode === "min" ? app.showCompose(c.id) : minimize())} title={c.mode === "min" ? "" : t("compose.minimize")}>
      {c.draft.subject.trim() || t("compose.newMessage")}
    </button>
    {#if c.mode !== "min"}<span class="saved" aria-live="polite">{savingNow ? t("compose.saving") : savedText}</span>{/if}
    <button class="hb" onclick={() => (c.mode === "min" ? app.showCompose(c.id) : minimize())} title={c.mode === "min" ? t("compose.restore") : t("compose.minimize")} aria-label={c.mode === "min" ? t("compose.restore") : t("compose.minimize")}>
      <Minus size={15} />
    </button>
    <button class="hb" onclick={toggleMax} title={c.mode === "max" ? t("compose.restore") : t("compose.maximize")} aria-label={c.mode === "max" ? t("compose.restore") : t("compose.maximize")}>
      {#if c.mode === "max"}<Minimize size={14} />{:else}<Maximize size={14} />{/if}
    </button>
    <button class="hb" onclick={close} title={t("compose.closeHint")} aria-label={t("close")}><X size={15} /></button>
  </header>

  <div class="panel" hidden={c.mode === "min"}>
    <div class="fields">
      <div class="row">
        <span class="label">{t("compose.fwd.from")}</span>
        <Select
          class="from"
          label={t("compose.fwd.from")}
          value={c.account_id}
          options={app.accounts.map((a) => ({
            value: a.id,
            label: (a.label?.trim() ? `${accountLabel(a)} — ` : "") + (a.display_name ? `${a.display_name} <${a.email}>` : a.email),
          }))}
          onchange={setAccount}
        />
        {#if width >= 360}
          <div class="modes" role="radiogroup" aria-label={t("compose.format.title")}>
            {#each FORMATS as f (f.value)}
              <button role="radio" aria-checked={format === f.value} class:on={format === f.value} disabled={busy} onclick={() => setFormat(f.value)}>
                {width >= 460 ? f.label() : f.short()}
              </button>
            {/each}
          </div>
        {:else}
          <Select
            class="mode-select"
            label={t("compose.format.title")}
            bind:value={() => format, (v) => void setFormat(v)}
            options={FORMATS.map((f) => ({ value: f.value, label: f.label() }))}
            disabled={busy}
          />
        {/if}
        {#if !showCc}<button class="btn ghost small" onclick={() => (showCc = true)}>{t("compose.fwd.cc")}</button>{/if}
      </div>
      <AddressInput label={t("compose.fwd.to")} bind:value={c.draft.to} bind:this={toInput} autofocus={c.draft.to.length === 0} />
      {#if showCc}
        <AddressInput label={t("compose.fwd.cc")} bind:value={c.draft.cc} bind:this={ccInput} />
        <AddressInput label={t("compose.bcc")} bind:value={c.draft.bcc} bind:this={bccInput} />
      {/if}
      <div class="row">
        <span class="label">{t("compose.fwd.subject")}</span>
        <input class="subject" bind:value={c.draft.subject} />
      </div>
    </div>

    {#if format !== "plain"}
      <FormatBar
        bind:this={bar}
        {format}
        {width}
        {rich}
        field={body}
        bind:preview
        onpicturefile={pictureFromFile}
        onpictureclipboard={pictureFromClipboard}
      />
    {/if}

    <div class="body-area">
      {#if format === "html"}
        <RichEditor
          bind:this={rich}
          bind:html={htmlBody}
          class="body"
          label={t("compose.body")}
          placeholder={t("compose.bodyPlaceholder")}
          onselection={() => bar?.refresh()}
          onpictures={pastedPictures}
        />
      {:else if format === "markdown" && preview}
        <!-- Cleaned twice: by the backend that renders it and here. -->
        <div class="md-preview" role="document" aria-label={t("compose.markdown.preview")}>{@html previewHtml}</div>
      {:else}
        <textarea
          bind:this={body}
          bind:value={head}
          onfocus={onBodyFocus}
          spellcheck="true"
          aria-label={t("compose.body")}
          placeholder={format === "markdown" ? t("compose.markdownPlaceholder") : t("compose.bodyPlaceholder")}
        ></textarea>
      {/if}
      {#if zones}
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
    {#if format === "markdown"}<p class="md-note">{t("compose.markdown.note")}</p>{/if}

    {#if format !== "html" && quote}
      <div class="quote" class:open={quoteOpen}>
        <button class="quote-bar" onclick={() => (quoteOpen = !quoteOpen)} aria-expanded={quoteOpen}>
          {#if quoteOpen}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if}
          <span class="quote-who">{quoteHeader}</span>
          <span class="quote-act">{quoteOpen ? t("compose.quoteHide") : t("compose.quoteShow")}</span>
        </button>
        {#if quoteOpen}
          <textarea class="quote-text" bind:value={quote} spellcheck="false" aria-label={t("compose.quote")}></textarea>
        {/if}
      </div>
    {/if}

    {#if c.draft.attachments.length || pictures}
      <div class="files">
        {#each c.draft.attachments as a, i (i)}
          <span class="file"><Paperclip size={12} /> {a.name} <span class="muted">{size(a.size)}</span>
            <button onclick={() => c.draft.attachments.splice(i, 1)} aria-label={t("remove")}>×</button></span>
        {/each}
        <span class="muted total" class:danger-text={total > 25 * 1024 * 1024}>
          {t("compose.total", { size: size(total) })}{total > 25 * 1024 * 1024 ? t("compose.tooBig") : ""}
        </span>
      </div>
    {/if}

    {#if error}<div class="error danger-text selectable">{error}</div>{/if}

    {#if warnings}
      <div class="warnings" role="alert">
        <TriangleAlert size={18} />
        <div class="list">
          {#each warnings as w, i (i)}<div>{w}</div>{/each}
        </div>
        <button class="btn" onclick={() => (warnings = null)}>{t("compose.fix")}</button>
        <button class="btn primary" onclick={() => send(pendingAt, true)}>{t("compose.sendAnyway")}</button>
      </div>
    {/if}

    <footer>
      <span class="split-btn anchor">
        <button class="btn primary main" onclick={() => send()} disabled={busy}>{options.at ? t("compose.schedule") : t("compose.send")} <kbd>Ctrl+Enter</kbd></button>
        {#each controls.filter((x) => x.slot === "send") as x (x)}<x.component {...x.props} compose={composeCtx} />{/each}
      </span>
      {#if options.at}
        <span class="scheduled">
          <Clock size={14} />
          {t("compose.scheduledFor", { when: shortDateTime(options.at) })}
          <button class="btn ghost icon" onclick={() => (options.at = null)} title={t("compose.unschedule")} aria-label={t("compose.unschedule")}><X size={13} /></button>
        </span>
      {/if}
      <button class="btn" onclick={attach} disabled={busy} title={t("compose.attachHint")} aria-label={t("compose.files")}><Paperclip size={15} />{#if width >= 460} {t("compose.files")}{/if}</button>
      {#each controls.filter((x) => x.slot !== "send") as x (x)}<x.component {...x.props} compose={composeCtx} />{/each}
      <span class="spacer"></span>
      <button class="btn ghost icon" onclick={discard} disabled={busy} title={t("compose.discardDraft")} aria-label={t("compose.discardDraft")}><Trash size={15} /></button>
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

  /* The format of this letter, beside its sender: segments, or a list in a narrow window. */
  .modes {
    display: inline-flex;
    flex: none;
    padding: 2px;
    gap: 2px;
    border-radius: 8px;
    background: var(--hover);
  }

  .modes button {
    border: none;
    background: none;
    color: var(--muted);
    font-size: 12.5px;
    padding: 3px 9px;
    border-radius: 6px;
  }

  .modes button.on {
    background: var(--paper);
    color: var(--ink);
    font-weight: 600;
    box-shadow: 0 1px 2px rgb(0 0 0 / 10%);
  }

  .row :global(.mode-select) {
    flex: none;
  }

  .row :global(.mode-select .trigger) {
    border-color: transparent;
  }

  .body-area {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .md-preview {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 14px 18px;
    line-height: 1.55;
    user-select: text;
    contain: layout paint;
  }

  .md-preview :global(blockquote) {
    margin: 0 0 0 0.8ex;
    border-left: 2px solid var(--line);
    padding-left: 1ex;
    color: var(--muted);
  }

  .md-note {
    margin: 0;
    padding: 4px 18px;
    font-size: 12px;
    color: var(--muted);
    border-top: 1px solid var(--line);
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
