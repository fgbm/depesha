/** Called as a window opens: remembers where the focus was and returns a function that puts it back there when the window goes. */
export function focusBack(): () => void {
  // The pages are also rendered on a server in the tests, where there is no document.
  const was = typeof document === "undefined" ? null : document.activeElement;
  return () => {
    if (was instanceof HTMLElement && was.isConnected) was.focus();
  };
}
