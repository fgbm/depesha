// Whose picture a row of the list wears (#108): in a folder of my own letters (Sent, Drafts)
// the first recipient, like «To: …» in the row; in a conversation its last writer who is not
// me («who answered is who matters»); otherwise the sender. A brand logo stands only next to
// a sender the receiving server vouched for (DMARC): a recipient is never vouched for. Pure,
// covered by listAvatar.test.ts.

import type { Addr, FolderRole, MessageRow } from "./types";

/** Mail in Spam and Trash asks the network for nothing, in the list and when opened (#108):
 *  a logo fetched for a letter nobody wants would tell its sender that it was looked at. */
export function mayAskLogo(role: FolderRole | null | undefined): boolean {
  return role !== "junk" && role !== "trash";
}

export interface RowAvatar {
  addr: Addr | null;
  /** The receiving server vouched for this address: a company logo may stand in the circle. */
  brand: boolean;
  /** The cached letter that verdict is from: the backend is asked about a logo by it. */
  id: number;
}

/** `mine`: the addresses of my mailboxes, lower-cased; `sentLike`: the row lists my own letters. */
export function rowAvatar(m: MessageRow, sentLike: boolean, mine: ReadonlySet<string>): RowAvatar {
  if (sentLike) return { addr: m.to[0] ?? null, brand: false, id: m.id };
  const voices = m.thread_voices ?? [];
  if (voices.length > 1) {
    const voice = [...voices].reverse().find((v) => !mine.has(v.from.email.toLowerCase())) ?? voices[voices.length - 1];
    return { addr: voice.from, brand: voice.dmarc, id: voice.id };
  }
  return { addr: m.from, brand: m.dmarc ?? false, id: m.id };
}
