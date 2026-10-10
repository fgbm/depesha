import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../../lib/testing").then((m) => m.appModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));
vi.mock("../../lib/theme", () => ({ applyTheme: () => {} }));

import { readFileSync } from "node:fs";
import { render } from "svelte/server";
import SidebarTree from "./SidebarTree.svelte";
import { i18n } from "../../lib/i18n.svelte";
import { rooms } from "../../lib/room.svelte";
import { app } from "../../lib/store.svelte";
import type { AccountView, FolderInfo } from "../../lib/types";

const owner = "very.long.owner.name.that.does.not.fit.in.the.sidebar";
const account = { id: "a" } as unknown as AccountView;
const folder = (name: string): FolderInfo =>
  ({ account_id: "a", name, display_name: name, delimiter: "/", role: null, selectable: true, hidden: false, total: 0, unread: 0 }) as FolderInfo;

beforeEach(() => {
  i18n.lang = "ru";
  app.mailboxes.folders = [folder("INBOX"), folder(`Other Users/${owner}`), folder(`Other Users/${owner}/Inbox`)];
  rooms.infos = {
    a: { namespaces: { personal: [{ prefix: "", delimiter: "/" }], other_users: [{ prefix: "Other Users/", delimiter: "/" }], shared: [] } },
  } as unknown as typeof rooms.infos;
});

describe("the heading of another person's folders", () => {
  it("clips a long owner's name with an ellipsis and shows it whole on hover", () => {
    const { body } = render(SidebarTree, { props: { account } });
    expect(body).toContain(`<span class="name" title="${owner}">${owner}</span>`);
  });

  it("lets the heading shrink so the name can be clipped instead of widening the sidebar", () => {
    const css = readFileSync(new URL("./sidebar.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.side \.subhead \{[^}]*min-width: 0;/);
  });
});
