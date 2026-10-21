import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOOKS, applySavedTheme, applyTheme, themeOf } from "./theme";

describe("the saved theme", () => {
  it("moves the themes of before 0.8.12 onto «Ink», keeping their light", () => {
    expect(themeOf("paper", "ink")).toEqual({ look: "ink", scheme: "light" });
    expect(themeOf("snow", "ink")).toEqual({ look: "ink", scheme: "light" });
    expect(themeOf("night", "ink")).toEqual({ look: "ink", scheme: "dark" });
    expect(themeOf("graphite", "ink")).toEqual({ look: "ink", scheme: "dark" });
    expect(themeOf("system", "ink")).toEqual({ look: "ink", scheme: "system" });
  });

  it("reads a look and a light as they are, and «Ink» as the system says for what it does not know", () => {
    expect(themeOf("dark", "pine")).toEqual({ look: "pine", scheme: "dark" });
    expect(themeOf("light", "paper")).toEqual({ look: "paper", scheme: "light" });
    expect(themeOf("future", "")).toEqual({ look: "ink", scheme: "system" });
    expect(themeOf("light", "hologram")).toEqual({ look: "ink", scheme: "light" });
  });
});

describe("the root's data-theme", () => {
  let dark = false;
  const root = { dataset: {} as Record<string, string> };
  const store = new Map<string, string>();
  const listeners: (() => void)[] = [];

  beforeEach(() => {
    root.dataset = {};
    store.clear();
    vi.stubGlobal("document", { documentElement: root });
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    vi.stubGlobal("matchMedia", () => ({ get matches() { return dark; }, addEventListener: (_: string, f: () => void) => listeners.push(f) }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("names the look and the light of every pair", () => {
    for (const look of LOOKS) {
      for (const scheme of ["light", "dark"]) {
        applyTheme(scheme, look);
        expect(root.dataset.theme).toBe(`${look}-${scheme}`);
      }
    }
  });

  it("takes the system's light and follows it when it changes", () => {
    dark = false;
    applyTheme("system", "salt");
    expect(root.dataset.theme).toBe("salt-light");
    dark = true;
    for (const f of listeners) f();
    expect(root.dataset.theme).toBe("salt-dark");
  });

  it("starts with the last theme, an old one too", () => {
    dark = false;
    store.set("depesha.theme", "graphite");
    applySavedTheme();
    expect(root.dataset.theme).toBe("ink-dark");
    applyTheme("light", "wax");
    root.dataset = {};
    applySavedTheme();
    expect(root.dataset.theme).toBe("wax-light");
  });
});
