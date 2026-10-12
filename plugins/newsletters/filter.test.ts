import { describe, expect, it } from "vitest";
import type { ListFilter, PluginContext } from "@depesha/plugin-api";
import plugin from "./index";

/** A context that keeps the filter the plugin registers. */
function fakeContext() {
  const got: { filter?: ListFilter } = {};
  const ctx = {
    t: (text: { ru: string }) => text.ru,
    settings: { get: <T,>(_key: string, fallback: T) => fallback, set: () => {} },
    ui: {
      listFilter: (f: ListFilter) => (got.filter = f),
      readerHeader: () => {},
      messageAction: () => {},
      banner: () => {},
    },
  } as unknown as PluginContext;
  return { ctx, got };
}

describe("the newsletters filter", () => {
  it("counts the unread newsletters of the list, and nothing else", () => {
    const { ctx, got } = fakeContext();
    plugin.activate(ctx);
    const filter = got.filter!;
    const list = { key: "folder:a:INBOX", inbox: true };

    expect(filter.count!(list, "bulk")).toEqual({ bulk: true, unread_only: true });
    expect(filter.count!(list, "people")).toBeUndefined();
    expect(filter.count!(list, "all")).toBeUndefined();
  });
});
