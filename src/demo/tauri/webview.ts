// The demo stand-in for `@tauri-apps/api/webview`. Files cannot really be dropped on a
// browser page the way Tauri reports them, so both subscriptions are quiet: the drop zone
// highlight and the `files-dropped` event never fire, and `watchDrops` returns its stop.

import type { EventCallback, UnlistenFn } from "./event";

interface DemoWebview {
  listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn>;
  onDragDropEvent(handler: EventCallback<unknown>): Promise<UnlistenFn>;
}

const quiet: UnlistenFn = () => {};

const webview: DemoWebview = {
  async listen<T>(_event: string, _handler: EventCallback<T>): Promise<UnlistenFn> {
    return quiet;
  },
  async onDragDropEvent(_handler: EventCallback<unknown>): Promise<UnlistenFn> {
    return quiet;
  },
};

export function getCurrentWebview(): DemoWebview {
  return webview;
}
