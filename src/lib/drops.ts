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

export function listenDrops(app: AppStore, zoneAt: (pos: PhysicalPosition) => DropZone | null) {
  // The global `listen` hears events sent to any window; this one only those for ours.
  return getCurrentWebview().listen<FilesDropped>("files-dropped", (e) => {
    heard(e.payload.paths.length);
    return attach(app, zoneAt, e.payload);
  });
}
