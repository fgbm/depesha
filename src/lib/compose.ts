// Building replies and forwards from an opened message. Pure functions, covered by compose.test.ts.

import { addrFull, shortDateTime } from "./format";
import { t } from "./i18n.svelte";
import {
  GAP,
  QUOTE_CLASS,
  QUOTE_STYLE,
  SIGNATURE_CLASS,
  escapeHtml,
  findBlock,
  hasFormatting,
  htmlLetterText,
  htmlToMarkdown,
  htmlToText,
  removeBlock,
  splitHtmlQuote,
  textToHtml,
} from "./richtext";
import type { Account, Addr, AttachmentSource, BodyFormat, ComposeDraft, OpenedMessage, Settings } from "./types";

export function emptyDraft(from: Addr | null, format: BodyFormat = "plain"): ComposeDraft {
  return {
    from,
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    text: "",
    html: format === "html" ? "" : null,
    format,
    in_reply_to: null,
    references: [],
    attachments: [],
  };
}

/** How a new letter from this mailbox is written: its own choice, else the settings'. */
export function formatFor(account: Pick<Account, "compose_format"> | undefined, settings: Pick<Settings, "compose_format">): BodyFormat {
  return account?.compose_format ?? settings.compose_format ?? "plain";
}

/** An HTML letter with its plain version brought up to date. */
function withHtml(d: ComposeDraft, html: string): ComposeDraft {
  return { ...d, html, text: htmlLetterText(html) };
}

const REPLY_PREFIX = /^\s*(re|ответ|отв|aw|sv)\s*(\[\d+\])?\s*:/i;
const FWD_PREFIX = /^\s*(fwd?|пересл|tr|wg)\s*:/i;

export function replySubject(subject: string): string {
  return REPLY_PREFIX.test(subject) ? subject : `Re: ${subject}`;
}

export function isForward(subject: string): boolean {
  return FWD_PREFIX.test(subject);
}

export function forwardSubject(subject: string): string {
  return FWD_PREFIX.test(subject) ? subject : `Fwd: ${subject}`;
}

function same(a: Addr, b: Addr): boolean {
  return a.email.toLowerCase() === b.email.toLowerCase();
}

function uniq(list: Addr[], exclude: Addr[]): Addr[] {
  const out: Addr[] = [];
  for (const a of list) {
    if (exclude.some((e) => same(e, a)) || out.some((o) => same(o, a))) continue;
    out.push(a);
  }
  return out;
}

function wrote(msg: OpenedMessage): string {
  const s = msg.view.summary;
  const who = s.from ? addrFull(s.from) : "";
  return t("compose.wrote", { date: shortDateTime(s.date ?? msg.row.date), who });
}

function quoted(msg: OpenedMessage): string {
  const body = (msg.view.text ?? "").replace(/\r\n/g, "\n").trimEnd();
  return `\n\n${wrote(msg)}\n${body
    .split("\n")
    .map((l) => (l.startsWith(">") ? `>${l}` : `> ${l}`))
    .join("\n")}\n`;
}

/**
 * The letter's own HTML for quoting or forwarding, as the reader showed it: its pictures
 * came inside it and go back the same way, as parts of the answer.
 */
function letterHtml(msg: OpenedMessage): string {
  if (msg.view.html) return msg.view.html;
  return textToHtml((msg.view.text ?? "").replace(/\r\n/g, "\n").trimEnd());
}

/** The quote of an HTML reply, with the original's formatting. */
function quotedHtml(msg: OpenedMessage): string {
  return `<div class="${QUOTE_CLASS}"><div>${escapeHtml(wrote(msg))}</div><blockquote style="${QUOTE_STYLE}">${letterHtml(msg)}</blockquote></div>`;
}

function threading(msg: OpenedMessage): Pick<ComposeDraft, "in_reply_to" | "references"> {
  const s = msg.view.summary;
  const id = s.message_id ?? msg.row.message_id;
  const refs = [...(s.references ?? [])];
  if (id && !refs.includes(id)) refs.push(id);
  return { in_reply_to: id, references: refs };
}

/** `me` is the address of the account that replies; it never ends up among recipients. */
export function reply(msg: OpenedMessage, me: Addr, all: boolean, format: BodyFormat = "plain"): ComposeDraft {
  const s = msg.view.summary;
  const fromMe = s.from && same(s.from, me);
  // Replying to my own sent message goes to its recipients.
  let to = fromMe ? s.to : s.reply_to.length ? s.reply_to : s.from ? [s.from] : [];
  let cc: Addr[] = [];
  if (all) {
    cc = uniq([...(fromMe ? [] : s.to), ...s.cc], [...to, me]);
  }
  to = uniq(to, fromMe ? [] : [me]);
  const draft = {
    ...emptyDraft(me, format),
    to,
    cc,
    subject: replySubject(s.subject),
    text: quoted(msg),
    ...threading(msg),
  };
  return format === "html" ? withHtml(draft, GAP + quotedHtml(msg)) : draft;
}

