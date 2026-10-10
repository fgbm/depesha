// The attachment viewer: one shell, renderers chosen from a registry of formats.
// The core's renderers (src/lib/viewers.ts) and plugins' (`ctx.ui.fileViewer`) are
// registered alike; the one that takes a file with the highest priority shows it.

import type { Component } from "svelte";

/** An attachment as a renderer sees it. */
export interface ViewedFile {
  name: string;
  mime: string;
  size: number;
  /** The content; loaded once and shared, so asking twice costs nothing. */
  bytes(): Promise<ArrayBuffer>;
  /** The content as text: UTF-8 when it decodes cleanly, else Windows-1251; cut at `TEXT_LIMIT`. */
  text(): Promise<{ text: string; cut: boolean }>;
  /** Opens a web link after the user confirms the real address. */
  openLink(href: string): void;
  /** The renderer gave up: the shell offers to open the file in its application instead. */
  fail(e: unknown): void;
}

export interface FileViewer {
  id: string;
  /** Extensions it takes, lower case without the dot. */
  extensions?: string[];
  /** Types it takes: exact, or a family like "image/*"; used when the extension says nothing. */
  mimes?: string[];
  /** Finer choice than extensions and types; returning true takes the file. */
  match?: (file: { name: string; mime: string }) => boolean;
  /** Higher wins. The core's renderers have 0, so a plugin's takes over the same format. */
  priority?: number;
  /** Props are the renderer's business, hence `any`; the shell adds `file`. */
  component: Component<any>;
  props?: Record<string, unknown>;
}

/** File types that are never shown from a letter, whatever renderer claims them; the backend refuses to open them too. */
const DANGEROUS = new Set([
  "exe", "msi", "bat", "cmd", "com", "scr", "pif", "vbs", "vbe", "js", "jse", "wsf", "wsh", "ps1", "jar", "lnk",
  "desktop", "sh", "run", "appimage", "deb", "rpm", "reg", "hta", "cpl", "msc",
]);

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function takes(v: FileViewer, name: string, mime: string): 0 | 1 | 2 {
  try {
    if (v.match?.({ name, mime })) return 2;
  } catch (e) {
    console.error(`viewer ${v.id}:`, e);
  }
  const ext = extOf(name);
  if (ext && v.extensions?.includes(ext)) return 2;
  const m = mime.toLowerCase();
  if (v.mimes?.some((p) => (p.endsWith("/*") ? m.startsWith(p.slice(0, -1)) : m === p))) return 1;
  return 0;
}

/**
 * The renderer for a file: by its extension or a `match`, then by its type when no
 * renderer knows the extension (a type says less: mail often sends octet-stream).
 */
export function pickViewer(viewers: FileViewer[], name: string, mime: string): FileViewer | null {
  if (DANGEROUS.has(extOf(name))) return null;
  let best: FileViewer | null = null;
  let bestRank = 0;
  let bestPriority = -Infinity;
  for (const v of viewers) {
    const rank = takes(v, name, mime);
    const priority = v.priority ?? 0;
    if (rank > bestRank || (rank && rank === bestRank && priority > bestPriority)) {
      best = v;
      bestRank = rank;
      bestPriority = priority;
    }
  }
  return best;
}

/** The MIME type a blob is given, so the webview knows what it decodes. */
export function blobType(name: string, mime: string): string {
  if (extOf(name) === "svg") return "image/svg+xml";
  return mime && mime !== "application/octet-stream" ? mime : "";
}

/** Text shown at most; a longer file is cut with a note. */
export const TEXT_LIMIT = 5 * 1024 * 1024;

/**
 * Text of a file in an unknown encoding: UTF-8 (with or without BOM, or UTF-16
 * with BOM) when it decodes cleanly, otherwise Windows-1251, which is what Russian
 * offices still send.
 */
export function decodeText(bytes: Uint8Array): { text: string; cut: boolean } {
  const cut = bytes.length > TEXT_LIMIT;
  const part = cut ? bytes.subarray(0, TEXT_LIMIT) : bytes;
  const utf16 = part[0] === 0xff && part[1] === 0xfe ? "utf-16le" : part[0] === 0xfe && part[1] === 0xff ? "utf-16be" : null;
  if (utf16) return { text: new TextDecoder(utf16).decode(part), cut };
  try {
    // A cut may split a character: `stream` keeps the tail instead of failing on it.
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(part, { stream: cut }), cut };
  } catch { // Not UTF-8: read as windows-1251.
    return { text: new TextDecoder("windows-1251").decode(part), cut };
  }
}

/** Rows of a CSV/TSV file; the delimiter is guessed from the first line. */
export function parseCsv(text: string, tsv = false): string[][] {
  const first = text.slice(0, text.indexOf("\n") >>> 0);
  const count = (c: string) => first.split(c).length - 1;
  const delim = tsv ? "\t" : ([";", "\t", ","] as const).reduce((best, c) => (count(c) > count(best) ? c : best), ",");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
