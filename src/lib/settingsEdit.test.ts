import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "./i18n.svelte";
import { RowEditor, largeParts, largeToMb } from "./settingsEdit";
import { PAGES, type RowContext, type RowSpec } from "./settingsCatalog";
import { settings as makeSettings } from "./testing";
import type { Settings } from "./types";

type Commit = { row: string; patch: Record<string, unknown>; what: string; label?: string };

/** An editor over in-memory settings; the commits it makes are recorded and applied. */
function editor(over: Partial<Settings> = {}, ctx: Partial<RowContext> = {}) {
  const state = { s: { ...makeSettings(), ...over } as Settings, commits: [] as Commit[] };
  const e = new RowEditor({
    settings: () => state.s,
    ctx: () => ({ accounts: [], noTray: false, ...ctx }),
    auto: {
      commit: async (row, patch, what, label) => {
        state.commits.push({ row, patch, what, label });
        state.s = { ...state.s, ...patch } as Settings;
        return true;
      },
    },
  });
  return { e, state };
}

/** A row of the catalog by id. */
function row<K extends RowSpec["kind"]>(id: string, kind: K): Extract<RowSpec, { kind: K }> {
  const found = PAGES.flatMap((p) => p.groups.flatMap((g) => g.rows)).find((r) => r.id === id);
  if (!found || found.kind !== kind) throw new Error(`no ${kind} row ${id}`);
  return found as Extract<RowSpec, { kind: K }>;
}

beforeEach(() => {
  i18n.lang = "ru";
});

describe("a switch", () => {
  it("writes the key and says what changed", async () => {
    const { e, state } = editor({ threads: true });
    await e.toggle(row("threads", "toggle"), false);
    expect(state.commits).toHaveLength(1);
    expect(state.commits[0].patch).toEqual({ threads: false });
    expect(state.commits[0].what).toContain("Собирать переписку в цепочки");
  });
});

describe("a typed number (#102, 1.7: a wrong one is not saved)", () => {
  it("saves a number within the limits", async () => {
    const { e, state } = editor();
    expect(await e.setNumber(row("image_max_px", "number"), "1200")).toBeNull();
    expect(state.commits[0].patch).toEqual({ image_max_px: 1200 });
  });

  it("refuses a number out of the limits and writes nothing", async () => {
    const { e, state } = editor();
    const error = await e.setNumber(row("image_max_px", "number"), "99999");
    expect(error).toContain("200");
    expect(error).toContain("8000");
    expect(state.commits).toEqual([]);
  });

  it("refuses text", async () => {
    const { e, state } = editor();
    expect(await e.setNumber(row("image_max_px", "number"), "много")).not.toBeNull();
    expect(state.commits).toEqual([]);
  });
});

describe("a time of day", () => {
  it("saves it in the form the menus read", async () => {
    const { e, state } = editor();
    expect(await e.setClock(row("day_start", "clock"), "09:30")).toBeNull();
    expect(state.commits[0].patch).toEqual({ day_start: "9:30" });
  });

  it("refuses a time that is not on the clock", async () => {
    const { e, state } = editor();
    expect(await e.setClock(row("day_start", "clock"), "25:99")).toContain("9:00");
    expect(state.commits).toEqual([]);
  });
});

describe("the threshold of a large letter", () => {
  it("is shown in gigabytes when it is a whole number of them", () => {
    expect(largeParts(25)).toEqual({ n: 25, unit: "mb" });
    expect(largeParts(2048)).toEqual({ n: 2, unit: "gb" });
    expect(largeParts(1536)).toEqual({ n: 1536, unit: "mb" });
    expect(largeToMb(2, "gb")).toBe(2048);
  });

  it("is saved in megabytes whatever the unit", async () => {
    const { e, state } = editor();
    expect(await e.setLarge(row("large_mb", "numunit"), "3", "gb")).toBeNull();
    expect(state.commits[0].patch).toEqual({ large_mb: 3072 });
  });

  it("refuses zero", async () => {
    const { e, state } = editor();
    expect(await e.setLarge(row("large_mb", "numunit"), "0", "mb")).not.toBeNull();
    expect(state.commits).toEqual([]);
  });
});

