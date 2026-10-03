import type { Theme } from "./types";

export const THEMES: Theme[] = ["system", "paper", "night", "snow", "graphite"];

const KEY = "depesha.theme";

/** Colours come from `:root[data-theme=…]` in app.css; `system` leaves the attribute off. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system" || !THEMES.includes(theme)) root.removeAttribute("data-theme");
  else root.dataset.theme = theme;
  // The settings arrive from the backend after the first paint: start with the last theme.
  localStorage.setItem(KEY, theme);
}

export function applySavedTheme() {
  applyTheme((localStorage.getItem(KEY) as Theme | null) ?? "system");
}
