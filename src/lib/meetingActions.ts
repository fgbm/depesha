// What the card of a meeting does with its file (0.8.13, decision 1.1 А): the file goes to the
// calendar of the system, into the folder for attachments or where the user points, and the
// address of the video meeting goes to the clipboard. The card, a letter of the chain and the
// palette do the same thing, so the words of the toasts and the failures are said here once.

import { api } from "./api";
import { t } from "./i18n.svelte";
import { app } from "./store.svelte";
import type { AttachmentInfo, MessageView } from "./types";

/** The `.ics` the calendar came as, among the letter's files; none when the calendar is one of
 *  the letter's own forms and there is no file to save. */
export function meetingFile(view: MessageView | null | undefined): AttachmentInfo | undefined {
  const index = view?.calendar?.file;
  if (!view || index === null || index === undefined) return undefined;
  const files = view.attachments.filter((a) => !(a.inline && a.content_id));
  return files.find((a) => a.index === index);
}

/** Hands the file to the calendar of the system: Depesha keeps no calendar of its own. */
export async function addMeeting(id: number, a: AttachmentInfo): Promise<void> {
  try {
    await app.ui.track(api.attachmentOpen(id, a.index));
  } catch (e) {
    app.ui.fail(e);
  }
}

/** Saves the file into `dir`, or asks where it goes when no folder for attachments is set. */
export async function saveMeeting(id: number, a: AttachmentInfo, dir: string): Promise<void> {
  try {
    if (dir) {
      const path = await app.ui.track(api.attachmentSaveIn(id, a.index));
      app.ui.toast(t("file.savedTo", { name: path.split(/[\\/]/).pop() ?? a.name, dir }));
      return;
    }
    const path = await api.pickSaveFile(t("file.saveTitle"), a.name);
    if (!path) return;
    await app.ui.track(api.attachmentSave(id, a.index, path));
    app.ui.toast(t("file.saved", { name: a.name }));
  } catch (e) {
    app.ui.fail(e);
  }
}

/** Puts the address of the video meeting into the clipboard and says so. */
export async function copyMeetingLink(link: string): Promise<void> {
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    app.ui.toast(t("cal.linkCopied"));
  } catch (e) {
    app.ui.fail(e);
  }
}
