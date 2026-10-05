// The letter being read and its conversation: opened beside the list, kept up to date
// while open, and read along with it.

import { api, asError } from "./api";
import { t } from "./i18n.svelte";
import { debounce } from "./debounce";
import { extensions } from "./extensions.svelte";
import type { ListController } from "./list.svelte";
import type { AccountView, CmdError, MessageRow, OpenedMessage } from "./types";

/** What the reader needs from the app store. */
export interface ReaderHost {
  readonly list: ListController;
  /** The letter of a separate message window; null in the main window. */
  readonly windowOf: number | null;
  account(id: string): AccountView | undefined;
  fail(e: unknown, prefix?: string): void;
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

  constructor(private host: ReaderHost) {}

  /** Letters shown now: the open one and its conversation. */
  showing(): number[] {
    return [...(this.opened ? [this.opened.row.id] : []), ...this.conversation.map((m) => m.id)];
  }

  /** Nothing is open any more. */
  close() {
    this.opened = null;
    this.conversation = [];
  }

  async open(id: number, allowRemote = false) {
    const seq = ++this.openSeq;
    const { list } = this.host;
    this.opening = true;
    this.openingRow = list.messages.find((m) => m.id === id) ?? this.conversation.find((m) => m.id === id) ?? null;
    this.openError = null;
    this.allowRemote = allowRemote;
    try {
      const msg = await api.open(id, allowRemote);
      if (seq !== this.openSeq) return;
      const epoch = this.flagEpoch;
      const wasUnread = !msg.row.flags.seen;
      msg.row.flags.seen = true;
      this.opened = msg;
      // Banners of the previous letter go, unless it shares a conversation with this one.
      extensions.showing([id, ...this.conversation.map((m) => m.id)]);
      this.conversation = [];
      // Marked read on the server only after it was shown.
      if (wasUnread) {
        list.mark(id, list.messages.find((m) => m.id === id) ?? { ...msg.row, flags: { ...msg.row.flags, seen: false } });
        api.setFlag([id], { flag: "seen", value: true }).catch((e) => this.host.fail(e));
        const row = list.messages.find((m) => m.id === id);
        if (row) row.flags.seen = true;
      }
      this.loadConversation(id, seq, epoch, msg.row.folder);
      extensions.messageOpen(msg, this.host.account(msg.row.account_id)?.email ?? "");
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

  private async loadConversation(id: number, seq: number, epoch: number, folder: string) {
    const conversation = await api.thread(id).catch(() => [] as MessageRow[]);
    if (seq !== this.openSeq) return;
    this.conversation = shownConversation(conversation, id, folder);
    extensions.showing(this.showing());
    // Reading a conversation reads all of it, unless the user changed flags meanwhile.
    const unread = conversation.filter((m) => !m.flags.seen && m.id !== id).map((m) => m.id);
    if (unread.length && epoch === this.flagEpoch) {
      for (const m of conversation) if (unread.includes(m.id)) this.host.list.mark(m.id, m);
      api.setFlag(unread, { flag: "seen", value: true }).catch((e) => this.host.fail(e));
      for (const m of this.host.list.messages) if (unread.includes(m.id)) m.flags.seen = true;
    }
  }

  /** A letter joined the open conversation (an answer, a forward, new mail): show it, flags untouched. */
  scheduleConversation = debounce(() => void this.refreshConversation(), 250, 1000);

  private async refreshConversation() {
    const opened = this.opened;
    if (!opened) return;
    const seq = this.openSeq;
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
    const rows = await api.messagesById([id]).catch(() => null);
    if (rows && rows.length === 0) {
      this.opened = null;
      this.openError = { kind: "not-found", message: t("window.gone") };
    }
  }
}

/** One entry per letter, oldest first: a copy in the folder of the opened one wins over the one in Sent. */
function shownConversation(conversation: MessageRow[], id: number, folder: string): MessageRow[] {
  const shown = new Map<string, MessageRow>();
  for (const m of conversation) {
    const key = m.message_id ?? `#${m.id}`;
    const prev = shown.get(key);
    if (!prev || m.id === id || (prev.id !== id && m.folder === folder)) shown.set(key, m);
  }
  const unique = [...shown.values()].sort((a, b) => a.date - b.date || a.id - b.id);
  return unique.length > 1 ? unique : [];
}
