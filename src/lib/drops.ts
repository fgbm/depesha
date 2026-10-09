// Files dropped on the window. Tauri's own drop event reaches the page before the backend
// has allowed the files, so the page asked for them too early (#79). The backend allows
// them first and then says `files-dropped`; that is the one drop the page acts on.

import { listen } from "@tauri-apps/api/event";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import type { DropZone } from "./images";
import type { AppStore } from "./store.svelte";

interface FilesDropped {
  paths: string[];
  position: { x: number; y: number };
}

export function listenDrops(app: AppStore, zoneAt: (pos: PhysicalPosition) => DropZone | null) {
  return listen<FilesDropped>("files-dropped", async (e) => {
    const c = app.activeCompose();
    if (!c) return;
    const { paths, position } = e.payload;
    await app.compose.dropFiles(c, paths, zoneAt(new PhysicalPosition(position.x, position.y)));
  });
}
