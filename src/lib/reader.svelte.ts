// The letter being read and its conversation: opened beside the list, kept up to date
// while open, and read along with it.

import type { MailboxController } from "./mailboxes.svelte";
import type { UiController } from "./ui.svelte";
import { api, asError } from "./api";
import { t, type Key } from "./i18n.svelte";
import { debounce } from "./debounce";
import { extensions } from "./extensions.svelte";
import type { ListController } from "./list.svelte";
import type { CmdError, MessageRow, OpenedMessage, Unverified } from "./types";

/** A letter counts as read once it was shown this long; flitting through the list does not. */
const SEEN_MS = 1000;

/** What the reader needs from the app store. */
export interface ReaderHost {
  readonly mailboxes: Pick<MailboxController, "account">;
  readonly list: Pick<ListController, "mark" | "messages">;
  readonly ui: Pick<UiController, "fail">;
  /** The letter of a separate message window; null in the main window. */
  readonly windowOf: number | null;
}

export class Reader {
  opened = $state<OpenedMessage | null>(null);
  openError = $state<CmdError | null>(null);
  opening = $state(false);
  /** The list row of the message being opened: its header shows at once, before the body arrives. */
  openingRow = $state<MessageRow | null>(null);
  allowRemote = $state(false);
  /** The opened message's conversation, oldest first; empty for a lone message. */
  conversation = $state<MessageRow[]>([]);
  /** Bumped by every flag change the user makes; late automatic marks yield to it. */
  flagEpoch = 0;
  private openSeq = 0;
  /** The read mark of the letter shown now waits for it to stay on screen (#71). */
  private seenTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private host: ReaderHost) {}

  /** Letters shown now: the open one and its conversation. */
  showing(): number[] {
    return [...(this.opened ? [this.opened.row.id] : []), ...this.conversation.map((m) => m.id)];
  }

  /**
   * The letter with its actions is on screen: it is open, nothing failed, and no other letter
   * is being opened in its place. The reader's own toolbar and the action panel above it both
   * ask this, so the buttons of the letter leaving the pane never linger on the letter arriving.
   */
  get showsLetter(): boolean {
    const opened = this.opened;
    return !!opened && !this.openError && !(this.opening && this.openingRow?.id !== opened.row.id);
  }

  /** Nothing is open any more. An open still in flight is dropped: it must not bring the letter back. */
  close() {
    this.cancelSeen();
    this.openSeq++;
    this.opened = null;
    this.opening = false;
    this.openingRow = null;
    this.conversation = [];
  }

  async open(id: number, allowRemote = false) {
    const seq = ++this.openSeq;
    const { list } = this.host;
    this.cancelSeen();
    this.opening = true;
    this.openingRow = list.messages.find((m) => m.id === id) ?? this.conversation.find((m) => m.id === id) ?? null;
    this.openError = null;
    this.allowRemote = allowRemote;
    try {
      const msg = await api.open(id, allowRemote, seq);
      if (seq !== this.openSeq) return;
      const epoch = this.flagEpoch;
      const wasUnread = !msg.row.flags.seen;
      msg.row.flags.seen = true;
      this.opened = msg;
      // Banners of the previous letter go, unless it shares a conversation with this one.
      extensions.showing([id, ...this.conversation.map((m) => m.id)]);
      this.conversation = [];
      // The view holds the open letter at once; the read mark waits for it to stay (#71).
      if (wasUnread) list.mark(id, list.messages.find((m) => m.id === id) ?? { ...msg.row, flags: { ...msg.row.flags, seen: false } });
      this.loadConversation(id, seq, epoch, msg.row.folder, wasUnread);
      extensions.messageOpen(msg, this.host.mailboxes.account(msg.row.account_id)?.email ?? "");
      if (msg.why_unverified === "checking") void this.checkSender(id, seq);
    } catch (e) {
      if (seq === this.openSeq) {
        this.opened = null;
        this.openError = asError(e);
      }
    } finally {
      if (seq === this.openSeq) {
        this.opening = false;
        this.openingRow = null;
      }
    }
  }

  /**
   * The mailbox's server said nothing about a trusted sender: the app checks the letter's
   * signature in the background (#167), and the letter is read again for the answer. Its
   * pictures and the line about them change; nothing else of the open is repeated.
   */
  private async checkSender(id: number, seq: number) {
    const answer = await senderChecked(id, () => this.allowRemote, () => seq === this.openSeq);
    const opened = this.opened;
    if (answer && opened?.row.id === id) this.opened = { ...opened, ...answer };
  }

  private async loadConversation(id: number, seq: number, epoch: number, folder: string, wasUnread: boolean) {
    const conversation = await api.thread(id).catch((e) => (this.host.ui.fail(e, t("reader.conversationFailed")), [] as MessageRow[]));
    if (seq !== this.openSeq) return;
    this.conversation = shownConversation(conversation, id, folder);
    extensions.showing(this.showing());
    // Reading a conversation reads all of it — once the letter stayed on screen (#71).
    for (const m of this.conversation) if (!m.flags.seen && m.id !== id) this.host.list.mark(m.id, m);
    if (wasUnread || conversation.some((m) => !m.flags.seen && m.id !== id)) this.scheduleSeen(id, seq, epoch, wasUnread);
  }

  /** Marks the shown letter (and its conversation) read once it stayed on screen. */
  private scheduleSeen(id: number, seq: number, epoch: number, wasUnread: boolean) {
    this.cancelSeen();
    this.seenTimer = setTimeout(() => {
      this.seenTimer = null;
      this.markSeen(id, seq, epoch, wasUnread);
    }, SEEN_MS);
  }

  private cancelSeen() {
    if (this.seenTimer) clearTimeout(this.seenTimer);
    this.seenTimer = null;
  }

  private markSeen(id: number, seq: number, epoch: number, wasUnread: boolean) {
    // Another letter opened, or the user changed flags by hand meanwhile: nothing to mark.
    if (seq !== this.openSeq || epoch !== this.flagEpoch) return;
    const opened = this.opened;
    if (!opened || opened.row.id !== id) return;
    const { list } = this.host;
    const unread = this.conversation.filter((m) => !m.flags.seen && m.id !== id).map((m) => m.id);
    const ids = [...(wasUnread ? [id] : []), ...unread];
    if (!ids.length) return;
    api.setFlag(ids, { flag: "seen", value: true }).catch((e) => this.host.ui.fail(e));
    for (const m of this.conversation) if (ids.includes(m.id)) m.flags.seen = true;
    for (const m of list.messages) if (ids.includes(m.id)) m.flags.seen = true;
  }

  /**
   * The user acts on these letters (flags, a move, an answer): their read mark lands at
   * once, as if the second had passed. A letter dealt with is never left unread by the
   * wait (#71), and the state is each letter's own — not the one that was open a moment
   * ago, which a key move may already have left behind.
   *
   * `server` is false for a move that follows: a separate flag would stop the move series,
   * and a held "archive" would be one request per letter. The move itself sets `\Seen`.
   */
  saw(ids: number[], server = true) {
    if (!ids.length) return;
    const { list } = this.host;
    const opened = this.opened;
    const row = (id: number) =>
      list.messages.find((m) => m.id === id) ?? this.conversation.find((m) => m.id === id) ?? (opened?.row.id === id ? opened.row : undefined);
    const unread = ids.filter((id) => !(row(id)?.flags.seen ?? true));
    if (!unread.length) return;
    // Acting on the open letter takes over the mark the wait was about to make.
    if (unread.includes(opened?.row.id ?? -1)) this.cancelSeen();
    if (server) api.setFlag(unread, { flag: "seen", value: true }).catch((e) => this.host.ui.fail(e));
    for (const id of unread) {
      const r = row(id);
      if (!r) continue;
      // The row holds its place in the view it was read from, as opening it does (#71): a
      // letter read does not vanish from «Непрочитанные» under the user's hands (0.8.4, #180).
      this.host.list.mark(id, { ...r, flags: { ...r.flags, seen: false } });
      r.flags.seen = true;
    }
  }

  /**
   * Letters dealt with leave the shown conversation at once (0.8.4, #180): the pane keeps the
   * letter it shows, and the thread does not wait for the next open to lose the ones gone.
   */
  dropFromConversation(ids: number[]) {
    if (!ids.length || !this.conversation.some((m) => ids.includes(m.id))) return;
    this.conversation = this.conversation.filter((m) => !ids.includes(m.id));
  }

  /**
   * A move left these letters of the conversation in it, in a new folder (#180): they keep their
   * place, and the whole list is written again so the reader is drawn with the new folders.
   */
  renameInConversation(folders: Map<number, string>) {
    if (!folders.size || !this.conversation.some((m) => folders.has(m.id))) return;
    this.conversation = this.conversation.map((m) => (folders.has(m.id) ? { ...m, folder: folders.get(m.id)! } : m));
  }

  /** A letter joined the open conversation (an answer, a forward, new mail): show it, flags untouched. */
  scheduleConversation = debounce(() => void this.refreshConversation(), 250, 1000);

  private async refreshConversation() {
    const opened = this.opened;
    if (!opened) return;
    const seq = this.openSeq;
    // The shown conversation stays as it is; it is read again on the next open.
    const rows = await api.thread(opened.row.id).catch(() => []);
    // A letter moved or deleted meanwhile keeps its conversation until opened again.
    if (seq !== this.openSeq || rows.length === 0) return;
    const next = shownConversation(rows, opened.row.id, opened.row.folder);
    const same = (a: MessageRow[], b: MessageRow[]) =>
      a.length === b.length && a.every((m, i) => m.id === b[i].id && m.flags.seen === b[i].flags.seen && m.flags.flagged === b[i].flags.flagged);
    if (!same(next, this.conversation)) {
      this.conversation = next;
      extensions.showing(this.showing());
    }
  }

  /** The letter was moved or deleted elsewhere: the window says so instead of showing a ghost. */
  async checkStillThere() {
    const id = this.opened?.row.id ?? this.host.windowOf;
    if (id === null) return;
    // A failed check leaves the letter shown; it is repeated on the next sync.
    const rows = await api.messagesById([id]).catch(() => null);
    if (rows && rows.length === 0) {
      this.opened = null;
      this.openError = { kind: "not-found", message: t("window.gone") };
    }
  }
}

