// Building replies and forwards from an opened message. Pure functions, covered by compose.test.ts.

import { addrFull, shortDateTime } from "./format";
import { t } from "./i18n.svelte";
import { MAX_PICTURE, PICTURE_TYPES, takePictures, type Picture } from "./images";
import { GAP, QUOTE_CLASS, QUOTE_STYLE, escapeHtml, hasFormatting, htmlLetterText, htmlToMarkdown, htmlToText, splitHtmlQuote, textToHtml } from "./richtext";
import { sigBlock, sigHtml, splitHtmlSignature, splitPlain, withoutHtmlSignature } from "./signatures";
import type { Account, Act, ActsOn, Addr, AttachmentSource, BodyFormat, ComposeDraft, OpenedMessage, Settings, Signature } from "./types";

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

/** The letter an answer or forward is written from: marked when it goes, and maybe taken to wait. */
function actsOn(msg: OpenedMessage, act: Act): ActsOn | null {
  const id = msg.row.message_id ?? msg.view.summary.message_id;
  if (!id) return null;
  const f = msg.row.followup;
  const waiting = f?.status === "waiting" && (f.park === "pending" || f.park === "parked");
  return { account_id: msg.row.account_id, message_id: id, folder: msg.row.folder, act, waiting };
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
    // "All" that reaches nobody else is a reply.
    acts_on: actsOn(msg, all && to.length + cc.length > 1 ? "reply_all" : "reply"),
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

/**
 * A picture of the letter that travels inside a forward's HTML: the reader put it in as
 * a `data:` image (`MAX_INLINE_IMAGE`) and the editor keeps that kind. Any other part goes
 * as a file, or it would be lost.
 */
function forwardedInside(msg: OpenedMessage, a: OpenedMessage["view"]["attachments"][number], format: BodyFormat): boolean {
  if (format !== "html" || !msg.view.html || !a.inline || !a.content_id) return false;
  return PICTURE_TYPES.includes(a.mime.toLowerCase()) && a.size <= MAX_PICTURE;
}

export function forward(msg: OpenedMessage, me: Addr, format: BodyFormat = "plain"): ComposeDraft {
  const s = msg.view.summary;
  const lines = ["", "", ...forwardHeader(msg), "", (msg.view.text ?? "").replace(/\r\n/g, "\n").trimEnd(), ""];
  const attachments: AttachmentSource[] = msg.view.attachments
    .filter((a) => !forwardedInside(msg, a, format))
    .map((a) => ({ kind: "message", id: msg.row.id, index: a.index, name: a.name, size: a.size }));
  // Threaded like a reply: the forward stays in the conversation it came from.
  const draft = { ...emptyDraft(me, format), subject: forwardSubject(s.subject), text: lines.join("\n"), attachments, ...threading(msg), acts_on: actsOn(msg, "forward") };
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

export { splitQuote } from "./quote";

/** Something worth keeping was typed; the signature does not count, it is put in whole. */
export function isDirty(d: ComposeDraft): boolean {
  let text: string;
  if (d.format === "html") {
    text = htmlToText(withoutHtmlSignature(d.html ?? ""));
  } else {
    const { body, rest } = splitPlain(d.text);
    text = body + rest;
  }
  return d.to.length + d.cc.length + d.bcc.length + d.attachments.length > 0 || d.subject.trim() !== "" || text.trim() !== "";
}

/**
 * The letter's own `data:` pictures taken out of its HTML, for a format without pictures
 * inside (Markdown): the signature block's pictures stay in place and go with its text.
 */
export function takeBodyPictures(html: string): { html: string; pictures: Picture[] } {
  const { lead, sigBlock, rest } = splitHtmlSignature(html);
  const above = takePictures(lead);
  const below = takePictures(rest);
  return { html: above.html + sigBlock + below.html, pictures: [...above.pictures, ...below.pictures] };
}

/** A letter split into what is typed and the quote; the signature between them is left out. */
function partsOf(d: ComposeDraft): { body: string; quote: string } {
  if (d.format === "html") {
    const { head, quote } = splitHtmlQuote(d.html ?? "");
    return { body: withoutHtmlSignature(head), quote };
  }
  const { body, rest } = splitPlain(d.text);
  return { body, quote: rest };
}

/**
 * Switching an HTML letter to plain text loses its formatting, links and pictures: worth
 * asking first, unless there is none. Markdown is plain text already and goes without asking.
 * Only what is typed counts: the quote is always a styled block and the signature is put
 * again in the new format's version.
 */
export function losesFormatting(d: ComposeDraft, to: BodyFormat): boolean {
  return to === "plain" && d.format === "html" && hasFormatting(partsOf(d).body);
}

/**
 * The letter in another format. What is typed is converted, the letter's signature
 * (`signature`, the window knows it) is put again in the new format's version, the quote
 * keeps its formatting where the format has it.
 * `markdownHtml` renders Markdown the way the backend sends it.
 * A plain or Markdown letter comes with its `parts`: what is typed and what follows the
 * signature, as the window shows them. Splitting the text again would not always find
 * them: a quote of a picture alone is a "… wrote:" line with no ">" lines.
 */
export async function convertDraft(
  d: ComposeDraft,
  to: BodyFormat,
  signature: Signature | null,
  markdownHtml: (text: string) => Promise<string>,
): Promise<ComposeDraft & { parts?: { body: string; rest: string } }> {
  const from = d.format ?? "plain";
  if (from === to) return d;
  const { body, quote } = partsOf(d);
  if (to === "html") {
    const html = from === "markdown" ? await markdownHtml(body.trim()) : textToHtml(body.replace(/^\n+/, "").trimEnd());
    const quoteHtml = quote ? `<div class="${QUOTE_CLASS}">${textToHtml(quote.replace(/^\n+/, "").trimEnd())}</div>` : "";
    const head = (body.trim() ? html : GAP) + sigHtml(signature);
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
  return { ...d, format: to, html: null, text: text + sigBlock(signature) + quoteText, parts: { body: text, rest: quoteText } };
}
