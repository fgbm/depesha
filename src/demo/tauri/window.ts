// The demo stand-in for `@tauri-apps/api/window`. A browser page has one window: the
// controls the interface drives (`WindowControls.svelte`, `MessageWindow.svelte`,
// `actions.svelte.ts`, `events.ts`) act on the page itself, and the ones that only make
// sense in a desktop window (minimize, maximize, a close request) are quiet no-ops.

import type { EventCallback, UnlistenFn } from "./event";

/** What the interface asks of the current window; a subset of Tauri's `Window`. */
export interface DemoWindow {
  close(): Promise<void>;
  destroy(): Promise<void>;
  setFocus(): Promise<void>;
  setTitle(title: string): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onResized(handler: EventCallback<unknown>): Promise<UnlistenFn>;
  onCloseRequested(handler: (event: { preventDefault(): void }) => void): Promise<UnlistenFn>;
}

const window_: DemoWindow = {
  async close() {},
  async destroy() {},
  async setFocus() {
    globalThis.focus?.();
  },
  async setTitle(title: string) {
    document.title = title;
  },
  async minimize() {},
  async toggleMaximize() {},
  async isMaximized() {
    return false;
  },
  async onResized(handler: EventCallback<unknown>): Promise<UnlistenFn> {
    const run = () => handler({ event: "tauri://resize", payload: { width: innerWidth, height: innerHeight } });
    addEventListener("resize", run);
    return () => removeEventListener("resize", run);
  },
  // Nothing can stop the page from closing; the app's own close question is not asked in the mockup.
  async onCloseRequested(_handler: (event: { preventDefault(): void }) => void): Promise<UnlistenFn> {
    return () => {};
  },
};

export function getCurrentWindow(): DemoWindow {
  return window_;
}