/**
 * The app's own check of a letter's sender (#167), then the letter read again for its answer:
 * what of the opened letter changes, or `null` once the letter is no longer `current`. A check
 * without an answer is no confirmation, and never stays «checking».
 */
export async function senderChecked(id: number, allowRemote: () => boolean, current: () => boolean): Promise<Partial<OpenedMessage> | null> {
  // A failed check is no confirmation: the line below says the signature was not checked.
  await api.checkSender(id).catch(() => false);
  if (!current()) return null;
  // The letter stays shown as it was opened; the line then says the check got no answer.
  const fresh = await api.open(id, allowRemote()).catch(() => null);
  if (!current()) return null;
  if (!fresh) return { why_unverified: "unchecked" };
  return { view: fresh.view, trusted_sender: fresh.trusted_sender, sender_unverified: fresh.sender_unverified, why_unverified: fresh.why_unverified === "checking" ? "unchecked" : fresh.why_unverified };
}

/**
 * The name of the mailbox for the line about a sender who is not confirmed (0.8.13).
 *
 * The name is the user's own, so it goes in quotes and the word in front of it is in the
 * locale: a mailbox named «Работа» is not a word the verb could agree with.
 */
export function boxName(label: string | undefined, email: string): string {
  const name = label?.trim();
  if (name) return `«${name}»`;
  return email.split("@")[1] || email;
}

