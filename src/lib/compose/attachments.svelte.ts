// Files and pictures going into a letter: attached from a dialog, or put into the text
// of an HTML letter from files, a paste or a drop. The window (Compose.svelte) owns the
// wording of the toasts and the markup, so every `t("…")` of these actions stays in a
// component.

import { onMount } from "svelte";
import { api } from "../api";
import { dataUrlSize, isPictureName } from "../images";
import { clipboardPictures, picturesFromBlobs, picturesFromFiles, picturesHtml, type FoundPicture } from "../pictureInput";
import type { ComposeWindow } from "../composes.svelte";
import type { ComposeFormat } from "./format.svelte";

/** What the letter's files and pictures need from the window. */
export interface ComposeAttachHost {
  readonly win: ComposeWindow;
  /** The letter's body and editor: pictures "into the text" go there. */
  readonly format: ComposeFormat;
  fail(e: unknown, prefix?: string): void;
  /** A picture too heavy went as a file instead: the toast says so. */
  toastBig(name: string): void;
  /** The clipboard does not give its pictures to the page: Ctrl+V does it. */
  useCtrlV(): void;
  /** The clipboard holds no picture. */
  noneInClipboard(): void;
  /** The title of the dialog that picks picture files. */
  pickTitle(): string;
  /** The title of the dialog that picks attachments. */
  attachTitle(): string;
  /** Files dragged over a window: the two zones and the one under the pointer, if any. */
  readonly dragging: { zones: boolean } | null;
  /** The window that takes dropped files: the unfolded one, else the newest. */
  activeComposeId(): number | undefined;
  /** Where this window puts pictures dropped "into the text". */
  pictureTarget(id: number, insert: ((paths: string[]) => Promise<void>) | null): void;
}

export class ComposeAttachments {
  constructor(private host: ComposeAttachHost) {
    // Dropped files go to the window's zones: "into the text" or "attach" (App.svelte).
    onMount(() => {
      const id = this.host.win.id;
      this.host.pictureTarget(id, (paths) => this.insertPictureFiles(paths));
      return () => this.host.pictureTarget(id, null);
    });
  }

  /** The zones of a dragged file are offered by an HTML letter only, in the active window. */
  get zones(): boolean {
    const win = this.host.win;
    return this.host.format.format === "html" && win.mode !== "min" && !!this.host.dragging?.zones && this.host.activeComposeId() === win.id;
  }

  /** Pictures in the text of an HTML letter. A large photo is made smaller first; one
   * still too big goes as a file, as it would anyway. */
  async addPictures(found: FoundPicture[]) {
    const { html, tooBig, failed } = await picturesHtml(found);
    for (const p of await this.attachPictures(tooBig)) this.host.toastBig(p.name);
    for (const e of failed) this.host.fail(e);
    if (html) this.host.format.rich?.insertHtml(html);
  }

  /** Pictures as files of the letter; gives back those attached. */
  private async attachPictures(found: FoundPicture[]): Promise<FoundPicture[]> {
    const done: FoundPicture[] = [];
    for (const p of found) {
      try {
        const base64 = p.dataUrl.slice(p.dataUrl.indexOf(",") + 1);
        const path = await api.tempAttachment(p.name, base64);
        this.host.win.draft.attachments.push({ kind: "file", path, name: p.name, size: dataUrlSize(p.dataUrl) });
        done.push(p);
      } catch (e) {
        this.host.fail(e);
      }
    }
    return done;
  }

  /** Picture files chosen or dropped "into the text"; a file that cannot go there is attached. */
  async insertPictureFiles(paths: string[]) {
    const { found, refused } = await picturesFromFiles(paths);
    for (const path of refused) {
      const info = await api.fileInfo(path).catch(() => null);
      if (info) this.host.win.draft.attachments.push({ kind: "file", path, name: info.name, size: info.size });
      this.host.toastBig(info?.name ?? path);
    }
    await this.addPictures(found);
  }

  async pictureFromFile() {
    try {
      const files = await api.pickFiles(this.host.pickTitle(), true);
      for (const f of files.filter((f) => !isPictureName(f.name))) this.host.win.draft.attachments.push({ kind: "file", ...f });
      await this.insertPictureFiles(files.filter((f) => isPictureName(f.name)).map((f) => f.path));
    } catch (e) {
      this.host.fail(e);
    }
  }

  /** Pasted pictures: into the text of an HTML letter, attached to a Markdown one. */
  async pastedPictures(blobs: Blob[]) {
    const found = await picturesFromBlobs(blobs);
    if (this.host.format.format === "html") await this.addPictures(found);
    else await this.attachPictures(found);
  }

  async pictureFromClipboard() {
    const blobs = await clipboardPictures();
    if (blobs === null) return this.host.useCtrlV();
    if (!blobs.length) return this.host.noneInClipboard();
    await this.pastedPictures(blobs);
  }

  async attach() {
    try {
      for (const f of await api.pickFiles(this.host.attachTitle())) this.host.win.draft.attachments.push({ kind: "file", ...f });
    } catch (e) {
      this.host.fail(e);
    }
  }
}
