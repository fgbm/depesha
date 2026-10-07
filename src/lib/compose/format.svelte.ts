// The body of a composition window: what is typed, the signature under it and the quote
// of a reply, all in the letter's own format. Switching the format rewrites the letter
// (HTML, Markdown or plain text) and the window asks first when the change loses
// something. The state, the effects and the order are the component's of old; the
// window (Compose.svelte) owns the markup and supplies the wording of its dialogs, so
// every `t("…")` of the letter stays in a component.

import { onMount, untrack } from "svelte";
import { api } from "../api";
import { convertDraft, losesFormatting } from "../compose";
import { GAP, QUOTE_CLASS, SIGNATURE_CLASS, htmlHasOwnText, htmlToText, letterText, splitHtmlQuote } from "../richtext";
import { picturesSize, type Picture } from "../images";
import {
  defaultSignature,
  hasHtmlSignature,
  putSignatureHtml,
  replySignature,
  sigBlock,
  sigHtml,
  signatureIn,
  signaturesOf,
  splitPlain,
  withoutHtmlSignature,
} from "../signatures";
import type { ComposeWindow } from "../composes.svelte";
import type { AccountView, BodyFormat, ComposeDraft, Signature } from "../types";
import type RichEditor from "../../components/RichEditor.svelte";
import type FormatBar from "../../components/FormatBar.svelte";
import type { MarkdownField } from "../markdown/types";

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
  /** The format changed: a toast says what was lost and offers to undo (frame 8 of the mockup). */
  formatChanged(from: BodyFormat, to: BodyFormat, undo: () => void): void;
}

/** The pictures of an HTML letter are weighed this long after typing pauses. */
const PICTURES_MS = 300;

/** Depesha's own blocks in the letter: the signature and the quote the words belong above. */
const DEPESHA_BLOCKS = `.${SIGNATURE_CLASS}, .${QUOTE_CLASS}`;

export class ComposeFormat {
  /** A plain letter: the field has what is typed, the signature stands under it, a reply's
   * quote or the forwarded letter stays folded below. The draft keeps the whole text. */
  head = $state("");
  quote = $state("");
  quoteOpen = $state(false);
  /** An HTML letter is one editor: the quote of a reply stands in it, under the signature. */
  htmlBody = $state("");
  /** "Markup": every mark of a Markdown letter shown at once. */
  markup = $state(false);
  /** The editor and the formatting row of this window, as the markup binds them. */
  rich = $state<RichEditor | null>(null);
  bar = $state<FormatBar | null>(null);
  /** The field of a plain letter, or the Markdown editor, as the markup binds it. */
  body = $state<HTMLTextAreaElement | MarkdownField | null>(null);
  /** The width of the body area: a plain letter with a signature grows with its text. */
  areaWidth = $state(0);

  /** The mailbox's signatures, to choose from on the signature block. */
  readonly signatures: Signature[];
  /** Files and the pictures in the text and the signature: all travel in the letter. */
  pictures = $state(0);
  /** The signature's own pictures alone do not bring up the row of files. */
  textPictures = $state(0);
  /** The signature under the letter: one of the mailbox's, a draft's own, or none. A block
   * of its own, never edited in the letter: only put whole, swapped or taken away. */
  signature = $state<Signature | null>(null);

  private host: ComposeFormatHost;
  /** The plain version last made of the HTML: a different text was set from outside. */
  private plainOfHtml = "";
  /** The quote turned into text once, not on every key: a quoted letter may be long. */
  private quoteText = { html: "", text: "" };
  /** The letter is being rewritten in another format: the body takes no keys meanwhile. */
  switching = $state(false);
  /** Entering the body of a fresh message puts the caret above the signature, once. */
  private placed = false;

