// Composition windows: docked in the corner, minimized to bars, or full screen; sending
// through the outbox and taking a queued letter back.

import type { UiController } from "./ui.svelte";
import { api } from "./api";
import { bus, collect } from "./bus";
import { t, tn } from "./i18n.svelte";
import { when } from "./later";
import { emptyDraft, formatFor, forward, isForward, reply } from "./compose";
import { defaultSignature, replySignature, withSignature } from "./signatures";
import { dropPlan, offersZones, type DropZone } from "./images";
import type { Account, AccountView, AttachmentSource, CachedDraft, ComposeDraft, FollowupPlan, OpenedMessage, OutboxItem, Settings } from "./types";

export interface ComposeState {
  account_id: string;
  draft: ComposeDraft;
  /** Server draft this composition came from or was last saved as; removed after sending. */
  draft_id: number | null;
  /** The Message-ID of that server copy: a delete checks it, as the number may be handed out again (#92). */
  draft_message_id?: string | null;
  /** The content is kept nowhere yet (typed in a quick reply, taken back from the outbox): save it. */
  unsaved?: boolean;
}

/** A composition window: docked in the corner, minimized to a bar, or full screen. */
export interface ComposeWindow extends ComposeState {
  id: number;
  mode: "open" | "min" | "max";
  /** When the draft was last saved on the server, ms. */
  savedAt: number | null;
  /** Unique across windows and restarts: names this draft's local copy (#71). */
  local_id: string;
}

/** What compositions need from the app store. */
export interface ComposeHost {
  readonly ui: UiController;
  readonly outbox: OutboxItem[];
  /** The letter of a separate message window, where compositions open full screen; null in the main window. */
  readonly windowOf: number | null;
  readonly opened: OpenedMessage | null;
  /** The format of new letters comes from here unless the mailbox has its own. */
  readonly settings: Settings;
  /** The letters are acted on: their read mark lands at once (#71). */
  markSeen(ids: number[], server?: boolean): void;
  account(id: string): AccountView | undefined;
  /** The mailbox a new letter is written from. */
  defaultAccount(): AccountView | undefined;
}

export class ComposeManager {
  /** Compositions in progress, oldest first; at most one is unfolded. */
  windows = $state<ComposeWindow[]>([]);
  private seq = 0;

