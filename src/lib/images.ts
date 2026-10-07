// Pictures in the text of an HTML letter. They live in the editor as `data:` images; the
// backend sends each as a part of its own the HTML calls by `cid:` (smtp::html_body).
// The pure part is covered by images.test.ts.

import type { BodyFormat } from "./types";

/** What every mail program shows; the backend takes the same ones out of the HTML. */
export const PICTURE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** A large photo is made this big on its long side when it goes in: the letter stays light. */
export const MAX_SIDE = 1600;

/**
 * A picture bigger than this, even made smaller, is attached instead. It is the size the
 * backend still shows inside a letter (`MAX_INLINE_IMAGE`): a saved draft opens with it.
 */
export const MAX_PICTURE = 5 * 1024 * 1024;

export function isPictureName(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return name.includes(".") && PICTURE_EXTENSIONS.includes(ext);
}

export function isPictureType(mime: string): boolean {
  return PICTURE_TYPES.includes(mime.toLowerCase());
}

/** The size within `max` on the long side, proportions kept; a smaller picture keeps its own. */
export function fitSide(width: number, height: number, max = MAX_SIDE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max || long <= 0) return { width, height };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** The bytes a `data:…;base64,` URL carries. */
export function dataUrlSize(url: string): number {
  const at = url.indexOf("base64,");
  if (at < 0) return 0;
  const data = url.slice(at + 7).replace(/\s/g, "");
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - pad);
}

/** The MIME type of a `data:` URL. */
export function dataUrlType(url: string): string {
  return /^data:([^;,]+)/i.exec(url)?.[1]?.toLowerCase() ?? "";
}

/** Where a drop on the composition window goes: into the text, or attached as files. */
export type DropZone = "inline" | "attach";

/** The two zones are offered to a formatted letter; only a picture makes them come up. */
export function offersZones(names: string[], format: BodyFormat): boolean {
  return (format === "html" || format === "markdown") && names.some(isPictureName);
}

/**
 * What a drop does. Pictures dropped on "Insert into text" go into the text — as `data:`
 * images in HTML, as Markdown in Markdown (decision on #45); other files, and everything
 * dropped elsewhere or on a plain-text letter, are attached.
 */
export function dropPlan(names: string[], format: BodyFormat, zone: DropZone | null): { inline: string[]; attach: string[] } {
  const inText = zone === "inline" && (format === "html" || format === "markdown");
  const inline = inText ? names.filter(isPictureName) : [];
  return { inline, attach: names.filter((n) => !inline.includes(n)) };
}

/** The two sizes a picture in the text may have: the width of the text, or its own. */
export type PictureSize = "fit" | "natural";

/** Wider than the text, a picture goes in at the text's width. */
export const FIT_FROM = 600;

export function pictureHtml(dataUrl: string, size: PictureSize): string {
  const style = size === "fit" ? ' style="width:100%;height:auto"' : "";
  return `<img src="${dataUrl.replace(/"/g, "%22")}"${style}>`;
}

/** A picture of the HTML that goes out with the letter, as a file. */
export interface Picture {
  mime: string;
  base64: string;
}

/** Takes the `data:` pictures out of the HTML, for a letter that will have no HTML. */
export function takePictures(html: string): { html: string; pictures: Picture[] } {
  const pictures: Picture[] = [];
  const out = html.replace(/<img\b[^>]*?\bsrc\s*=\s*["']data:([^;"',]+);base64,([^"']*)["'][^>]*>/gi, (_all, mime: string, data: string) => {
    if (isPictureType(mime)) pictures.push({ mime: mime.toLowerCase(), base64: data.replace(/\s/g, "") });
    return "";
  });
  return { html: out, pictures };
}

export function pictureName(mime: string, n: number): string {
  const ext = { "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[mime] ?? "png";
  return `image${n}.${ext}`;
}

/** The size of the pictures an HTML letter carries in its text. */
export function picturesSize(html: string): number {
  let total = 0;
  for (const m of html.matchAll(/\bsrc\s*=\s*["'](data:[^"']*)["']/gi)) total += dataUrlSize(m[1]);
  return total;
}

/**
 * A picture made ready for the text: a photo larger than `MAX_SIDE` is drawn smaller,
 * as JPEG (PNG keeps transparency, GIF keeps its frames and size). Needs a document.
 */
export async function shrinkPicture(dataUrl: string, maxSide = MAX_SIDE): Promise<{ dataUrl: string; width: number }> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const type = dataUrlType(dataUrl);
  const { width, height } = fitSide(img.naturalWidth, img.naturalHeight, maxSide);
  if (type === "image/gif" || (width === img.naturalWidth && height === img.naturalHeight)) return { dataUrl, width: img.naturalWidth };
  return { dataUrl: redraw(img, type, width, height), width };
}

/**
 * A picture drawn no wider than it is shown (a logo of a signature, sent with every
 * letter); a narrower one, or a GIF, stays as it is.
 */
export async function shrinkToWidth(dataUrl: string, shown: number): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const type = dataUrlType(dataUrl);
  const width = Math.max(1, Math.round(shown));
  if (type === "image/gif" || img.naturalWidth <= width) return dataUrl;
  const out = redraw(img, type, width, Math.max(1, Math.round((img.naturalHeight * width) / img.naturalWidth)));
  return dataUrlSize(out) < dataUrlSize(dataUrl) ? out : dataUrl;
}

/** PNG keeps transparency; anything else becomes a JPEG. */
function redraw(img: HTMLImageElement, type: string, width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")?.drawImage(img, 0, 0, width, height);
  return type === "image/png" ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.85);
}

/** A file or a piece of the clipboard as a `data:` URL. */
export function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