function forwardHeader(msg: OpenedMessage): string[] {
  const s = msg.view.summary;
  return [
    t("compose.fwd.header"),
    `${t("compose.fwd.subject")}: ${s.subject}`,
    `${t("compose.fwd.date")}: ${shortDateTime(s.date ?? msg.row.date)}`,
    s.from ? `${t("compose.fwd.from")}: ${addrFull(s.from)}` : "",
    s.to.length ? `${t("compose.fwd.to")}: ${s.to.map(addrFull).join(", ")}` : "",
    s.cc.length ? `${t("compose.fwd.cc")}: ${s.cc.map(addrFull).join(", ")}` : "",
  ].filter(Boolean);
}

export function forward(msg: OpenedMessage, me: Addr, format: BodyFormat = "plain"): ComposeDraft {
  const s = msg.view.summary;
  const lines = ["", "", ...forwardHeader(msg), "", (msg.view.text ?? "").replace(/\r\n/g, "\n").trimEnd(), ""];
  const attachments: AttachmentSource[] = msg.view.attachments
    .filter((a) => !(a.inline && a.content_id))
    .map((a) => ({ kind: "message", id: msg.row.id, index: a.index, name: a.name, size: a.size }));
  // Threaded like a reply: the forward stays in the conversation it came from.
  const draft = { ...emptyDraft(me, format), subject: forwardSubject(s.subject), text: lines.join("\n"), attachments, ...threading(msg) };
  if (format !== "html") return draft;
  // The forwarded letter folds like a quote: it is the same kind of block.
  const header = forwardHeader(msg).map(escapeHtml).join("<br>");
  return withHtml(draft, `${GAP}<div class="${QUOTE_CLASS}"><div>${header}</div><br>${letterHtml(msg)}</div>`);
}

/** Opens a server draft for editing. */
export function fromDraft(msg: OpenedMessage, me: Addr): ComposeDraft {
  const s = msg.view.summary;
  const attachments: AttachmentSource[] = msg.view.attachments
    .filter((a) => !(a.inline && a.content_id))
    .map((a) => ({ kind: "message", id: msg.row.id, index: a.index, name: a.name, size: a.size }));
  const text = (msg.view.text ?? "").replace(/\r\n/g, "\n");
  // Depesha's drafts say how they were written; another client's HTML draft stays HTML.
  const format: BodyFormat = msg.view.format ?? (msg.view.html ? "html" : "plain");
  const html = format === "html" ? (msg.view.html ?? textToHtml(text)) : null;
  return {
    from: me,
    to: s.to.filter((a) => !same(a, me) || s.to.length > 1 || s.cc.length > 0),
    cc: s.cc,
    bcc: [],
    subject: s.subject,
    text: html !== null ? htmlLetterText(html) : text,
    html,
    format,
    in_reply_to: s.in_reply_to,
    references: s.references,
    attachments,
    // A time already past is no schedule: the letter waited as a draft.
    send_at: msg.view.send_at && msg.view.send_at * 1000 > Date.now() ? msg.view.send_at : null,
  };
}

/**
 * Splits a reply into what is typed and the quote under it: the "… wrote:" line and the
 * ">" lines after it, to the end. `head + quote` is the text again; no quote, all is head.
 */
export function splitQuote(text: string): { head: string; quote: string } {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const header = line.trim() !== "" && !line.startsWith(">") && line.trimEnd().endsWith(":") && lines[i + 1].startsWith(">");
    if (header && lines.slice(i + 1).every((l) => l.startsWith(">") || l.trim() === "")) {
      // The empty lines above the header go with the quote.
      let start = offset;
      while (start > 0 && text[start - 1] === "\n") start--;
      return { head: text.slice(0, start), quote: text.slice(start) };
    }
    offset += line.length + 1;
  }
  return { head: text, quote: "" };
}

/** Something worth keeping was typed; an untouched signature does not count. */
export function isDirty(d: ComposeDraft, signature?: string): boolean {
  let text: string;
  if (d.format === "html") {
    text = htmlToText(withoutSignature(d.html ?? "", signature) ?? d.html ?? "");
  } else {
    const block = sigBlock(signature);
    text = block ? d.text.replace(block, "") : d.text;
  }
  return d.to.length + d.cc.length + d.bcc.length + d.attachments.length > 0 || d.subject.trim() !== "" || text.trim() !== "";
}

/** Signature block with the standard "-- " separator (RFC 3676), or nothing. */
export function sigBlock(signature: string | undefined): string {
  const sig = (signature ?? "").trim();
  return sig ? `\n\n-- \n${sig}` : "";
}

/**
 * The signature of an HTML letter: a block of its own, found again to be replaced.
 * Formatted signatures (#25) go into the same block.
 */
export function sigHtml(signature: string | undefined): string {
  const sig = (signature ?? "").trim();
  return sig ? `<div class="${SIGNATURE_CLASS}">-- <br>${sig.split("\n").map(escapeHtml).join("<br>")}</div>` : "";
}

