import { describe, expect, it, vi } from "vitest";
import type { Banner, KeyBinding, Moved, OpenedMessage, PluginContext, RowAction } from "@depesha/plugin-api";
import { row } from "../../src/lib/testing";
import plugin from "./index";

/** A context that keeps what the plugin registers, with a backend that answers the commands. */
function fakeContext(opened: OpenedMessage | null = null) {
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
      selection: () => [],
      folders: () => [{ account_id: "a", name: "INBOX", display_name: "Входящие" }],
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
    },
  } as unknown as PluginContext;
  plugin.activate(ctx);
  return { backend, texts, keys, actions, banner: (msg: OpenedMessage) => banner(msg) };
}

const message = (snoozed_until: number | null) => ({ row: row(1, { snoozed_until }) }) as OpenedMessage;

describe("bringing snoozed mail back now (#93)", () => {
  it("is a button in the line over a snoozed letter, and only there", () => {
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
