// Composition windows: docked in the corner, minimized to bars, or full screen; sending
// through the outbox and taking a queued letter back.

import { api } from "./api";
import { t, tn } from "./i18n.svelte";
import { when } from "./later";
import { emptyDraft, formatFor, forward, isForward, reply, withSignature } from "./compose";
import { dropPlan, offersZones, type DropZone } from "./images";
import type { Account, AccountView, AttachmentSource, ComposeDraft, OpenedMessage, OutboxItem, Settings } from "./types";

export interface ComposeState {
  account_id: string;
  draft: ComposeDraft;
  /** Server draft this composition came from or was last saved as; removed after sending. */
  draft_id: number | null;
  /** The content is kept nowhere yet (typed in a quick reply, taken back from the outbox): save it. */
  unsaved?: boolean;
}

/** A composition window: docked in the corner, minimized to a bar, or full screen. */
export interface ComposeWindow extends ComposeState {
  id: number;
  mode: "open" | "min" | "max";
  /** When the draft was last saved on the server, ms. */
  savedAt: number | null;
}

/** What compositions need from the app store. */
export interface ComposeHost {
  readonly outbox: OutboxItem[];
  /** The letter of a separate message window, where compositions open full screen; null in the main window. */
  readonly windowOf: number | null;
  readonly opened: OpenedMessage | null;
  /** The format of new letters comes from here unless the mailbox has its own. */
  readonly settings: Settings;
  /** Set to start the first mailbox's setup. */
  wizard: { account: Account | null } | null;
  account(id: string): AccountView | undefined;
  /** The mailbox a new letter is written from. */
  defaultAccount(): AccountView | undefined;
  toast(text: string, error?: boolean, action?: { label: string; run: () => void }, ms?: number): void;
  fail(e: unknown, prefix?: string): void;
}

export class ComposeManager {
  /** Compositions in progress, oldest first; at most one is unfolded. */
  windows = $state<ComposeWindow[]>([]);
  private seq = 0;

  constructor(private host: ComposeHost) {}

  /** Opens a composition window; the others fold into bars, as in Gmail. */
  open(c: ComposeState, mode: ComposeWindow["mode"] = this.host.windowOf !== null ? "max" : "open"): number {
    // A saved draft opened again goes to its window.
    const open = c.draft_id !== null ? this.windows.find((w) => w.draft_id === c.draft_id) : undefined;
    if (open) {
      this.show(open.id);
      return open.id;
    }
    const id = ++this.seq;
    for (const w of this.windows) if (w.mode !== "min") w.mode = "min";
    this.windows.push({ ...c, id, mode, savedAt: null });
    return id;
  }

  newMessage() {
    const acc = this.host.defaultAccount();
    if (!acc) {
      this.host.wizard = { account: null };
      return;
    }
    const draft = withSignature(emptyDraft({ name: acc.display_name, email: acc.email }, this.format(acc)), acc.signature);
    this.open({ account_id: acc.id, draft, draft_id: null });
  }

  replyTo(all: boolean) {
    const msg = this.host.opened;
    const acc = msg && this.host.account(msg.row.account_id);
    if (!msg || !acc) return;
    // An answer already being written to this letter comes back instead of a second one.
    // A forward of it is threaded the same way and is not an answer.
    const same = this.windows.find(
      (c) => c.draft.in_reply_to && c.draft.in_reply_to === msg.view.summary.message_id && !isForward(c.draft.subject),
    );
    if (same) return this.show(same.id);
    const draft = withSignature(reply(msg, { name: acc.display_name, email: acc.email }, all, this.format(acc)), acc.signature);
    this.open({ account_id: acc.id, draft, draft_id: null });
  }

  forwardOpened() {
    const msg = this.host.opened;
    const acc = msg && this.host.account(msg.row.account_id);
    if (!msg || !acc) return;
    const draft = withSignature(forward(msg, { name: acc.display_name, email: acc.email }, this.format(acc)), acc.signature);
    this.open({ account_id: acc.id, draft, draft_id: null });
  }

