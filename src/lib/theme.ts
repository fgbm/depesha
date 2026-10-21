/** The looks in the order the tiles stand and ← / → go; «Ink» is the default (0.8.12). */
export const LOOKS = ["ink", "pine", "office", "wax", "salt", "paper"] as const;
export type Look = (typeof LOOKS)[number];

/** The light, apart from the look: its own setting, «Theme». */
export const SCHEMES = ["light", "dark", "system"] as const;
export type Scheme = (typeof SCHEMES)[number];

const KEY = "depesha.theme";
const LOOK_KEY = "depesha.look";

// Before 0.8.12 a theme was a look and a light at once; the old light ones and the old dark
// ones all become «Ink».
const OLD: Record<string, Scheme> = { paper: "light", snow: "light", night: "dark", graphite: "dark" };

/** What a saved pair means: a light and a look, whatever version saved them. */
export function themeOf(theme: string, look: string): { look: Look; scheme: Scheme } {
  const scheme = OLD[theme] ?? ((SCHEMES as readonly string[]).includes(theme) ? (theme as Scheme) : "system");
  return { look: (LOOKS as readonly string[]).includes(look) ? (look as Look) : "ink", scheme };
}

const systemDark = () => matchMedia("(prefers-color-scheme: dark)");

/** The light shown now: the system's, when the setting follows it. */
export function lightOf(theme: string): "light" | "dark" {
  const { scheme } = themeOf(theme, "");
  if (scheme !== "system") return scheme;
  return systemDark().matches ? "dark" : "light";
}

let shown = { theme: "system", look: "ink" };
let following = false;

/** Colours come from `:root[data-theme="<look>-<light>"]` in app.css. */
export function applyTheme(theme: string, look: string) {
  const t = themeOf(theme, look);
  shown = { theme: t.scheme, look: t.look };
  document.documentElement.dataset.theme = `${t.look}-${lightOf(t.scheme)}`;
  // The settings arrive from the backend after the first paint: start with the last theme.
  localStorage.setItem(KEY, t.scheme);
  localStorage.setItem(LOOK_KEY, t.look);
  if (!following) {
    following = true;
    systemDark().addEventListener("change", () => applyTheme(shown.theme, shown.look));
  }
}

export function applySavedTheme() {
  applyTheme(localStorage.getItem(KEY) ?? "system", localStorage.getItem(LOOK_KEY) ?? "ink");
}
