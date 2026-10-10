/** The app runs on macOS: its keys and its web view differ (Cmd for commands, no `window.print()` from a frame). */
export function isMac(): boolean {
  return /Mac/i.test(navigator.platform || navigator.userAgent);
}

/** The key that pastes, as the toast that sends the user to it names it. */
export function pasteKey(mac = isMac()): string {
  return mac ? "⌘V" : "Ctrl+V";
}