  /** Files dragged over the window: the HTML letter offers its two zones, the one under the pointer. */
  dragging = $state<{ zones: boolean; zone: DropZone | null } | null>(null);
  /** Where each window puts pictures dropped "into the text". */
  private pictureTargets = new Map<number, (paths: string[]) => Promise<void>>();

  pictureTarget(id: number, insert: ((paths: string[]) => Promise<void>) | null) {
    if (insert) this.pictureTargets.set(id, insert);
    else this.pictureTargets.delete(id);
  }

  dragEnter(c: ComposeWindow, paths: string[]) {
    this.dragging = { zones: offersZones(paths.map(baseName), c.draft.format ?? "plain"), zone: null };
  }

  /** Files dropped on the window: pictures into the text on its zone, the rest attached. */
  async dropFiles(c: ComposeWindow, paths: string[], zone: DropZone | null) {
    this.dragging = null;
    const plan = dropPlan(paths.map(baseName), c.draft.format ?? "plain", zone);
    const inline = paths.filter((p) => plan.inline.includes(baseName(p)));
    for (const path of paths.filter((p) => !inline.includes(p))) {
      try {
        const info = await api.fileInfo(path);
        c.draft.attachments.push({ kind: "file", path, name: info.name, size: info.size });
      } catch (err) {
        this.host.fail(err);
      }
    }
    if (inline.length) await this.pictureTargets.get(c.id)?.(inline);
  }

  /** How a new letter from the mailbox is written. */
  format(acc: Account | undefined) {
    return formatFor(acc, this.host.settings);
  }

  /** Unfolds a window and folds the rest. */
  show(id: number, mode: "open" | "max" = "open") {
    for (const w of this.windows) w.mode = w.id === id ? (w.mode === "max" ? "max" : mode) : "min";
  }

  close(id: number) {
    this.windows = this.windows.filter((w) => w.id !== id);
  }

  /** The window that takes dropped files: the unfolded one, else the newest. */
  active(): ComposeWindow | undefined {
    return this.windows.find((w) => w.mode !== "min") ?? this.windows.at(-1);
  }

  /** Queues the composition; it leaves after the undo delay or at `at`. */
  async send(accountId: string, draft: ComposeDraft, draftId: number | null, at: number | null, followupSecs: number | null) {
    const queued = await api.send(accountId, draft, draftId, at, followupSecs);
    const undo = { label: t("undo"), run: () => void this.reopenOutbox(queued.id) };
    const secs = Math.round(queued.at - Date.now() / 1000);
    if (at) this.host.toast(t("toast.scheduled", { when: when(queued.at) }), false, undo, 10000);
    else if (secs > 0) this.host.toast(tn("toast.sending", secs), false, undo, secs * 1000);
  }

  /** Takes a queued message back into the composer. */
  async reopenOutbox(id: number) {
    try {
      const item = this.host.outbox.find((i) => i.id === id);
      const back = await api.outboxCancel(id);
      if (!back) {
        this.host.toast(t("toast.alreadySent"), true);
        return;
      }
      const attachments: AttachmentSource[] = [];
      for (const [name, , data] of back.attachments) {
        const path = await api.tempAttachment(name, data);
        attachments.push({ kind: "file", path, name, size: Math.floor((data.length * 3) / 4) });
      }
      const d = back.draft;
      this.open({
        account_id: back.account_id,
        draft: {
          from: d.from,
          to: d.to,
          cc: d.cc,
          bcc: d.bcc,
          subject: d.subject,
          text: d.text,
          html: d.html ?? null,
          format: d.format ?? "plain",
          in_reply_to: d.in_reply_to,
          references: d.references,
          attachments,
          // A scheduled letter comes back with its time (as the Outbox tells them apart).
          send_at: item && item.attempts === 0 && item.next_attempt - item.created > 60 && item.next_attempt * 1000 > Date.now() ? item.next_attempt : null,
        },
        draft_id: null,
        unsaved: true,
      });
    } catch (e) {
      this.host.fail(e);
    }
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