describe("the two quota levels", () => {
  it("are saved in order", async () => {
    const { e, state } = editor();
    expect(await e.setLevels(row("quota_levels", "pair"), ["97", "85"])).toBeNull();
    expect(state.commits[0].patch).toEqual({ quota_levels: [85, 97] });
  });

  it("are refused when one of them is not a percent", async () => {
    const { e, state } = editor();
    expect(await e.setLevels(row("quota_levels", "pair"), ["90", "100"])).not.toBeNull();
    expect(await e.setLevels(row("quota_levels", "pair"), ["", "95"])).not.toBeNull();
    expect(state.commits).toEqual([]);
  });
});

describe("the working days", () => {
  it("switch one day on or off and keep the order", async () => {
    const { e, state } = editor({ work_days: [1, 2, 3, 4, 5] });
    await e.toggleDay(row("work_days", "days"), 6);
    expect(state.commits[0].patch).toEqual({ work_days: [1, 2, 3, 4, 5, 6] });
    await e.toggleDay(row("work_days", "days"), 1);
    expect(state.commits[1].patch).toEqual({ work_days: [2, 3, 4, 5, 6] });
  });
});

describe("a choice", () => {
  it("saves null for «By context» as the default mailbox", async () => {
    const { e, state } = editor({ default_account_id: "a" }, { accounts: [{ id: "a", label: "Работа", email: "a@x" } as never] });
    await e.choose(row("default_account", "choice"), "");
    expect(state.commits[0].patch).toEqual({ default_account_id: null });
  });

  it("reads a removed mailbox as «By context»", () => {
    const { e } = editor({ default_account_id: "gone" });
    expect(e.chosen(row("default_account", "choice"))).toBe("");
  });

  it("does not agree to the background with no tray icon by choosing the background: only the choice is written", async () => {
    const { e, state } = editor({ close_action: "ask" }, { noTray: true });
    await e.choose(row("close_action", "choice"), "background");
    expect(state.commits[0].patch).toEqual({ close_action: "background" });
  });

  it("writes the consent when it is given in its own row, and only then", async () => {
    const { e, state } = editor({ close_action: "background" }, { noTray: true });
    await e.grantTray(row("tray_consent", "action"));
    expect(state.commits[0].patch).toEqual({ background_without_tray: true });
  });

  it("describes the chosen option only", () => {
    const { e } = editor({ letter_view: "markdown" });
    const spec = row("letter_view", "choice");
    expect(e.chosenOption(spec)?.value).toBe("markdown");
    expect(e.chosenOption(spec)?.desc?.()).toContain("Markdown");
  });
});

describe("← and → on a row", () => {
  it("move to the next option and stop at the end", async () => {
    const { e, state } = editor({ language: "auto" });
    const spec = row("language", "choice");
    await e.step(spec, -1, false);
    expect(state.commits).toEqual([]);
    await e.step(spec, 1, false);
    expect(state.commits[0].patch).toEqual({ language: "en" });
  });

  it("step a number and ten steps with Shift", async () => {
    const { e, state } = editor({ image_max_px: 1600 });
    await e.step(row("image_max_px", "number"), 1, false);
    await e.step(row("image_max_px", "number"), -1, true);
    expect(state.commits.map((c) => c.patch.image_max_px)).toEqual([1700, 700]);
  });

  it("move a time by a quarter of an hour", async () => {
    const { e, state } = editor({ day_start: "9:00" });
    await e.step(row("day_start", "clock"), 1, false);
    expect(state.commits[0].patch).toEqual({ day_start: "9:15" });
  });

  it("go through the themes", async () => {
    const { e, state } = editor({ theme: "paper" });
    await e.step(row("theme", "theme"), 1, false);
    expect(state.commits[0].patch).toEqual({ theme: "night" });
  });
});
