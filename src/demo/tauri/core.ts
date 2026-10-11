// The demo stand-in for `@tauri-apps/api/core`: `invoke` goes to the in-memory backend
// (`src/demo/backend.ts`) instead of the Rust one. Aliased in `vite.config.ts` in `demo` mode only.

import { backend } from "../backend";

export type InvokeArgs = Record<string, unknown> | number[] | ArrayBuffer | Uint8Array;

export async function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  return (await backend.invoke(cmd, args)) as T;
}

/** An asset URL. A live mockup has no `asset:` scheme and no extensions running: an empty page. */
export function convertFileSrc(_filePath: string, _protocol = "asset"): string {
  return "about:blank";
}
