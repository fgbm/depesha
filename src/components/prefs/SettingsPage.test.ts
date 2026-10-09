import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../../lib/testing").then((m) => m.appModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));
vi.mock("../../lib/theme", async (orig) => ({ ...(await orig<object>()), applyTheme: () => {} }));

import { render } from "svelte/server";
import SettingsPage from "./SettingsPage.svelte";
import { app } from "../../lib/store.svelte";
import { i18n } from "../../lib/i18n.svelte";
import { PAGES } from "../../lib/settingsCatalog";
import { SettingsAutosave } from "../../lib/settingsAutosave.svelte";
import { settings } from "../../lib/testing";

const auto = new SettingsAutosave({ settings: () => ({}), patch: async () => {}, toast: () => 0, dismiss: () => {} });

function page(id: string, over: object = {}) {
  app.settings = { ...settings(), ...over };
  const spec = PAGES.find((p) => p.id === id)!;
  return render(SettingsPage, { props: { page: spec, auto, sections: [], go: () => {} } }).body;
}

beforeEach(() => {
  i18n.lang = "ru";
});

describe("a page of rows (#102)", () => {
  it("draws every group of the page under its heading, and every row with the id the search scrolls to", () => {
    for (const spec of PAGES) {
      const html = page(spec.id);
      for (const g of spec.groups) expect(html, `${spec.id}: ${g.id}`).toContain(g.title());
      for (const row of spec.groups.flatMap((g) => g.rows)) {
        if (row.kind === "layer") continue;
        expect(html, `${spec.id}: ${row.id}`).toContain(`data-settings="${row.id}"`);
      }
    }
  });

  it("makes the first row the one stop of Tab and takes the others out of it", () => {
    const html = page("storage");
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toMatch(/<div class="rw[^"]*"[^>]*tabindex="0"[^>]*data-row="offline"/);
  });

  it("draws the choice of language as segments and the choice of notifications as a list (1.1 А)", () => {
    expect(page("look")).toMatch(/role="radiogroup"[^>]*aria-label="Язык"/);
    expect(page("notify")).toContain('aria-haspopup="listbox"');
  });

  it("describes only the chosen option of «Show letters»", () => {
    const html = page("reading", { letter_view: "markdown" });
    expect(html).toContain("Если в письме есть Markdown-часть.");
    expect(html).not.toContain("Без оформления и картинок");
    expect(html).not.toContain("Самый богатый вид");
  });

  it("dims the rows under a switch that is off and keeps them on the page (1.6 А)", () => {
    const html = page("storage", { quota_warn: false });
    expect(html).toMatch(/class="rw[^"]*dis[^"]*"[^>]*data-row="quota_levels"/);
    expect(html).toContain('data-row="quota_repeat"');
  });

  it("gathers the dependent rows in one wrapper, so the strip at the left is one line (the rule of the strip)", () => {
    const html = page("storage");
    expect(html.match(/class="depg/g)).toHaveLength(2);
    // offline_attachments stands alone under «offline»; the quota rows stand together.
    const quota = html.slice(html.indexOf('data-g="space"'), html.indexOf('data-g="big"'));
    expect(quota.match(/class="depg/g)).toHaveLength(1);
  });

  it("warns when no weekday is working, and only then", () => {
    expect(page("later", { work_days: [] })).toContain("Рабочих дней нет");
    expect(page("later")).not.toContain("Рабочих дней нет");
  });

  it("says «system» of the theme only when the theme follows the system", () => {
    expect(page("look", { theme: "system" })).toContain("вслед за светлым или тёмным режимом");
    expect(page("look", { theme: "night" })).not.toContain("вслед за светлым или тёмным режимом");
  });

  it("draws no «Save» or «Cancel» on a page: nothing waits to be saved", () => {
    for (const spec of PAGES) {
      const html = page(spec.id);
      expect(html).not.toContain(">Сохранить<");
      expect(html).not.toContain(">Отмена<");
    }
  });
});
