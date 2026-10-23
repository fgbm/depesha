import { beforeEach, describe, expect, it } from "vitest";
import type { Settings } from "./types";
import { i18n } from "./i18n.svelte";
import { MENU, OWN_PAGES, PAGES, menuPages, pageSpec, pageTitle, resolvePage, type RowSpec } from "./settingsCatalog";
import { choiceMode } from "./settingsRows";

const rows = (): RowSpec[] => PAGES.flatMap((p) => p.groups.flatMap((g) => g.rows));

beforeEach(() => {
  i18n.lang = "ru";
});

describe("the menu (#102, 2.1 В; 0.8.12, 2.1 А and 2.2 А)", () => {
  it("has two axes, «Mail» and «App», then the mailboxes and the plugins, each one entry with no heading", () => {
    expect(MENU.map((g) => g.title?.() ?? null)).toEqual(["Почта", "Программа", null, null]);
    expect(MENU[0].pages).toEqual(["reading", "writing", "later", "storage"]);
    expect(MENU[1].pages).toEqual(["look", "notify", "updates", "keys"]);
    expect(MENU[2].pages).toEqual(["accounts"]);
    expect(MENU[3].pages).toEqual(["plugins"]);
  });

  it("names the notification choice «people» for people, not for the address book (#153)", () => {
    const options = (pageSpec("notify")!.groups.flatMap((g) => g.rows).find((r) => r.id === "notify") as Extract<RowSpec, { kind: "choice" }>).options({} as never);
    expect(options.find((o) => o.value === "people")!.label()).toBe("Только о письмах от людей");
    i18n.lang = "en";
    expect(options.find((o) => o.value === "people")!.label()).toBe("Only for mail from people");
  });

  it("has no page «People»: the people moved to the main window (#104), the menu is ten entries", () => {
    expect(menuPages()).not.toContain("people");
    expect(menuPages()).toHaveLength(10);
    expect(OWN_PAGES.some((p) => p.id === "people")).toBe(false);
  });

  it("has a page for each entry, and no mailbox of its own in the menu (2.6 Б)", () => {
    for (const id of menuPages()) expect(pageSpec(id) ?? OWN_PAGES.find((p) => p.id === id), id).toBeDefined();
    expect(menuPages().some((id) => id.startsWith("account:"))).toBe(false);
  });

  it("names the pages as the decision does", () => {
    expect(menuPages().map(pageTitle)).toEqual([
      "Чтение",
      "Написание",
      "Отложить и ждать",
      "Хранение",
      "Вид и язык",
      "Фон и уведомления",
      "Обновления",
      "Клавиши",
      "Ящики",
      "Плагины",
    ]);
  });

  it("reads the page ids of before 0.8.12 as the pages that have the matter now", () => {
    expect(resolvePage("general")).toBe("look");
    expect(resolvePage("mail")).toBe("reading");
    expect(resolvePage("notifications")).toBe("notify");
    expect(resolvePage("background")).toBe("notify");
    expect(resolvePage("start")).toBe("notify");
    expect(resolvePage("offline")).toBe("storage");
    expect(resolvePage("updates")).toBe("updates");
    expect(resolvePage("keys")).toBe("keys");
    expect(resolvePage("account:7")).toBe("account:7");
  });
});

describe("every setting in its section, as the table of screen 3 has it (0.8.12, 2.1 А)", () => {
  /** Page, group (null: a group of one row, with no heading) and the rows in it, in order. */
  const MAP: [string, string | null, string[]][] = [
    ["reading", "Список писем", ["threads", "list_avatars", "sender_logos", "bulk_ask"]],
    ["reading", "Письмо", ["letter_view", "layer_view", "attachments_dir"]],
    ["writing", "Новые письма", ["compose_format", "layer_format", "default_account", "image_max_px"]],
    ["writing", null, ["undo_send"]],
    ["later", "Время для отложенных писем", ["day_start", "evening_start", "work_days"]],
    ["later", null, ["waiting"]],
    ["storage", "Офлайн-доступ", ["offline", "offline_attachments"]],
    ["storage", "Заполнение ящиков", ["quota_warn", "quota_levels", "quota_repeat", "quota_own", "large_mb"]],
    ["look", "Язык и оформление", ["language", "look", "theme"]],
    ["look", "Подсказки", ["hints", "markdown_parts_note", "hints_list"]],
    ["notify", "Уведомления и значок", ["notify", "tray_count", "tray_always"]],
    ["notify", "Фон и запуск", ["close_action", "tray_consent", "autostart"]],
    ["updates", null, ["updates", "update_status"]],
  ];

  it("puts each row in its page and group, and nothing else in them", () => {
    const got: [string, string | null, string[]][] = PAGES.flatMap((p) => p.groups.map((g): [string, string | null, string[]] => [p.id, g.title?.() ?? null, g.rows.map((r) => r.id)]));
    expect(got).toEqual(MAP);
  });
});

