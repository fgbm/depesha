// A file attached from a window that has closed since (a restored draft) is no longer allowed to
// go: the backend answers `not-chosen` to a send or a save (#115). The window takes the file off
// the letter and keeps a notice of it that outlives the save errors: the letter must not go out
// without the file unnoticed. The notice goes when the file is attached again or the user closes it.

import { api } from "../api";
import { t } from "../i18n.svelte";
import type { ComposeDraft } from "../types";

/** What of a composition window the notice needs. */
export interface LostFilesWindow {
  draft: Pick<ComposeDraft, "attachments">;
  /** The names of the files taken off and not attached again. */
  lostFiles?: string[];
}

/** The backend refused a file as one the user did not choose in this window. */
export function isNotChosen(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { kind?: string }).kind === "not-chosen";
}

/**
 * Asks the backend about each file of the letter (`file_info` is judged as a send is), takes off
 * those that are no longer allowed and notes their names in the window. Whether any was.
 */
export async function dropLostFiles(win: LostFilesWindow): Promise<boolean> {
  const lost = new Set<string>();
  for (const a of win.draft.attachments) {
    if (a.kind !== "file") continue;
    try {
      await api.fileInfo(a.path);
    } catch (e) {
      if (isNotChosen(e)) lost.add(a.path);
    }
  }
  if (!lost.size) return false;
  const gone = win.draft.attachments.filter((a) => a.kind === "file" && lost.has(a.path)).map((a) => a.name);
  win.draft.attachments = win.draft.attachments.filter((a) => !(a.kind === "file" && lost.has(a.path)));
  win.lostFiles = [...new Set([...(win.lostFiles ?? []), ...gone])];
  return true;
}

/** A file attached again (under its name) is no longer lost. */
export function settleLostFiles(win: LostFilesWindow): void {
  const left = (win.lostFiles ?? []).filter((name) => !win.draft.attachments.some((a) => a.kind === "file" && a.name === name));
  if (left.length !== (win.lostFiles ?? []).length) win.lostFiles = left;
}

/** The notice the window shows, empty when no file is lost. */
export function lostNotice(win: LostFilesWindow): string {
  return (win.lostFiles ?? []).map((name) => t("compose.fileLost", { name })).join(" ");
}

/** The question a send asks while a file is lost, empty when none is. */
export function sendWithoutQuestion(win: LostFilesWindow): string {
  const names = win.lostFiles ?? [];
  if (!names.length) return "";
  return names.length === 1 ? t("compose.sendWithoutFile", { name: names[0] }) : t("compose.sendWithoutFiles", { names: names.join(", ") });
}
