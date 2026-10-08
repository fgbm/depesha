import { describe, expect, it, vi } from "vitest";
import type { Banner, KeyBinding, Moved, OpenedMessage, PluginContext, RowAction } from "@depesha/plugin-api";
import { i18n } from "../../src/lib/i18n.svelte";
import { row } from "../../src/lib/testing";
import plugin from "./index";
import { closeSnooze, snooze } from "./state.svelte";

/** A context that keeps what the plugin registers, with a backend that answers the commands. */
function fakeContext(opened: OpenedMessage | null = null, selected: number[] = []) {
  const keys: KeyBinding[] = [];
  const actions: RowAction[] = [];
  let banner: (msg: OpenedMessage) => Banner | null = () => null;
  const texts: string[] = [];
  const moved: Moved[] = [
    { account_id: "a", from: "Snoozed", to: "INBOX", message_ids: ["<1@example.com>"], snoozed: [{ subject: "Счёт" }] },
  ];
  const backend = vi.fn(async (command: string) => (command === "unsnooze" ? moved : { snoozed: 0 }));
  const ctx = {
    t: (text: { ru: string }, params: Record<string, string | number> = {}) => text.ru.replace(/\{(\w+)\}/g, (_, k) => String(params[k])),
    plural: (n: number) => `${n} писем`,
    backend,
    onBackend: () => {},
    mail: {
      opened: () => opened,
      selection: () => selected,
      main: () => true,
      folders: () => [{ account_id: "a", name: "INBOX", display_name: "INBOX", role: "inbox" }],
      perform: async (text: string | ((m: Moved[]) => string), ids: number[], run: (ids: number[]) => Promise<Moved[]>) => {
        const done = await run(ids);
        texts.push(typeof text === "function" ? text(done) : text);
      },
      viewing: () => false,
      scheduleReload: () => {},
    },
    ui: {
      view: () => {},
      readerToolbar: () => {},
      bulkToolbar: () => {},
      rowAction: (a: RowAction) => actions.push(a),
      keybinding: (b: KeyBinding) => keys.push(b),
      command: () => {},
      rowTag: () => {},
      banner: (p: (msg: OpenedMessage) => Banner | null) => (banner = p),
      overlay: () => {},
    },
    lang: () => "ru",
    workTime: () => ({ day: { h: 9, m: 0 }, evening: { h: 18, m: 0 }, days: [1, 2, 3, 4, 5] }),
    anchor: () => ({ x: 316, y: 100, h: 56 }),
  } as unknown as PluginContext;
  plugin.activate(ctx);
  return { backend, texts, keys, actions, banner: (msg: OpenedMessage) => banner(msg) };
}

const message = (snoozed_until: number | null) => ({ row: row(1, { snoozed_until }) }) as OpenedMessage;

describe("bringing snoozed mail back now (#93)", () => {
  it("is a button in the line over a snoozed letter, and only there", () => {
    i18n.lang = "ru";
    const { banner, backend, texts } = fakeContext();
    expect(banner(message(null))).toBeNull();
    const action = banner(message(5000))?.actions?.[0];
    expect(action?.title).toBe("Вернуть сейчас");
    action?.run();
    expect(backend).toHaveBeenCalledWith("unsnooze", { ids: [1] });
    return vi.waitFor(() => expect(texts).toEqual(["Возвращено во «Входящие»: Счёт"]));
  });

  it("shares the key with «Stop waiting» and acts on the opened snoozed letter", async () => {
    const { keys, backend } = fakeContext(message(5000));
    const key = keys.find((k) => k.id === "core.release")!;
    expect(key.key).toBeUndefined();
    expect(key.when?.()).toBe(true);
    key.run();
    expect(backend).toHaveBeenCalledWith("unsnooze", { ids: [1] });
    expect(fakeContext(message(null)).keys.find((k) => k.id === "core.release")?.when?.()).toBe(false);
    expect(fakeContext(null).keys.find((k) => k.id === "core.release")?.when?.()).toBe(false);
  });

  it("is an item of the context menu for snoozed rows only", () => {
    const { actions, backend } = fakeContext();
    const item = actions.find((a) => a.id === "snooze.release")!;
    expect(item.title()).toBe("Вернуть сейчас");
    expect(item.command).toBe("core.release");
    expect(item.when?.([1], [row(1, { snoozed_until: 5000 })])).toBe(true);
    expect(item.when?.([1, 2], [row(1, { snoozed_until: 5000 }), row(2)])).toBe(false);
    item.run?.([1, 2]);
    expect(backend).toHaveBeenCalledWith("unsnooze", { ids: [1, 2] });
  });
});

describe("the menu opens where the keys and the clicks say (#95, #96)", () => {
  it("h works on a selected row with no letter open, and not on nothing", () => {
    const { keys } = fakeContext(null, [7]);
    const key = keys.find((k) => k.id === "snooze.open")!;
    expect(key.key).toBe("h");
    expect(key.when?.()).toBe(true);
    expect(fakeContext().keys.find((k) => k.id === "snooze.open")?.when?.()).toBe(false);
  });

  it("h opens the menu for the selection, hanging on the selected row", () => {
    const { keys } = fakeContext(null, [7, 8]);
    keys.find((k) => k.id === "snooze.open")!.run();
    expect(snooze.menu).toEqual({ ids: [7, 8], anchor: { x: 316, y: 100, h: 56 } });
    closeSnooze();
    expect(snooze.menu).toBeNull();
  });

  it("the context menu item opens it at the pointer, for the rows it was opened on", () => {
    const { actions } = fakeContext();
    const item = actions.find((a) => a.id === "snooze")!;
    expect(item.menu).toBeUndefined();
    item.run?.([3], { x: 40, y: 50 });
    expect(snooze.menu).toEqual({ ids: [3], anchor: { x: 40, y: 50 } });
    closeSnooze();
  });
});
