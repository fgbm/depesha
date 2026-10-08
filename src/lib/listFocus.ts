/**
 * Roving focus of the message list (#94): the rows are focusable for a click and for the
 * reader, and the arrows move only the selection. While the keyboard focus is in the list
 * (on a row or on the list itself) it follows the opened row, so there is one indicator.
 * Focus elsewhere (search, sidebar, the letter) is left alone.
 */
export function followFocus(list: HTMLElement, row: HTMLElement | undefined): void {
  const at = document.activeElement;
  if (!row || !at || at === row || !list.contains(at)) return;
  row.focus({ preventScroll: true });
}
