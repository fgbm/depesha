/**
 * The plugin's state shared by its parts. `count`: letters waiting; `closed`: waits kept
 * after they ended; `tab`: what the view shows; `repick`: the letter "Set a new date" or
 * "Wait for a reply again" was asked for, and how to show the new date on it.
 */
export const followups = $state<{
  count: number;
  closed: number;
  tab: "active" | "closed";
  repick: { id: number; set: (due: number) => void } | null;
}>({ count: 0, closed: 0, tab: "active", repick: null });
