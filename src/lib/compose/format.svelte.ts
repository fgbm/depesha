// The body of a composition window: what is typed, the signature under it and the quote
// of a reply, all in the letter's own format. Switching the format rewrites the letter
// (HTML, Markdown or plain text) and the window asks first when the change loses
// something. The state, the effects and the order are the component's of old; the
// window (Compose.svelte) owns the markup and supplies the wording of its dialogs, so
// every `t("…")` of the letter stays in a component.

import { onMount, untrack } from "svelte";
import { api } from "../api";
import { convertDraft, losesFormatting, takeBodyPictures } from "../compose";
import { GAP, htmlToText, letterText, splitHtmlQuote, textToHtml } from "../richtext";
import { cleanEditorHtml } from "../sanitize";
import { pictureName, picturesSize } from "../images";
import {
  defaultSignature,
  hasHtmlSignature,
  putSignatureHtml,
  sigBlock,
  signatureIn,
  signaturesOf,
  splitPlain,
  withoutHtmlSignature,
} from "../signatures";
import type { ComposeWindow } from "../composes.svelte";
import type { AccountView, BodyFormat, ComposeDraft, Signature } from "../types";
import type RichEditor from "../../components/RichEditor.svelte";
import type FormatBar from "../../components/FormatBar.svelte";

/** What the letter's body and format need from the window. */
export interface ComposeFormatHost {
  readonly win: ComposeWindow;
  /** The letter of a separate message window; null in the main window. */
  readonly windowOf: number | null;
  account(id: string): AccountView | undefined;
  openSettings(page?: string, section?: string | null): void;
  fail(e: unknown, prefix?: string): void;
  /** Asks before HTML formatting is dropped for plain text. */
  confirmToPlain(): Promise<boolean>;
  /** Asks before the letter's own pictures are attached on the way to Markdown. */
  confirmPicturesAttach(): Promise<boolean>;
}

export class ComposeFormat {
  /** A plain letter: the field has what is typed, the signature stands under it, a reply's
   * quote or the forwarded letter stays folded below. The draft keeps the whole text. */
  head = $state("");
  quote = $state("");
  quoteOpen = $state(false);
  /** An HTML letter is one editor: the quote of a reply stands in it, under the signature. */
  htmlBody = $state("");
  /** The format switch and the formatting row fold in a narrow window. */
  preview = $state(false);
  previewHtml = $state("");
  /** The editor and the formatting row of this window, as the markup binds them. */
  rich = $state<RichEditor | null>(null);
  bar = $state<FormatBar | null>(null);
  /** The plain field of a plain or Markdown letter, as the markup binds it. */
  body = $state<HTMLTextAreaElement | null>(null);
  /** The width of the body area: a plain letter with a signature grows with its text. */
  areaWidth = $state(0);

  /** The mailbox's signatures, to choose from on the signature block. */
  readonly signatures: Signature[];
  /** Files and the pictures in the text and the signature: all travel in the letter. */
  readonly pictures: number;
  /** The signature's own pictures alone do not bring up the row of files. */
  readonly textPictures: number;
  /** The signature under the letter: one of the mailbox's, a draft's own, or none. A block
   * of its own, never edited in the letter: only put whole, swapped or taken away. */
  signature = $state<Signature | null>(null);

  private host: ComposeFormatHost;
  /** The plain version last made of the HTML: a different text was set from outside. */
  private plainOfHtml = "";
  /** The quote turned into text once, not on every key: a quoted letter may be long. */
  private quoteText = { html: "", text: "" };
  private switching = false;
  /** Entering the body of a fresh message puts the caret above the signature, once. */
  private placed = false;

  constructor(host: ComposeFormatHost) {
    this.host = host;
    this.signatures = $derived(signaturesOf(host.account(host.win.account_id)));
    this.pictures = $derived(this.format === "html" ? picturesSize(this.htmlBody) : 0);
    this.textPictures = $derived(this.format === "html" && this.pictures > 0 ? picturesSize(withoutHtmlSignature(this.htmlBody)) : 0);
    const { draft } = host.win;
    this.signature = untrack(() => signatureIn(draft, signaturesOf(host.account(host.win.account_id))));
    const parts = untrack(() => splitPlain(draft.text));
    this.head = parts.body;
    this.quote = parts.rest;
    this.htmlBody = untrack(() => draft.html ?? "");
    this.plainOfHtml = untrack(() => draft.text);
    this.followDraft();
    onMount(() => this.placeCaret());
  }

