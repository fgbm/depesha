// The attachment viewer of the reading pane (#23): the shown file, its place among the
// letter's files and the way back to the letter. The state, the effects and the order are
// the component's of old; AttachmentViewer.svelte brings the markup and the wording of its
// buttons and toasts, so every `t("…")` of this view stays in a component.

import { api, asError } from "../../lib/api";
import { app } from "../../lib/store.svelte";
import type { AttachmentInfo } from "../../lib/types";

/** What the viewer needs from the pane that shows it: the wording of its toasts. */
export interface AttachmentViewerHost {
  /** A file went into the folder from the settings: the toast names it. */
  savedTo(name: string, dir: string): void;
  /** The folder is gone or closed to writing: the toast says so and offers another. */
  saveInFailed(message: string, again: () => void): void;
  /** A file went where the user picked: the toast names it. */
  saved(name: string): void;
  /** Every file of the letter went into a folder: the toast counts them. */
  savedAll(n: number): void;
  /** The title of the dialog that picks where a file goes. */
  saveTitle(): string;
  /** The title of the dialog that picks the folder for every file. */
  saveAllTitle(): string;
}

export class AttachmentViewerState {
  /** The letter open now: its files and the mailbox they belong to. */
  readonly msg = $derived(app.opened);
  readonly files = $derived(this.msg ? this.msg.view.attachments.filter((a) => !(a.inline && a.content_id)) : []);
  readonly account = $derived(this.msg ? app.account(this.msg.row.account_id) : undefined);
  /** The folder attachments go to without asking: the mailbox's own, else the settings'. */
  readonly saveDir = $derived(this.account?.attachments_dir?.trim() || app.settings.attachments_dir?.trim() || "");
  private readonly openId = $derived(this.msg?.row.id ?? null);
  /** The letter the viewer belongs to: null while the letter's text is shown. */
  viewingId = $derived.by<number | null>(() => {
    // Another letter opened: the viewer of the previous one closes. The id is read through
    // its own derived: the same letter loaded again is another object, but not another letter.
    void this.openId;
    return null;
  });
  /** The shown attachment's place among the files; the attachments row highlights it. */
  at = $state(0);
  /** The letter's place in the pane while an attachment is shown: it comes back as it was. */
  scrollBox = $state<HTMLElement | null>(null);
  private scrollBefore = 0;
  private host: AttachmentViewerHost;

  /** The viewer is open on this letter; the attachments row and the pane read it. */
  readonly viewing = $derived(this.viewingId !== null);

  constructor(host: AttachmentViewerHost) {
    this.host = host;
  }

  /** The row works as a switch: the shown attachment again takes back to the letter. */
  viewAttachment(a: AttachmentInfo) {
    if (!this.msg) return;
    const at = Math.max(0, this.files.indexOf(a));
    if (this.viewingId !== null && this.at === at) return this.closeViewer();
    if (this.viewingId === null) this.scrollBefore = this.scrollBox?.scrollTop ?? 0;
    this.viewingId = this.msg.row.id;
    this.at = at;
    if (this.scrollBox) this.scrollBox.scrollTop = 0;
  }

  closeViewer() {
    const at = this.at;
    this.viewingId = null;
    queueMicrotask(() => {
      if (this.scrollBox) this.scrollBox.scrollTop = this.scrollBefore;
      // Focus goes back to the attachment the viewer ended on; a folded one, to «+N more».
      const names = this.scrollBox?.querySelectorAll<HTMLElement>(".file-name");
      (names?.[at] ?? this.scrollBox?.querySelector<HTMLElement>(".files .more"))?.focus({ preventScroll: true });
    });
  }

  async openAttachment(a: AttachmentInfo) {
    if (!this.msg) return;
    try {
      await app.track(api.attachmentOpen(this.msg.row.id, a.index));
    } catch (e) {
      app.fail(e);
    }
  }

  async saveAttachment(a: AttachmentInfo) {
    if (!this.msg) return;
    if (!this.saveDir) return this.saveAttachmentAs(a);
    try {
      const path = await app.track(api.attachmentSaveIn(this.msg.row.id, a.index));
      this.host.savedTo(path.split(/[\\/]/).pop() ?? a.name, this.saveDir);
    } catch (e) {
      // The folder is gone or closed to writing: the error says so, the file goes elsewhere.
      this.host.saveInFailed(asError(e).message, () => this.saveAttachmentAs(a));
    }
  }

  async saveAttachmentAs(a: AttachmentInfo) {
    if (!this.msg) return;
    try {
      const path = await api.pickSaveFile(this.host.saveTitle(), a.name);
      if (!path) return;
      await app.track(api.attachmentSave(this.msg.row.id, a.index, path));
      this.host.saved(a.name);
    } catch (e) {
      app.fail(e);
    }
  }

  async saveAll() {
    if (!this.msg) return;
    try {
      // The folder from the settings is the backend's to find; another one is picked now.
      const dir = this.saveDir ? null : await api.pickFolder("save", this.host.saveAllTitle());
      if (!this.saveDir && !dir) return;
      const n = await app.track(api.attachmentsSaveAll(this.msg.row.id, dir));
      this.host.savedAll(n);
    } catch (e) {
      app.fail(e);
    }
  }
}

/** The attachment viewer of the reading pane: the shown file, its place and the way back. */
export function useAttachmentViewer(host: AttachmentViewerHost): AttachmentViewerState {
  return new AttachmentViewerState(host);
}
