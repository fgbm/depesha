// The action panel's one line (0.8.3, decision 1.9 В): the buttons never wrap and nothing leaves
// for «Ещё» by width. When the row with its labels does not fit the room it has, the labels go
// and the icons stay — a `title`/`aria-label` says what each does. The width is measured, so the
// labels come back as soon as there is room again.
//
// The row's buttons carry their labels as a `.lbl` (the core's) or a `.lbl2` (a plugin's). The
// needed width is the sum of the buttons and the gaps between them; the spacer `.sp` is left out
// of it, since it only takes the room that is left, and so is a menu (`.pop`), which is not part
// of the line. A label taken out of the flow is added back by its own width.

import { tick, untrack } from "svelte";

/** The gap between the row's buttons (`.row`), and between an icon and its label (`.btn`). */
const GAP = 4;
const IN_BUTTON = 6;
/** A few pixels of slack before the labels come back: no flicker at the boundary. */
const HYST = 4;

export function labelFit(deps: () => unknown) {
  const out = $state<{ el?: HTMLElement; icons: boolean }>({ el: undefined, icons: false });

  function fit() {
    const el = out.el;
    if (!el) return;
    const avail = el.clientWidth;
    // No layout to measure (jsdom, a hidden pane): the labels stay.
    if (!avail) return;
    const icons = untrack(() => out.icons);
    let needed = 0;
    let n = 0;
    for (const child of el.children) {
      const kid = child as HTMLElement;
      // The spacer takes what is left, a menu is not part of the line: neither is measured.
      if (kid.classList.contains("sp") || kid.classList.contains("pop")) continue;
      let w = kid.offsetWidth;
      if (icons) for (const part of kid.querySelectorAll<HTMLElement>(".lbl, .lbl2, kbd")) w += IN_BUTTON + part.offsetWidth;
      needed += (n ? GAP : 0) + w;
      n++;
    }
    // The labels go the moment the row needs more than it has; they come back with a few pixels
    // of slack, so a window sitting exactly on the boundary does not flicker.
    out.icons = icons ? needed > avail - HYST : needed > avail;
  }

  $effect(() => {
    // Read what the row depends on, so a new set of buttons is measured again.
    void deps();
    if (!out.el) return;
    void tick().then(fit);
    // jsdom has no ResizeObserver; the row is still fitted once.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(out.el);
    return () => ro.disconnect();
  });

  return out;
}
