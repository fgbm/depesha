/** The link a click or hover in a letter's frame is on: a text link, or a hot spot of an image map (`<area href>`), which the frame would follow by itself. */
export function linkAt(target: EventTarget | null): Element | null {
  return (target as Element | null)?.closest?.("a, area") ?? null;
}
