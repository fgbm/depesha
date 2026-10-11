// The demo stand-in for `@tauri-apps/plugin-opener`. Links open in the browser tab, which is
// what a live mockup can honestly do; revealing a file in the system manager is a no-op.

export async function openUrl(url: string): Promise<void> {
  globalThis.open?.(url, "_blank", "noopener");
}

export async function openPath(_path: string): Promise<void> {}

export async function revealItemInDir(_path: string): Promise<void> {}
