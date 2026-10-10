// The tasks window shows every kind of task the backend names (#143): a wait moving its letters
// is `waiting`, which the hand-written type once left out.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));
vi.mock("../lib/theme", () => ({ applyTheme: () => {} }));

import { render } from "svelte/server";
import Tasks from "./Tasks.svelte";
import { app } from "../lib/store.svelte";
import { i18n } from "../lib/i18n.svelte";
import type { Task } from "../lib/types";

const task = (over: Partial<Task>): Task => ({
  key: "waiting:a:1",
  kind: "waiting",
  account_id: "a",
  label: "Письма уходят в папку ожидания",
  done: 0,
  total: 0,
  state: "running",
  started: 1,
  ...over,
});

beforeEach(() => {
  i18n.lang = "ru";
});

describe("the tasks window", () => {
  it("shows a running wait", () => {
    app.ui.tasks = [task({})];
    const { body } = render(Tasks, { props: {} });
    expect(body).toContain("Письма уходят в папку ожидания");
    expect(body).toContain('data-kind="waiting"');
  });

  it("shows a failed wait with its error", () => {
    app.ui.tasks = [task({ state: "failed", error: { kind: "other", message: "папка недоступна" } })];
    const { body } = render(Tasks, { props: {} });
    expect(body).toContain("Письма уходят в папку ожидания");
    expect(body).toContain("папка недоступна");
  });
});