  constructor(host: ComposeFormatHost) {
    this.host = host;
    this.signatures = $derived(signaturesOf(host.account(host.win.account_id)));
    const { draft } = host.win;
    this.signature = untrack(() => signatureIn(draft, signaturesOf(host.account(host.win.account_id))));
    const parts = untrack(() => splitPlain(draft.text));
    this.head = parts.body;
    this.quote = parts.rest;
    this.htmlBody = untrack(() => draft.html ?? "");
    this.plainOfHtml = untrack(() => draft.text);
    this.followDraft();
    this.followPictures();
    onMount(() => this.placeCaret());
    // The Markdown editor comes in a chunk of its own, after the window: the caret waits for it.
    $effect(() => {
      if (this.body && "apply" in this.body && !this.placed) untrack(() => this.placeCaret());
    });
  }

  /**
   * What the pictures weigh walks the whole HTML, megabytes with photos in it: weighed
   * when the window opens and then once typing pauses, not on every key.
   */
  private followPictures() {
    let first = true;
    $effect(() => {
      const html = this.format === "html" ? this.htmlBody : "";
      const weigh = () => {
        this.pictures = picturesSize(html);
        this.textPictures = this.pictures > 0 ? picturesSize(withoutHtmlSignature(html)) : 0;
      };
      if (first) {
        first = false;
        untrack(weigh);
        return;
      }
      const timer = setTimeout(weigh, PICTURES_MS);
      return () => clearTimeout(timer);
    });
  }

