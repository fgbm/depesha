/** What a click or hover in a letter's frame is on: a text link, or a hot spot of an image map (`<area href>`), which the frame would follow by itself. */
export const LINK_SELECTOR = "a, area";

/** The link under the pointer, or null. */
export function linkAt(target: EventTarget | null): Element | null {
  return (target as Element | null)?.closest?.(LINK_SELECTOR) ?? null;
}
