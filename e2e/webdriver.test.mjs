import { describe, expect, it } from "vitest";
import { Driver, ELEMENT_KEY, sidebarShape } from "./webdriver.mjs";

/** A driver whose requests go nowhere: the calls and their bodies are kept instead. */
function fakeDriver(overrides = {}) {
  const d = new Driver();
  d.session = "s1";
  d.calls = [];
  d.req = async (method, path, body) => {
    d.calls.push({ method, path, body });
    return overrides[path]?.() ?? { [ELEMENT_KEY]: "frame-1" };
  };
  return d;
}

describe("sidebarShape", () => {
  it("does not change with a counter: only the name and the top go in", () => {
    expect(sidebarShape([["Входящие", 256, 7]])).toBe(sidebarShape([["Входящие", 256, 9]]));
  });

  it("changes when a row comes in and pushes the tree down", () => {
    const before = [["Входящие", 256]];
    const after = [["Отложенные", 256], ["Входящие", 282]];
    expect(sidebarShape(after)).not.toBe(sidebarShape(before));
  });

  it("changes when a row moves without a new one", () => {
    expect(sidebarShape([["Входящие", 256]])).not.toBe(sidebarShape([["Входящие", 282]]));
  });

  it("ignores a sub-pixel jitter", () => {
    expect(sidebarShape([["Входящие", 256.2]])).toBe(sidebarShape([["Входящие", 255.8]]));
  });
});

describe("reading a frame of an opaque origin", () => {
  it("switches into the frame's element and back to the page", async () => {
    const d = fakeDriver();
    await d.inFrame(".reader iframe", async () => {
      d.calls.push({ method: "run", path: "/inside" });
    });
    expect(d.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /session/s1/element",
      "POST /session/s1/frame",
      "run /inside",
      "POST /session/s1/frame/parent",
    ]);
    expect(d.calls[1].body).toEqual({ id: { [ELEMENT_KEY]: "frame-1" } });
  });

  it("comes back to the page when the work in the frame fails", async () => {
    const d = fakeDriver();
    await expect(
      d.inFrame(".reader iframe", async () => {
        throw new Error("в кадре письма");
      }),
    ).rejects.toThrow("в кадре письма");
    expect(d.calls.at(-1).path).toBe("/session/s1/frame/parent");
  });
});
