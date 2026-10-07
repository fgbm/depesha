// A mailbox's signatures (#25): the list kept in its settings, and the signature in a
// letter, a block of its own under the text that is put in whole, swapped or taken away,
// never edited there. Pure functions, covered by signatures.test.ts.

import { GAP, QUOTE_CLASS, SIGNATURE_CLASS, findBlock, htmlLetterText, htmlToText, splitHtmlQuote, textToHtml } from "./richtext";
import { picturesSize } from "./images";
import { splitQuote } from "./quote";
import type { Account, BodyFormat, ComposeDraft, Signature } from "./types";

/** Pictures of a signature heavier than this weigh on every letter: the editor says so. */
export const SIGNATURE_WARN = 200 * 1024;

export function signaturesOf(acc: Pick<Account, "signatures"> | undefined | null): Signature[] {
  return acc?.signatures ?? [];
}

/** The signature new letters of the mailbox get, or none. */
export function defaultSignature(acc: Pick<Account, "signatures" | "default_signature"> | undefined | null): Signature | null {
  if (!acc?.default_signature) return null;
  return signaturesOf(acc).find((s) => s.id === acc.default_signature) ?? null;
}

/**
 * The signature replies and forwards of the mailbox get: the reply one when it is set,
 * else the plain default (the behaviour before replies had one of their own). A reply
 * signature that is gone reads as "not set", so a removed signature never breaks a choice.
 */
export function replySignature(
  acc: Pick<Account, "signatures" | "default_signature" | "reply_signature"> | undefined | null,
): Signature | null {
  if (!acc?.reply_signature) return defaultSignature(acc);
  return signaturesOf(acc).find((s) => s.id === acc.reply_signature) ?? defaultSignature(acc);
}

/** What the pictures of a signature weigh: they go with every letter. */
export function signatureSize(html: string): number {
  return picturesSize(html);
}

/** Heavy enough to say so in the editor; it does not stop saving. */
export function isHeavy(html: string): boolean {
  return signatureSize(html) > SIGNATURE_WARN;
}

/** The version for letters in plain text and Markdown: text, links with addresses, no pictures. */
export function signatureText(html: string): string {
  return htmlToText(html).trim();
}

/** The signature in one line, for the list in the settings. */
export function previewLine(sig: Signature): string {
  return sig.text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" · ");
}

// The list in the settings.

/** An id not used in the list yet. */
export function newSignatureId(list: Signature[]): string {
  let n = list.length + 1;
  while (list.some((s) => s.id === `s${n}`)) n++;
  return `s${n}`;
}

/** The list and its two defaults after one change. */
export interface SignatureList {
  list: Signature[];
  defaultId: string | null;
  /** The id replies and forwards get; none takes `defaultId`. */
  replyId: string | null;
}

/** A new empty signature at the end; the only one is the default. */
export function addSignature(state: SignatureList, name: string): SignatureList & { id: string } {
  const id = newSignatureId(state.list);
  const list = [...state.list, { id, name, html: "", text: "" }];
  return { list, defaultId: state.defaultId ?? id, replyId: state.replyId, id };
}

/**
 * Takes one away; when it was the default, the first one left becomes it. A reply
 * signature that is gone becomes "not set", so replies fall back to the plain default.
 */
export function removeSignature(state: SignatureList, id: string): SignatureList {
  const list = state.list.filter((s) => s.id !== id);
  const defaultId = state.defaultId === id || !list.some((s) => s.id === state.defaultId) ? (list[0]?.id ?? null) : state.defaultId;
  const replyId = list.some((s) => s.id === state.replyId) ? state.replyId : null;
  return { list, defaultId, replyId };
}

