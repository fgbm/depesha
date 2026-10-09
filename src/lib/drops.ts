// Files dropped on the window. Tauri's own drop event reaches the page before the backend
// has allowed the files, so the page asked for them too early (#79). The backend allows
// them first and then says `files-dropped`; that is the one drop the page acts on.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { api } from "./api";
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

async function attach(app: AppStore, zoneAt: (pos: PhysicalPosition) => DropZone | null, drop: FilesDropped) {
  const c = app.activeCompose();
  if (!c) return;
  await app.compose.dropFiles(c, drop.paths, zoneAt(new PhysicalPosition(drop.position.x, drop.position.y)));
}

/**
 * The whole of dropping for a window: the highlight of the zone under the pointer while
 * files are dragged over it, and the drop itself from the backend. Returns the way to stop.
 */
export function watchDrops(app: AppStore): () => void {
  const zoneAt = (pos: PhysicalPosition): DropZone | null => {
    const { x, y } = pos.toLogical(window.devicePixelRatio);
    const zone = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-zone]")?.dataset.dropZone;
    return zone === "inline" || zone === "attach" ? zone : null;
  };
  const unlisten = getCurrentWebview().onDragDropEvent((e) => {
    const c = app.activeCompose();
    const p = e.payload;
    if (!c) return;
    if (p.type === "enter") app.compose.dragEnter(c, p.paths);
    else if (p.type === "over" && app.compose.dragging) app.compose.dragging.zone = zoneAt(p.position);
    else if (p.type === "leave") app.compose.dragging = null;
    // A drop comes from `listenDrops`: the backend allows the files first (#79).
  });
  const unlistenDrops = listenDrops(app, zoneAt);
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