/** The HTML without its signature block, if the block is the signature as it was put in; null otherwise. */
function withoutSignature(html: string, signature: string | undefined): string | null {
  const b = findBlock(html, SIGNATURE_CLASS);
  if (!b || htmlToText(html.slice(b.start, b.end)).trim() !== htmlToText(sigHtml(signature)).trim()) return null;
  return html.slice(0, b.start) + html.slice(b.end);
}

/** Puts an HTML block above the quote, or at the end when there is none. */
function aboveQuote(html: string, block: string): string {
  const q = findBlock(html, QUOTE_CLASS);
  return q ? html.slice(0, q.start) + block + html.slice(q.start) : html + block;
}

/** Adds the signature: at the end of a new message, above the quote in replies and forwards. */
export function withSignature(draft: ComposeDraft, signature: string | undefined): ComposeDraft {
  if (draft.format === "html") {
    const block = sigHtml(signature);
    if (!block) return draft;
    const html = draft.html?.trim() ? draft.html : GAP;
    return withHtml(draft, aboveQuote(html, block));
  }
  const block = sigBlock(signature);
  if (!block) return draft;
  return { ...draft, text: draft.text.startsWith("\n\n") ? block + draft.text : draft.text + block };
}

/** Replaces one account's signature with another's when the sender changes. */
export function swapSignature(text: string, from: string | undefined, to: string | undefined): string {
  const oldBlock = sigBlock(from);
  const newBlock = sigBlock(to);
  if (oldBlock && text.includes(oldBlock)) return text.replace(oldBlock, newBlock);
  if (!newBlock) return text;
  const quote = text.search(/\n\n[^\n]*(пишет:|wrote:|-------- Пересылаемое сообщение|-------- Forwarded message)/);
  return quote >= 0 ? text.slice(0, quote) + newBlock + text.slice(quote) : text + newBlock;
}

/** The same for an HTML letter: an edited signature stays, as in plain text. */
export function swapSignatureHtml(html: string, from: string | undefined, to: string | undefined): string {
  const rest = withoutSignature(html, from);
  const block = sigHtml(to);
  if (rest !== null) {
    const at = findBlock(html, SIGNATURE_CLASS)?.start ?? rest.length;
    return rest.slice(0, at) + block + rest.slice(at);
  }
  return block ? aboveQuote(html, block) : html;
}

/** A letter split into what is typed, whether the signature is under it, and the quote. */
interface Parts {
  body: string;
  signed: boolean;
  quote: string;
}

function partsOf(d: ComposeDraft, signature: string | undefined): Parts {
  if (d.format === "html") {
    const { head, quote } = splitHtmlQuote(d.html ?? "");
    const rest = withoutSignature(head, signature);
    return { body: rest ?? head, signed: rest !== null, quote };
  }
  const { head, quote } = splitQuote(d.text);
  const block = sigBlock(signature);
  const signed = !!block && head.includes(block);
  return { body: signed ? head.replace(block, "") : head, signed, quote };
}

/**
 * Switching an HTML letter to plain text loses its formatting, links and pictures: worth
 * asking first, unless there is none. Markdown is plain text already and goes without asking.
 */
export function losesFormatting(d: ComposeDraft, to: BodyFormat): boolean {
  return to === "plain" && d.format === "html" && hasFormatting(d.html ?? "");
}

/**
 * The letter in another format. What is typed is converted, the signature is put
 * again in the new format, the quote keeps its formatting where the format has it.
 * `markdownHtml` renders Markdown the way the backend sends it.
 */
export async function convertDraft(
  d: ComposeDraft,
  to: BodyFormat,
  signature: string | undefined,
  markdownHtml: (text: string) => Promise<string>,
): Promise<ComposeDraft> {
  const from = d.format ?? "plain";
  if (from === to) return d;
  const { body, signed, quote } = partsOf(d, signature);
  if (to === "html") {
    const html = from === "markdown" ? await markdownHtml(body.trim()) : textToHtml(body.replace(/^\n+/, "").trimEnd());
    const quoteHtml = quote ? `<div class="${QUOTE_CLASS}">${textToHtml(quote.replace(/^\n+/, "").trimEnd())}</div>` : "";
    const head = (body.trim() ? html : GAP) + (signed ? sigHtml(signature) : "");
    return withHtml({ ...d, format: "html" }, head + quoteHtml);
  }
  let text: string;
  let quoteText: string;
  if (from === "html") {
    const convert = to === "markdown" ? htmlToMarkdown : htmlToText;
    text = convert(body).replace(/^\n+/, "").trimEnd();
    quoteText = quote ? `\n\n${htmlToText(quote).replace(/^\n+/, "").trimEnd()}\n` : "";
  } else {
    // Markdown is plain text with meaning: the words stay as they are.
    text = body;
    quoteText = quote;
  }
  return { ...d, format: to, html: null, text: text + (signed ? sigBlock(signature) : "") + quoteText };
}
