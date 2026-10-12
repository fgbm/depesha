// The action panel's one line (0.8.3, decision 1.9 В): the buttons never wrap and nothing leaves
// for «Ещё» by width. When the row with its labels does not fit the room it has, the labels go
// and the icons stay — a `title`/`aria-label` says what each does. The width is measured, so the
// labels come back as soon as there is room again.
//
// The row's buttons carry their labels as a `.lbl` (the core's) or a `.lbl2` (a plugin's).

import { tick, untrack } from "svelte";

/** The gap between an icon and its label inside a button (`.btn`). */
const IN_BUTTON = 6;

export function labelFit(deps: () => unknown) {
  const out = $state<{ el?: HTMLElement; icons: boolean }>({ el: undefined, icons: false });

  function fit() {
    const el = out.el;
    if (!el) return;
    const avail = el.clientWidth;
    // No layout to measure (jsdom, a hidden pane): the labels stay.
    if (!avail) return;
    const icons = untrack(() => out.icons);
    // The row's own scroll width is what the buttons and «Ещё» take; with the labels out of the
    // flow their width is added back here.
    let width = el.scrollWidth;
    if (icons) for (const label of el.querySelectorAll<HTMLElement>(".lbl, .lbl2")) width += IN_BUTTON + label.offsetWidth;
    out.icons = width > avail;
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
