// Building replies and forwards from an opened message. Pure functions, covered by compose.test.ts.

import { addrFull, shortDateTime } from "./format";
import type { Addr, AttachmentSource, ComposeDraft, OpenedMessage } from "./types";

export function emptyDraft(from: Addr | null): ComposeDraft {
  return { from, to: [], cc: [], bcc: [], subject: "", text: "", in_reply_to: null, references: [], attachments: [] };
}

const REPLY_PREFIX = /^\s*(re|ответ|отв|aw|sv)\s*(\[\d+\])?\s*:/i;
const FWD_PREFIX = /^\s*(fwd?|пересл|tr|wg)\s*:/i;

export function replySubject(subject: string): string {
  return REPLY_PREFIX.test(subject) ? subject : `Re: ${subject}`;
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

function quoted(msg: OpenedMessage): string {
  const s = msg.view.summary;
  const who = s.from ? addrFull(s.from) : "";
  const header = `${shortDateTime(s.date ?? msg.row.date)}, ${who} пишет:`;
  const body = (msg.view.text ?? "").replace(/\r\n/g, "\n").trimEnd();
  return `\n\n${header}\n${body
    .split("\n")
    .map((l) => (l.startsWith(">") ? `>${l}` : `> ${l}`))
    .join("\n")}\n`;
}

function threading(msg: OpenedMessage): Pick<ComposeDraft, "in_reply_to" | "references"> {
  const s = msg.view.summary;
  const id = s.message_id ?? msg.row.message_id;
  const refs = [...(s.references ?? [])];
  if (id && !refs.includes(id)) refs.push(id);
  return { in_reply_to: id, references: refs };
}

/** `me` is the address of the account that replies; it never ends up among recipients. */
export function reply(msg: OpenedMessage, me: Addr, all: boolean): ComposeDraft {
  const s = msg.view.summary;
  const fromMe = s.from && same(s.from, me);
  // Replying to my own sent message goes to its recipients.
  let to = fromMe ? s.to : s.reply_to.length ? s.reply_to : s.from ? [s.from] : [];
  let cc: Addr[] = [];
  if (all) {
    cc = uniq([...(fromMe ? [] : s.to), ...s.cc], [...to, me]);
  }
  to = uniq(to, fromMe ? [] : [me]);
  return {
    ...emptyDraft(me),
    to,
    cc,
    subject: replySubject(s.subject),
    text: quoted(msg),
    ...threading(msg),
  };
}

export function forward(msg: OpenedMessage, me: Addr): ComposeDraft {
  const s = msg.view.summary;
  const lines = [
    "",
    "",
    "-------- Пересылаемое сообщение --------",
    `Тема: ${s.subject}`,
    `Дата: ${shortDateTime(s.date ?? msg.row.date)}`,
    s.from ? `От: ${addrFull(s.from)}` : "",
    s.to.length ? `Кому: ${s.to.map(addrFull).join(", ")}` : "",
    s.cc.length ? `Копия: ${s.cc.map(addrFull).join(", ")}` : "",
    "",
    (msg.view.text ?? "").replace(/\r\n/g, "\n").trimEnd(),
    "",
  ].filter((l, i) => l !== "" || i < 3 || i > 7);
  const attachments: AttachmentSource[] = msg.view.attachments
    .filter((a) => !(a.inline && a.content_id))
    .map((a) => ({ kind: "message", id: msg.row.id, index: a.index, name: a.name, size: a.size }));
  return { ...emptyDraft(me), subject: forwardSubject(s.subject), text: lines.join("\n"), attachments };
}

/** Opens a server draft for editing. */
export function fromDraft(msg: OpenedMessage, me: Addr): ComposeDraft {
  const s = msg.view.summary;
  const attachments: AttachmentSource[] = msg.view.attachments
    .filter((a) => !(a.inline && a.content_id))
    .map((a) => ({ kind: "message", id: msg.row.id, index: a.index, name: a.name, size: a.size }));
  return {
    from: me,
    to: s.to.filter((a) => !same(a, me) || s.to.length > 1 || s.cc.length > 0),
    cc: s.cc,
    bcc: [],
    subject: s.subject,
    text: msg.view.text ?? "",
    in_reply_to: s.in_reply_to,
    references: s.references,
    attachments,
  };
}

/** Something worth keeping was typed; an untouched signature does not count. */
export function isDirty(d: ComposeDraft, signature?: string): boolean {
  const block = sigBlock(signature);
  const text = block ? d.text.replace(block, "") : d.text;
  return d.to.length + d.cc.length + d.bcc.length + d.attachments.length > 0 || d.subject.trim() !== "" || text.trim() !== "";
}

/** Signature block with the standard "-- " separator (RFC 3676), or nothing. */
export function sigBlock(signature: string | undefined): string {
  const sig = (signature ?? "").trim();
  return sig ? `\n\n-- \n${sig}` : "";
}

/** Adds the signature: at the end of a new message, above the quote in replies and forwards. */
export function withSignature(draft: ComposeDraft, signature: string | undefined): ComposeDraft {
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
  const quote = text.search(/\n\n[^\n]*(пишет:|-------- Пересылаемое сообщение)/);
  return quote >= 0 ? text.slice(0, quote) + newBlock + text.slice(quote) : text + newBlock;
}