  /** The letter's text follows its format: the plain parts, or the HTML, or the draft's own. */
  private followDraft() {
    $effect(() => {
      if (this.format === "html") return;
      const text = this.head + sigBlock(this.signature) + this.quote;
      if (untrack(() => this.host.win.draft.text) !== text) this.host.win.draft.text = text;
    });
    // A Markdown letter carries its signature's HTML apart (decision on #67): the window
    // shows it formatted and the backend builds the letter's HTML and Markdown parts from it.
    $effect(() => {
      const sig = this.format === "markdown" && this.signature ? sigHtml(this.signature) || null : null;
      untrack(() => {
        if ((this.host.win.draft.signature ?? null) !== sig) this.host.win.draft.signature = sig;
      });
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
    // A plugin may set the text as a whole: split it again. An HTML letter's text is only
    // its plain version: rebuilt from it, the letter would lose its pictures, links and
    // signature block, so the text goes back to what the HTML says.
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
          this.host.win.draft.text = this.plainOfHtml;
        }
      });
    });
    // With a signature under it, the plain field is as tall as its text, so the signature
    // stands right under the words and the area scrolls; without one it fills the area.
    $effect(() => {
      void this.head;
      void this.areaWidth;
      const field = this.body;
      // The Markdown editor grows with its text by itself.
      if (!field || !("style" in field)) return;
      if (this.format === "html" || !this.signature) {
        field.style.removeProperty("height");
        return;
      }
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight}px`;
    });
  }

  /**
   * Replies start typing above the quote and signature. Once, when the window opens:
   * an effect would rerun on every keystroke and throw the caret back to the start.
   */
  private placeCaret() {
    const { draft } = this.host.win;
    if (this.format === "html") {
      // A fresh reply or a new letter begins with the empty line above the signature:
      // the caret goes to the top. Unfolded from the quick answer the words already stand
      // there, so the caret goes into that empty line instead, the signature staying below (#61).
      if (this.htmlBody.startsWith(GAP)) {
        if (draft.to.length) {
          this.placed = true;
          this.rich?.focus(true);
        }
      } else if (this.host.win.unsaved && draft.to.length) {
        // Words already typed over the block the reply keeps below: put the caret in the
        // empty line above it, signature or quote, not at the very top and not at the end (#61).
        this.placed = true;
        this.rich?.focusBefore(DEPESHA_BLOCKS);
      }
      return;
    }
    const field = this.body;
    if (!field) return;
    if (draft.text.startsWith("\n\n") && draft.to.length) {
      this.placed = true;
      field.focus();
      field.setSelectionRange(0, 0);
    } else if (this.host.win.unsaved && draft.to.length) {
      // Unfolded from the quick answer with words already typed: plain text and Markdown
      // keep the signature in its own block under the field, so the caret goes to the end
      // of the words, right above it (#61).
      this.placed = true;
      field.focus();
      field.setSelectionRange(this.head.length, this.head.length);
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

  /**
   * Whether the letter has words of its own yet: the signature and the quote aside, and
   * blank lines counting for nothing. The format rule of #44 takes the letter over
   * silently only while this is false (frame 12А).
   */
  get hasOwnText(): boolean {
    return this.format === "html" ? htmlHasOwnText(this.htmlBody) : this.head.trim().length > 0;
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

  /**
   * Pictures into the letter's text. In Markdown they go in as `![alt](data:image/…)` on a
   * line of their own (decision on #45, frame 9): Depesha's own reader shows them, and on the
   * way out the backend turns them into `multipart/related` parts. In HTML the editor puts
   * them in as `data:` images and this returns false; the caller falls back to that.
   */
  insertPictures(pictures: Picture[]): boolean {
    if (this.format !== "markdown" || !this.body || !("apply" in this.body)) return false;
    const field = this.body;
    for (const p of pictures) {
      const url = `data:${p.mime};base64,${p.base64}`;
      field.picture(url, "");
    }
    return true;
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

  /**
   * Another sender: its default signature, even over one chosen by hand. A reply takes the
   * mailbox's reply signature — `in_reply_to` is what tells a reply or a forward from a new
   * letter, since only those two carry it.
   */
  setAccount(id: string) {
    const acc = this.host.account(id);
    if (!acc) return;
    this.putSignature(this.host.win.draft.in_reply_to ? replySignature(acc) : defaultSignature(acc));
    this.host.win.account_id = id;
    this.host.win.draft.from = { name: acc.display_name, email: acc.email };
  }

  /** Asks what the switch to this format would lose; false when the user said no. */
  private async confirmSwitch(next: BodyFormat): Promise<boolean> {
    const draft = $state.snapshot(this.host.win.draft) as ComposeDraft;
    if (losesFormatting(draft, next) && !(await this.host.confirmToPlain())) return false;
    // Markdown keeps pictures in the text now (decision on #45, frame 8): nothing to ask.
    return true;
  }

  /** Rewrites the letter in another format; the settings stay as they are. */
  async setFormat(next: BodyFormat) {
    const win = this.host.win;
    if (next === this.format || this.switching) return;
    this.switching = true;
    try {
      if (!(await this.confirmSwitch(next))) return;
      const current = $state.snapshot(win.draft) as ComposeDraft;
      const from = this.format;
      const before = { ...current, attachments: [...current.attachments] };
      this.markup = false;
      const d = await convertDraft(current, next, $state.snapshot(this.signature) as Signature | null, (text) => api.markdownHtml(text));
      // Attached once the letter is rewritten: a failure leaves the pictures in its text alone.
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
      win.draft.signature = d.signature ?? null;
      win.draft.format = d.format;
      // Frame 8 of the 0.7 mockup: only HTML → text asks first (in `confirmSwitch`); any
      // other change is undone by a toast that names what was lost, or by Ctrl+Z.
      this.host.formatChanged(from, d.format ?? next, () => this.restore({ ...before, parts: d.parts }));
    } catch (e) {
      this.host.fail(e);
    } finally {
      this.switching = false;
    }
  }

  /** The letter back as it was before a format change, whole, signature and pictures. */
  private restore(d: ComposeDraft & { parts?: { body: string; rest: string } }) {
    const win = this.host.win;
    win.draft.html = d.html ?? null;
    win.draft.text = d.text;
    win.draft.signature = d.signature ?? null;
    win.draft.format = d.format;
    win.draft.attachments = d.attachments;
    if (d.format === "html") {
      this.htmlBody = d.html ?? "";
      this.plainOfHtml = d.text;
    } else {
      const p = d.parts ?? splitPlain(d.text);
      this.head = p.body;
      this.quote = p.rest;
    }
    this.signature = signatureIn({ ...win.draft, format: d.format, text: d.text }, this.signatures);
  }
}