/**
 * The line about a trusted sender who is not confirmed, by why (0.8.13). The line names the
 * mailbox: the same reason means different things on different servers, and the old text
 * ("the mailbox's server does not check senders") was untrue on Yandex.
 */
export function unverifiedKey(why: Unverified | null): Key {
  switch (why) {
    case "checking":
      return "reader.checkingSender";
    case "unsigned":
      return "reader.serverUnsigned";
    case "signature":
      return "reader.serverBadSignature";
    case "no_key":
      return "reader.serverNoKey";
    case "unchecked":
      return "reader.serverUnchecked";
    case "replay":
      return "reader.serverReplay";
    case "no_time":
      return "reader.serverNoTime";
    case "not_aligned":
      return "reader.serverNotAligned";
    case "expired":
      return "reader.serverExpired";
    case "strict_policy":
      return "reader.serverStrictPolicy";
    case "uneven_headers":
      return "reader.serverUneven";
    case "no_recipient_in_h":
      return "reader.serverNoRecipient";
    case "address_only":
      return "reader.addressNotChecked";
    case "address_only_unchecked":
      return "reader.addressNotCheckedNoKey";
    case "no_check":
      return "reader.cannotCheck";
    default:
      return "reader.serverNo";
  }
}

/**
 * The tip under the line: the detail the line does not carry (0.8.13). The line says who did
 * not confirm the sender; the tip says what the server said.
 *
 * `serverChecks` is the mailbox's server checking senders itself (Gmail, Yandex, Mail.ru,
 * Exchange Online). Where it does, the letter being unsigned needs no explanation: telling the
 * user that the server does not check senders would be untrue (0.8.13, 5.1 Б).
 */
export function unverifiedTip(why: Unverified | null, serverChecks = false): Key | null {
  switch (why) {
    case "unsigned":
      return serverChecks ? null : "reader.tipUnsigned";
    case "signature":
      return "reader.tipBadSignature";
    case "unchecked":
      return "reader.tipUnchecked";
    case "no_check":
      return "reader.tipCannotCheck";
    case "no_time":
      return "reader.tipNoTime";
    case "strict_policy":
      return "reader.tipStrictPolicy";
    case "uneven_headers":
      return "reader.tipUneven";
    case "no_recipient_in_h":
      return "reader.tipNoRecipient";
    default:
      return null;
  }
}

/** One entry per letter, oldest first: a copy in the folder of the opened one wins over the one in Sent. */
export function shownConversation(conversation: MessageRow[], id: number, folder: string): MessageRow[] {
  const shown = new Map<string, MessageRow>();
  for (const m of conversation) {
    const key = m.message_id ?? `#${m.id}`;
    const prev = shown.get(key);
    if (!prev || m.id === id || (prev.id !== id && m.folder === folder)) shown.set(key, m);
  }
  const unique = [...shown.values()].sort((a, b) => a.date - b.date || a.id - b.id);
  return unique.length > 1 ? unique : [];
}
