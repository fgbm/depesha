// Files dropped on the window. Tauri's own drop event reaches the page before the backend
// has allowed the files, so the page asked for them too early (#79). The backend allows
// them first and then says `files-dropped`; that is the one drop the page acts on.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { api } from "./api";
import { t } from "./i18n.svelte";
import type { DropZone } from "./images";
import type { AppStore } from "./store.svelte";

interface FilesDropped {
  paths: string[];
  position: { x: number; y: number };
}

/** The backend log hears of the drop (a count, no names); a failing log is not worth a drop. */
function heard(count: number) {
  api.dropSeen(count).catch(() => {});
}

/**
 * The drop zone under a pointer given in physical pixels, as Tauri reports it. This is the
 * one place physical becomes logical: the page lays out in CSS pixels, which on a screen
 * scaled to 125–150 % (Windows) are fewer than the physical ones (#79).
 */
export function zoneAt(pos: PhysicalPosition, scale: number): DropZone | null {
  const { x, y } = pos.toLogical(scale);
  const zone = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-zone]")?.dataset.dropZone;
  return zone === "inline" || zone === "attach" ? zone : null;
}

/** What became of a drop; the backend log gets it, numbers only (the pointer and the window in logical pixels). */
function outcome(kind: "attached" | "no_compose" | "missed_zone", attached: number, pos: PhysicalPosition) {
  const scale = window.devicePixelRatio || 1;
  const { x, y } = pos.toLogical(scale);
  api
    .dropOutcome({ outcome: kind, attached, x, y, width: window.innerWidth, height: window.innerHeight })
    .catch(() => {});
}

/** A pointer the page cannot place is a miss; the files are still attached. */
function zoneOrNull(zoneAt: (pos: PhysicalPosition) => DropZone | null, pos: PhysicalPosition): DropZone | null {
  try {
    return zoneAt(pos);
  } catch {
    return null;
  }
}

async function attach(app: AppStore, zoneAt: (pos: PhysicalPosition) => DropZone | null, drop: FilesDropped) {
  const pos = new PhysicalPosition(drop.position.x, drop.position.y);
  const c = app.activeCompose();
  if (!c) return noCompose(app, drop, pos);
  const zones = !!app.compose.dragging?.zones;
  const zone = zoneOrNull(zoneAt, pos);
  const before = c.draft.attachments.length;
  await app.compose.dropFiles(c, drop.paths, zone);
  // A miss in a letter that offers zones still attaches the files, as plain attachments.
  outcome(zones && !zone ? "missed_zone" : "attached", c.draft.attachments.length - before, pos);
}

/** A drop with nowhere to go is told, not dropped in silence. */
function noCompose(app: AppStore, drop: FilesDropped, pos: PhysicalPosition) {
  outcome("no_compose", 0, pos);
  if (drop.paths.length) app.toast(t("drop.nowhere"));
}

/**
 * The whole of dropping for a window: the highlight of the zone under the pointer while
 * files are dragged over it, and the drop itself from the backend. Returns the way to stop.
 */
export function watchDrops(app: AppStore): () => void {
  const here = (pos: PhysicalPosition) => zoneAt(pos, window.devicePixelRatio || 1);
  const unlisten = getCurrentWebview().onDragDropEvent((e) => {
    const c = app.activeCompose();
    const p = e.payload;
    if (!c) return;
    if (p.type === "enter") app.compose.dragEnter(c, p.paths);
    else if (p.type === "over" && app.compose.dragging) app.compose.dragging.zone = here(p.position);
    else if (p.type === "leave") app.compose.dragging = null;
    // A drop comes from `listenDrops`: the backend allows the files first (#79).
  });
  const unlistenDrops = listenDrops(app, here);
  return () => {
    unlisten.then((f) => f());
    unlistenDrops.then((f) => f());
  };
}

export function listenDrops(app: AppStore, zoneAt: (pos: PhysicalPosition) => DropZone | null) {
  // The global `listen` hears events sent to any window; this one only those for ours.
  return getCurrentWebview().listen<FilesDropped>("files-dropped", (e) => {
    heard(e.payload.paths.length);
    return attach(app, zoneAt, e.payload);
  });
}