  /** The letter's text follows its format: the plain parts, or the HTML, or the draft's own. */
  private followDraft() {
    $effect(() => {
      if (this.format === "html") return;
      const text = this.head + sigBlock(this.signature) + this.quote;
      if (untrack(() => this.host.win.draft.text) !== text) this.host.win.draft.text = text;
    });
    $effect(() => {
      if (this.format !== "html") return;
      const html = this.htmlBody;
      untrack(() => {
        const { draft } = this.host.win;
        if (draft.html !== html) draft.html = html;
        // The block was deleted with the text around it: the letter has no signature now.
        if (this.signature && !hasHtmlSignature(html)) this.signature = null;
        this.plainOfHtml = this.plainOf(html);
        if (draft.text !== this.plainOfHtml) draft.text = this.plainOfHtml;
      });
    });
    // A plugin may set the text as a whole: split it again.
    $effect(() => {
      const text = this.host.win.draft.text;
      untrack(() => {
        if (this.format !== "html") {
          if (this.head + sigBlock(this.signature) + this.quote !== text) {
            const p = splitPlain(text);
            this.head = p.body;
            this.quote = p.rest;
            this.signature = signatureIn({ ...this.host.win.draft, format: this.format, text }, this.signatures);
          }
        } else if (text !== this.plainOfHtml) {
          this.plainOfHtml = text;
          this.htmlBody = textToHtml(text);
        }
      });
    });
    // With a signature under it, the plain field is as tall as its text, so the signature
    // stands right under the words and the area scrolls; without one it fills the area.
    $effect(() => {
      void this.head;
      void this.areaWidth;
      const field = this.body;
      if (!field) return;
      if (this.format === "html" || !this.signature) {
        field.style.removeProperty("height");
        return;
      }
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight}px`;
    });
    this.followPreview();
  }

  /** Markdown shown as it will look: rendered by the backend as the letter is being typed. */
  private followPreview() {
    $effect(() => {
      if (!this.preview || this.format !== "markdown") return;
      const text = this.host.win.draft.text;
      api
        .markdownHtml(text)
        .then((html) => (this.previewHtml = cleanEditorHtml(html)))
        .catch((e) => this.host.fail(e));
    });
  }

  /**
   * Replies start typing above the quote and signature. Once, when the window opens:
   * an effect would rerun on every keystroke and throw the caret back to the start.
   */
  private placeCaret() {
    const { draft } = this.host.win;
    if (this.format === "html") {
      if (draft.to.length && this.htmlBody.startsWith(GAP)) {
        this.placed = true;
        this.rich?.focus(true);
      }
      return;
    }
    const field = this.body;
    if (!field) return;
    if (draft.text.startsWith("\n\n") && draft.to.length) {
      this.placed = true;
      field.focus();
      field.setSelectionRange(0, 0);
    }
    field.scrollTop = 0;
    requestAnimationFrame(() => (field.scrollTop = 0));
  }

  /** The window's format: the draft says, plain text when it does not. */
  get format(): BodyFormat {
    return this.host.win.draft.format ?? "plain";
  }

  /** The first line of the quote, shown on the folded bar. */
  get quoteHeader(): string {
    return this.quote.trim().split("\n")[0] ?? "";
  }

  /** The mailbox's signatures in the settings; a letter's own window has no settings. */
  get signatureSettings(): (() => void) | undefined {
    return this.host.windowOf === null ? () => this.host.openSettings(`account:${this.host.win.account_id}`, "letters") : undefined;
  }

  private plainOf(html: string): string {
    const split = splitHtmlQuote(html);
    if (split.quote !== this.quoteText.html) this.quoteText = { html: split.quote, text: htmlToText(split.quote) };
    return letterText(split.head, this.quoteText.text);
  }

  insertText(text: string) {
    if (this.format === "html") return this.rich?.insertText(text);
    const at = this.body ? this.body.selectionStart : 0;
    this.head = this.head.slice(0, at) + text + this.head.slice(at);
    queueMicrotask(() => {
      this.body?.focus();
      this.body?.setSelectionRange(at + text.length, at + text.length);
    });
  }

  onBodyFocus() {
    if (this.placed || !this.body) return;
    this.placed = true;
    if (this.host.win.draft.text.startsWith("\n\n")) this.body.setSelectionRange(0, 0);
  }

  /** Puts this signature under the letter in place of the one it has; none takes it away. */
  putSignature(sig: Signature | null) {
    this.signature = sig;
    if (this.format === "html") this.htmlBody = putSignatureHtml(this.htmlBody, sig);
  }

  /** Another sender: its default signature, even over one chosen by hand. */
  setAccount(id: string) {
    const acc = this.host.account(id);
    if (!acc) return;
    this.putSignature(defaultSignature(acc));
    this.host.win.account_id = id;
    this.host.win.draft.from = { name: acc.display_name, email: acc.email };
  }

  /** Rewrites the letter in another format; the settings stay as they are. */
  async setFormat(next: BodyFormat) {
    const win = this.host.win;
    if (next === this.format || this.switching) return;
    let current = $state.snapshot(win.draft) as ComposeDraft;
    if (losesFormatting(current, next)) {
      if (!(await this.host.confirmToPlain())) return;
    }
    this.switching = true;
    try {
      if (this.format === "html" && next === "markdown") {
        // Markdown has no pictures inside: take the letter's own; the signature keeps its.
        const { html, pictures } = takeBodyPictures(current.html ?? "");
        if (pictures.length) {
          if (!(await this.host.confirmPicturesAttach())) return;
          let n = win.draft.attachments.length;
          for (const p of pictures) {
            const name = pictureName(p.mime, ++n);
            const path = await api.tempAttachment(name, p.base64);
            win.draft.attachments.push({ kind: "file", path, name, size: Math.floor((p.base64.length * 3) / 4) });
          }
          current = { ...current, html };
        }
      }
      this.preview = false;
      const d = await convertDraft(current, next, $state.snapshot(this.signature) as Signature | null, (text) => api.markdownHtml(text));
      if (d.format === "html") {
        this.htmlBody = d.html ?? "";
        this.plainOfHtml = d.text;
      } else {
        const p = d.parts ?? splitPlain(d.text);
        this.head = p.body;
        this.quote = p.rest;
      }
      win.draft.html = d.html ?? null;
      win.draft.text = d.text;
      win.draft.format = d.format;
    } catch (e) {
      this.host.fail(e);
    } finally {
      this.switching = false;
    }
  }
}
