// @vitest-environment jsdom
// A renderer that gave up leaves the fallback; going to another attachment tries a renderer again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));

import { flushSync, mount, tick, unmount } from "svelte";
import Viewer from "./Viewer.svelte";
import { i18n } from "../lib/i18n.svelte";
import { registry } from "../plugin-host/registry.svelte";
import type { AttachmentInfo } from "../lib/types";

const file = (name: string) => ({ name, mime: "application/x-test", size: 10, inline: false, content_id: null }) as unknown as AttachmentInfo;

let view: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  i18n.lang = "ru";
  // A component is a function of the anchor and the props: this one gives up at once, the other draws nothing.
  const giveUp = (_anchor: unknown, props: { file: { fail(e: unknown): void } }) => queueMicrotask(() => props.file.fail(new Error("boom")));
  registry.add("fileViewers", "test", { id: "bad", extensions: ["bad"], component: giveUp as never });
  registry.add("fileViewers", "test", { id: "ok", extensions: ["ok"], component: (() => {}) as never });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (view) unmount(view);
  view = null;
  registry.removeOwner("test");
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("the fallback of the viewer", () => {
  it("goes when another attachment is shown", async () => {
    const props = $state({ id: 1, files: [file("a.bad"), file("b.ok")], at: 0, onClose() {}, onSave() {}, onOpenApp() {} });
    view = mount(Viewer, { target: document.body, props });
    flushSync();
    await tick();
    expect(document.querySelector(".fallback")?.textContent).toContain("boom");
    props.at = 1;
    flushSync();
    expect(document.querySelector(".fallback")).toBeNull();
  });
});