describe("the rows", () => {
  it("have ids of their own, since the search and the e2e steps find a row by it", () => {
    const ids = rows().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keep every setting the pages of before 0.8 edited", () => {
    // Settings → General, Updates, Mail, Notifications, Background and startup, Offline.
    const was = [
      "language", "theme", "hints", "day_start", "evening_start", "work_days", "updates",
      "threads", "list_avatars", "sender_logos", "compose_format", "image_max_px", "default_account_id", "letter_view", "attachments_dir", "undo_send_secs",
      "notify", "quota_warn", "quota_levels", "quota_repeat",
      "close_action", "autostart", "tray_count", "tray_always",
      "offline", "offline_attachments", "large_mb",
    ];
    const keys = new Set(rows().flatMap((r) => ("key" in r ? [r.key as string] : [])));
    for (const k of was) expect(keys, k).toContain(k);
  });

  it("do not give the consent to work with no tray icon along with the choice of the background: it is asked for in a row of its own", () => {
    const close = rows().find((r) => r.id === "close_action");
    expect(close?.kind === "choice" && close.extra).toBeFalsy();
    const ask = rows().find((r) => r.id === "tray_consent");
    const ctx = { accounts: [], noTray: true };
    const on = { close_action: "background", background_without_tray: false } as Settings;
    expect(ask?.visible?.(on, ctx)).toBe(true);
    expect(ask?.visible?.(on, { ...ctx, noTray: false })).toBe(false);
    expect(ask?.visible?.({ ...on, close_action: "ask" }, ctx)).toBe(false);
    expect(ask?.visible?.({ ...on, background_without_tray: true }, ctx)).toBe(false);
    expect(rows().some((r) => "key" in r && r.key === "background_without_tray")).toBe(false);
  });

  it("leave a place in the hints for the note of #103", () => {
    expect(pageSpec("look")?.groups.find((g) => g.id === "hints")?.rows.map((r) => r.id)).toContain("markdown_parts_note");
  });

  it("put the avatars of the list beside the conversations and the logos right under them (#108)", () => {
    const list = pageSpec("reading")?.groups.find((g) => g.id === "list")?.rows.map((r) => r.id);
    expect(list).toEqual(["threads", "list_avatars", "sender_logos", "bulk_ask"]);
    // The logos are the network, the avatars the look: neither hangs under the other.
    for (const id of ["list_avatars", "sender_logos"]) expect(rows().find((r) => r.id === id)?.dep).toBeFalsy();
  });
});

describe("the choices are drawn by the one rule (#102, 1.1 А)", () => {
  const modeOf = (id: string) => {
    const r = rows().find((x) => x.id === id);
    if (r?.kind !== "choice") throw new Error(id);
    return choiceMode(r.options({ accounts: [], noTray: false }).map((o) => o.label()));
  };

  it("draws the short sets as segments", () => {
    expect(modeOf("language")).toBe("seg");
    expect(modeOf("compose_format")).toBe("seg");
  });

  it("draws the long or many as a list", () => {
    for (const id of ["autostart", "notify", "letter_view", "offline", "close_action", "updates", "quota_repeat", "undo_send"]) expect(modeOf(id), id).toBe("drop");
  });

  it("gives no option the same value twice", () => {
    for (const r of rows()) {
      if (r.kind !== "choice") continue;
      const v = r.options({ accounts: [], noTray: false }).map((o) => o.value);
      expect(new Set(v).size).toBe(v.length);
    }
  });
});

describe("dependent rows (#102, 1.6 А)", () => {
  const quota = () => pageSpec("storage")!.groups.find((g) => g.id === "space")!.rows;

  it("stand in one run under the switch they depend on", () => {
    expect(quota().map((r) => !!r.dep)).toEqual([false, true, true, true, false]);
  });

  it("are dimmed where they stand while the switch is off", () => {
    const [, levels] = quota();
    expect(levels.enabled?.({ quota_warn: false } as never)).toBe(false);
    expect(levels.enabled?.({ quota_warn: true } as never)).toBe(true);
  });
});