  constructor(private host: ComposeHost) {
    // A page loaded anew has no compositions: what the backend was told by the page before is stale (#74).
    // A lost reset only leaves stale marks that spare drafts a clear would remove: the safe side.
    void api.draftOpenReset().catch(() => {});
  }

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
    const win = { ...c, id, mode, savedAt: null, local_id: newKey() };
    this.windows.push(win);
    // The backend spares an open server draft when Drafts are cleared from any window (#74).
    // A lost call spares less only for other windows: the clear passes the drafts of its own window itself.
    if (win.draft_id !== null) void api.draftOpen(win.local_id, win.draft_id, win.draft_message_id ?? null).catch(() => {});
    return id;
  }

  /** Keeps every composition, waiting for each at most `ms`; a slow server does not hold a close (#71). */
  async saveAll(ms: number): Promise<void> {
    // Each open window's component answers "compose.save-all" with its save; a saver answers
    // false on a failed save (the window says so itself), it does not throw.
    const saves = collect<boolean>((all) => bus.emit("compose.save-all", all)).map((p) => within(p, ms));
    await Promise.all(saves);
  }

  /** Opens the drafts kept locally when the app last stopped, and drops their copies. */
  async restoreLocal(drafts: CachedDraft[]) {
    for (const d of drafts) {
      // The copy goes first: a window opened beside a copy that stays would write a second one under its own key.
      try {
        await api.draftCacheDrop(d.key);
      } catch (e) {
        this.host.ui.fail(e, t("compose.localNotRestored"));
        continue;
      }
      this.open({ account_id: d.account_id, draft: d.draft, draft_id: d.draft_id ?? null, draft_message_id: d.draft_message_id ?? null, unsaved: true });
    }
  }

  newMessage() {
    const acc = this.host.defaultAccount();
    if (!acc) {
      this.host.ui.wizard = { account: null };
      return;
    }
    const draft = withSignature(emptyDraft({ name: acc.display_name, email: acc.email }, this.format(acc)), defaultSignature(acc));
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
    this.host.markSeen([msg.row.id]);
    const draft = withSignature(reply(msg, { name: acc.display_name, email: acc.email }, all, this.format(acc)), replySignature(acc));
    this.open({ account_id: acc.id, draft, draft_id: null });
  }

  forwardOpened() {
    const msg = this.host.opened;
    const acc = msg && this.host.account(msg.row.account_id);
    if (!msg || !acc) return;
    this.host.markSeen([msg.row.id]);
    const draft = withSignature(forward(msg, { name: acc.display_name, email: acc.email }, this.format(acc)), replySignature(acc));
    this.open({ account_id: acc.id, draft, draft_id: null });
  }

  /** A `mailto:` link in a letter: a new letter to its address, from the default mailbox. */
  openMailto(href: string) {
    const acc = this.host.defaultAccount();
    if (!acc) return;
    const draft = emptyDraft({ name: acc.display_name, email: acc.email }, this.format(acc));
    const to = decoded(href.slice(7).split("?")[0]);
    draft.to = to ? to.split(",").map((email) => ({ name: null, email: email.trim() })) : [];
    const subject = new URLSearchParams(href.split("?")[1] ?? "").get("subject");
    if (subject) draft.subject = subject;
    this.open({ account_id: acc.id, draft: withSignature(draft, defaultSignature(acc)), draft_id: null });
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

  /** Files dropped on the window: pictures into the text on its zone, the rest attached. Returns how many went into the text. */
  async dropFiles(c: ComposeWindow, paths: string[], zone: DropZone | null): Promise<number> {
    this.dragging = null;
    const plan = dropPlan(paths.map(baseName), c.draft.format ?? "plain", zone);
    const inline = paths.filter((p) => plan.inline.includes(baseName(p)));
    for (const path of paths.filter((p) => !inline.includes(p))) {
      try {
        const info = await api.fileInfo(path);
        c.draft.attachments.push({ kind: "file", path, name: info.name, size: info.size });
      } catch (err) {
        this.host.ui.fail(err);
      }
    }
    if (!inline.length) return 0;
    await this.pictureTargets.get(c.id)?.(inline);
    return inline.length;
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
    const gone = this.windows.find((w) => w.id === id);
    // Told even of a window without a draft yet: a save still on its way must not register one.
    // A mark left behind only spares a draft from a clear: the safe side.
    if (gone) void api.draftOpen(gone.local_id, null).catch(() => {});
    this.windows = this.windows.filter((w) => w.id !== id);
  }

  /** The window that takes dropped files: the unfolded one, else the newest. */
  active(): ComposeWindow | undefined {
    return this.windows.find((w) => w.mode !== "min") ?? this.windows.at(-1);
  }

  /** Queues the composition; it leaves after the undo delay or at `at`. */
  async send(accountId: string, draft: ComposeDraft, draftId: number | null, draftMessageId: string | null, at: number | null, followupSecs: number | null, followup: FollowupPlan | null = null) {
    const queued = await api.send(accountId, draft, draftId, draftMessageId, at, followupSecs, followup);
    const undo = { label: t("undo"), run: () => void this.reopenOutbox(queued.id) };
    const secs = Math.round(queued.at - Date.now() / 1000);
    if (at) this.host.ui.toast(t("toast.scheduled", { when: when(queued.at) }), false, undo, 10000);
    else if (secs > 0) this.countdown(queued.at, undo);
  }

  /** The «Sending…» toast shows the seconds left to undo, and counts them down (#75). */
  private countdown(at: number, undo: { label: string; run: () => void }) {
    const left = () => Math.max(1, Math.ceil(at - Date.now() / 1000));
    const id = this.host.ui.toast(tn("toast.sending", left()), false, undo, Math.max(0, at * 1000 - Date.now()));
    if (typeof id !== "number") return;
    const timer = setInterval(() => {
      if (Date.now() >= at * 1000 || !this.host.ui.retext(id, tn("toast.sending", left()))) clearInterval(timer);
    }, 1000);
  }

  /** Takes a queued message back into the composer. */
  async reopenOutbox(id: number) {
    try {
      const item = this.host.outbox.find((i) => i.id === id);
      const back = await api.outboxCancel(id);
      if (!back) {
        this.host.ui.toast(t("toast.alreadySent"), true);
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
          signature: d.signature ?? null,
          format: d.format ?? "plain",
          in_reply_to: d.in_reply_to,
          references: d.references,
          acts_on: d.acts_on ?? null,
          attachments,
          // A scheduled letter comes back with its time (as the Outbox tells them apart).
          send_at: item && item.attempts === 0 && item.next_attempt - item.created > 60 && item.next_attempt * 1000 > Date.now() ? item.next_attempt : null,
        },
        draft_id: null,
        unsaved: true,
      });
    } catch (e) {
      this.host.ui.fail(e);
    }
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** A fresh key for a draft's local copy: unique across windows and restarts. */
function newKey(): string {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** `p`, or `undefined` once `ms` passed: a save that would hold a close is let go. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(r, ms))]);
}

/** A link's escapes read; a stray "%" leaves the link as written. */
function decoded(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    // A malformed escape stays as it is.
    return s;
  }
}