/** Moves one up (-1) or down (+1); at an end it stays. */
export function moveSignature(list: Signature[], id: string, delta: -1 | 1): Signature[] {
  const i = list.findIndex((s) => s.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

// The signature in a letter.

/** A plain letter's signature: after the standard "-- " separator (RFC 3676), or nothing. */
export function sigBlock(sig: Pick<Signature, "text"> | null | undefined): string {
  const text = (sig?.text ?? "").trim();
  return text ? `\n\n-- \n${text}` : "";
}

/** The signature as a block of a letter: an HTML letter's, found again to be swapped, and a
 *  Markdown letter's, whose parts the backend builds from it (#67). */
export function sigHtml(sig: Pick<Signature, "html"> | null | undefined): string {
  const html = (sig?.html ?? "").trim();
  return html ? `<div class="${SIGNATURE_CLASS}">${html}</div>` : "";
}

/**
 * What stands under the letter's text in the window: an HTML or Markdown letter shows the
 * signature formatted, with its pictures (frame 13 of #45, #67); a plain one its text under
 * "-- ". `null` when the letter has none to show. Never edited there, only put or swapped.
 */
export function signatureShown(format: BodyFormat | undefined, sig: Signature | null): { html: string } | { text: string } | null {
  if (!sig) return null;
  if (format === "html" || format === "markdown") {
    const html = sig.html.trim();
    return html ? { html } : null;
  }
  return { text: sigBlock(sig).replace(/^\n\n/, "") };
}

const FORWARD_HEADER = /(^|\n\n)[^\n]*(-------- Пересылаемое сообщение|-------- Forwarded message)/;

/**
 * A plain letter as what is typed, the signature under it and what follows: the quote
 * of a reply or the forwarded letter, from the empty lines before its header to the end.
 * `body + "\n\n-- \n" + signature + rest` is the letter again, or `body + rest` without one.
 */
export function splitPlain(text: string): { body: string; signature: string | null; rest: string } {
  const reply = splitQuote(text);
  const fwd = FORWARD_HEADER.exec(reply.head);
  let at = fwd ? fwd.index : reply.head.length;
  // The empty lines above the header go with it.
  if (fwd) while (at > 0 && text[at - 1] === "\n") at--;
  const head = text.slice(0, at);
  const rest = text.slice(at);
  const sep = head.lastIndexOf("\n\n-- \n");
  if (sep >= 0) return { body: head.slice(0, sep), signature: head.slice(sep + 6), rest };
  if (head.startsWith("-- \n")) return { body: "", signature: head.slice(4), rest };
  return { body: head, signature: null, rest };
}

/** The HTML above the quote and the signature block in it, if there is one. */
function htmlBlock(html: string): { start: number; end: number; inner: string; block: string } | null {
  const { head } = splitHtmlQuote(html);
  const b = findBlock(head, SIGNATURE_CLASS);
  if (!b) return null;
  const block = head.slice(b.start, b.end);
  const inner = block.slice(block.indexOf(">") + 1).replace(/<\/div\s*>$/i, "");
  return { ...b, inner, block };
}

/**
 * An HTML letter with its signature block marked off: what is above it, the block, and
 * what follows. Used to keep the signature's own pictures out of the letter's.
 */
export function splitHtmlSignature(html: string): { lead: string; sigBlock: string; rest: string } {
  const b = htmlBlock(html);
  return b ? { lead: html.slice(0, b.start), sigBlock: b.block, rest: html.slice(b.end) } : { lead: html, sigBlock: "", rest: "" };
}

export function hasHtmlSignature(html: string): boolean {
  return htmlBlock(html) !== null;
}

/** An HTML letter without its signature block. */
export function withoutHtmlSignature(html: string): string {
  const b = htmlBlock(html);
  return b ? html.slice(0, b.start) + html.slice(b.end) : html;
}

/** Puts an HTML block above the quote, or at the end when there is none. */
function aboveQuote(html: string, block: string): string {
  const q = findBlock(html, QUOTE_CLASS);
  return q ? html.slice(0, q.start) + block + html.slice(q.start) : html + block;
}

/** The HTML letter with this signature in place of the one it had; none takes it away. */
export function putSignatureHtml(html: string, sig: Signature | null): string {
  const block = sigHtml(sig);
  const b = htmlBlock(html);
  if (b) return html.slice(0, b.start) + block + html.slice(b.end);
  if (!block) return html;
  return aboveQuote(html.trim() ? html : GAP, block);
}

/** The plain letter with this signature in place of the one it had; none takes it away. */
export function putSignatureText(text: string, sig: Signature | null): string {
  const { body, rest } = splitPlain(text);
  return body + sigBlock(sig) + rest;
}

/** The letter with this signature: at the end of a new one, above the quote in replies and forwards. */
export function withSignature(draft: ComposeDraft, sig: Signature | null): ComposeDraft {
  if (draft.format === "html") {
    if (!sigHtml(sig)) return draft;
    const html = putSignatureHtml(draft.html?.trim() ? draft.html : GAP, sig);
    return { ...draft, html, text: htmlLetterText(html) };
  }
  if (draft.format === "markdown") {
    // The text keeps the plain version (what goes out as text and Markdown), the HTML goes
    // apart: the window shows it formatted and the backend builds the HTML part from it (#67).
    const html = sigHtml(sig);
    if (!html && !sigBlock(sig)) return { ...draft, signature: null, text: putSignatureText(draft.text, null) };
    return { ...draft, signature: html || null, text: putSignatureText(draft.text, sig) };
  }
  if (!sigBlock(sig)) return draft;
  return { ...draft, text: putSignatureText(draft.text, sig) };
}

/** The signature the letter itself carries, as a `Signature`, or none. */
function foundSignature(draft: ComposeDraft): Signature | null {
  if (draft.format === "html") {
    const b = htmlBlock(draft.html ?? "");
    if (!b) return null;
    // As the plain part has it: a letter before #25 wrote "-- " into the block itself.
    return { id: "", name: "", html: b.inner, text: htmlToText(b.block).replace(/^-- \n/, "").trim() };
  }
  const text = splitPlain(draft.text).signature;
  return text === null ? null : { id: "", name: "", html: textToHtml(text.trim()), text: text.trim() };
}

/**
 * Which of the mailbox's signatures the letter has: the one with the same words, or — for
 * one without words (a picture alone) — the same HTML. One found in a letter but not among
 * them (changed since, another program's) is kept as it is.
 */
export function signatureIn(draft: ComposeDraft, list: Signature[]): Signature | null {
  const found = foundSignature(draft);
  if (!found) return null;
  // An image-only signature has no words to tell it by: compare its HTML instead.
  if (found.text) return list.find((s) => s.text.trim() === found.text) ?? found;
  return list.find((s) => s.html.trim() === found.html.trim()) ?? found;
}
