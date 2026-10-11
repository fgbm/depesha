// A file attached from a window that has closed since (a restored draft) is no longer allowed to
// go: the backend answers `not-chosen` to a send or a save (#115). The window says which file
// must be attached again and takes it off the letter, so the user adds it anew.

import { api } from "../api";
import { t } from "../i18n.svelte";
import type { ComposeDraft } from "../types";

/** The backend refused a file as one the user did not choose in this window. */
export function isNotChosen(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { kind?: string }).kind === "not-chosen";
}

/**
 * Asks the backend about each file of the letter (`file_info` is judged as a send is), takes off
 * those that are no longer allowed, and returns the words for the window, none when no file is
 * to blame.
 */
export async function dropLostFiles(draft: Pick<ComposeDraft, "attachments">): Promise<string | null> {
  const lost = new Set<string>();
  for (const a of draft.attachments) {
    if (a.kind !== "file") continue;
    try {
      await api.fileInfo(a.path);
    } catch (e) {
      if (isNotChosen(e)) lost.add(a.path);
    }
  }
  if (!lost.size) return null;
  const names = draft.attachments.filter((a) => a.kind === "file" && lost.has(a.path)).map((a) => a.name);
  draft.attachments = draft.attachments.filter((a) => !(a.kind === "file" && lost.has(a.path)));
  return names.map((name) => t("compose.fileLost", { name })).join(" ");
}
