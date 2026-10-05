// A plugin's banner in a narrow window: the first action stays a button, the rest and
// the details under a title fold into "⋯".

import type { Banner } from "../plugin-api";

type Action = NonNullable<Banner["actions"]>[number];

export interface Folded {
  /** The "⋯" menu is there. */
  folded: boolean;
  buttons: Action[];
  menu: Action[];
  /** The menu offers the details under `detailsTitle`. */
  detailsInMenu: boolean;
  details: { label: string; value: string }[];
}

/** `detailsOpen`: the details were asked for from the menu. */
export function foldBanner(b: Banner, narrow: boolean, detailsOpen: boolean): Folded {
  const actions = b.actions ?? [];
  const details = b.details ?? [];
  const titled = !!b.detailsTitle && details.length > 0;
  const folded = narrow && (actions.length > 1 || titled);
  return {
    folded,
    buttons: folded ? actions.slice(0, 1) : actions,
    menu: folded ? actions.slice(1) : [],
    detailsInMenu: folded && titled,
    details: folded && titled && !detailsOpen ? [] : details,
  };
}
