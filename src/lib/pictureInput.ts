// Pictures going into an HTML editor: chosen as files, pasted or dropped. One way for the
// letter and for a signature: read as `data:` images, a large photo made smaller.

import { api } from "./api";
import { FIT_FROM, MAX_PICTURE, dataUrlSize, pictureHtml, pictureName, readAsDataUrl, shrinkPicture } from "./images";

export interface FoundPicture {
  name: string;
  dataUrl: string;
}

/**
 * The pictures as HTML for the text. One still too big after shrinking is left out and
 * given back in `tooBig`, as it was; one that could not be read, in `failed`.
 */
export async function picturesHtml(found: FoundPicture[]): Promise<{ html: string; tooBig: FoundPicture[]; failed: unknown[] }> {
  let html = "";
  const tooBig: FoundPicture[] = [];
  const failed: unknown[] = [];
  for (const p of found) {
    try {
      const ready = await shrinkPicture(p.dataUrl);
      if (dataUrlSize(ready.dataUrl) > MAX_PICTURE) {
        tooBig.push(p);
        continue;
      }
      html += pictureHtml(ready.dataUrl, ready.width > FIT_FROM ? "fit" : "natural");
    } catch (e) {
      failed.push(e);
    }
  }
  return { html, tooBig, failed };
}

/** Picture files read through the backend (only files the user picked or dropped); the paths it refused apart. */
export async function picturesFromFiles(paths: string[]): Promise<{ found: FoundPicture[]; refused: string[] }> {
  const found: FoundPicture[] = [];
  const refused: string[] = [];
  for (const path of paths) {
    const name = path.split(/[\\/]/).pop() ?? path;
    try {
      found.push({ name, dataUrl: await api.inlineImage(path) });
    } catch {
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
  } catch {
    return null;
  }
  return blobs;
}
