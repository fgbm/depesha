// Pictures going into an HTML editor: chosen as files, pasted or dropped. One way for the
// letter and for a signature: read as `data:` images, a large photo made smaller.

import { api } from "./api";
import { FIT_FROM, MAX_PICTURE, MAX_SIDE, dataUrlSize, dataUrlType, pictureHtml, pictureName, readAsDataUrl, shrinkPicture, type Picture } from "./images";

export interface FoundPicture {
  name: string;
  dataUrl: string;
}

/** A picture made small enough for the text, ready to go in. */
export interface ReadyPicture extends Picture {
  /** The shrunk `data:` URL. */
  dataUrl: string;
  /** Its width after shrinking, for "по ширине текста" or its own size. */
  width: number;
}

/**
 * The pictures as HTML for the text. One still too big after shrinking is left out and
 * given back in `tooBig`, as it was; one that could not be read, in `failed`. `ready` holds
 * the pictures that fit, for the ones a Markdown letter puts in as `![alt](…)`.
 */
export async function picturesHtml(found: FoundPicture[], maxSide = MAX_SIDE): Promise<{ html: string; ready: ReadyPicture[]; tooBig: FoundPicture[]; failed: unknown[] }> {
  let html = "";
  const ready: ReadyPicture[] = [];
  const tooBig: FoundPicture[] = [];
  const failed: unknown[] = [];
  for (const p of found) {
    try {
      const shrunk = await shrinkPicture(p.dataUrl, maxSide);
      if (dataUrlSize(shrunk.dataUrl) > MAX_PICTURE) {
        tooBig.push(p);
        continue;
      }
      html += pictureHtml(shrunk.dataUrl, shrunk.width > FIT_FROM ? "fit" : "natural");
      const at = shrunk.dataUrl.indexOf(",") + 1;
      ready.push({
        mime: dataUrlType(shrunk.dataUrl) || "image/png",
        base64: shrunk.dataUrl.slice(at),
        dataUrl: shrunk.dataUrl,
        width: shrunk.width,
      });
    } catch (e) {
      failed.push(e);
    }
  }
  return { html, ready, tooBig, failed };
}

/** Picture files read through the backend (only files the user picked or dropped); the paths it refused apart. */
export async function picturesFromFiles(paths: string[]): Promise<{ found: FoundPicture[]; refused: string[] }> {
  const found: FoundPicture[] = [];
  const refused: string[] = [];
  for (const path of paths) {
    const name = path.split(/[\\/]/).pop() ?? path;
    try {
      found.push({ name, dataUrl: await api.inlineImage(path) });
    } catch { // A picture that cannot be read is refused: the caller attaches it as a file.
      refused.push(path);
    }
  }
  return { found, refused };
}

/** Pasted pictures; those without a name get one by their kind. */
export async function picturesFromBlobs(blobs: Blob[]): Promise<FoundPicture[]> {
  const found: FoundPicture[] = [];
  let n = 0;
  for (const blob of blobs) found.push({ name: blob instanceof File && blob.name ? blob.name : pictureName(blob.type, ++n), dataUrl: await readAsDataUrl(blob) });
  return found;
}

/** The pictures on the clipboard; null when the system does not give the clipboard to the page (Ctrl+V does it). */
export async function clipboardPictures(): Promise<Blob[] | null> {
  const blobs: Blob[] = [];
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((x) => /^image\/(png|jpeg|gif|webp)$/.test(x));
      if (type) blobs.push(await item.getType(type));
    }
  } catch { // No clipboard access or no image: nothing to paste.
    return null;
  }
  return blobs;
}
