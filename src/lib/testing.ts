// Stand-ins for Tauri and the backend in unit tests of the store and its modules. A test
// file mocks the modules with these:
//
//   vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
//   vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));

import { vi, type Mock } from "vitest";
import type { api as realApi } from "./api";
import type { AppStore } from "./store.svelte";
import type { MessageRow, OpenedMessage, Settings } from "./types";

type Api = typeof realApi;
type Handler = (e: { payload: unknown }) => void;

/** Every backend command, a mock answering `undefined` unless a test says otherwise. */
export const api = new Proxy({} as Record<string, Mock>, {
  get: (target, key: string) => (target[key] ??= vi.fn(async () => undefined)),
}) as unknown as { [K in keyof Api]: Mock<Api[K]> };

/** Handlers of backend events, by name, as the store subscribed them. */
export const handlers = new Map<string, Handler>();

export const eventModule = {
  listen: vi.fn(async (name: string, h: Handler) => {
    handlers.set(name, h);
    return () => {};
  }),
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
};

/** Listeners of the current webview: they hear only what is sent to it, unlike the global `listen`. */
export const webviewListen = vi.fn(async (name: string, h: Handler) => {
  handlers.set(name, h);
  // Stopping takes the handler away, so that a later event reaches nobody.
  return () => {
    if (handlers.get(name) === h) handlers.delete(name);
  };
});
export const webviewOnDragDrop = vi.fn(async (_h: Handler) => () => {});
export const webviewModule = { getCurrentWebview: () => ({ listen: webviewListen, onDragDropEvent: webviewOnDragDrop }) };

export const win = { close: vi.fn(async () => {}), setFocus: vi.fn(async () => {}) };
export const windowModule = { getCurrentWindow: () => win };
export const appModule = { getVersion: vi.fn(async () => "0.0.0") };

/** The backend sends an event. */
export function emit(name: string, payload: unknown = null) {
  const h = handlers.get(name);
  if (!h) throw new Error(`nobody listens to ${name}`);
  h({ payload });
}

export const settings = (): Settings => ({
  undo_send_secs: 10,
  notify: "people",
  dnd_until: 0,
  threads: true,
  list_avatars: true,
  templates: [],
  updates: "auto",
  language: "auto",
  theme: "system",
  disabled_plugins: [],
  enabled_plugins: [],
  plugin_settings: {},
  keybindings: { custom: {}, dismissed: [] },
  disabled_extensions: [],
  oauth_clients: {},
  offline: "30",
  offline_attachments: false,
  sender_logos: true,
  letter_view: "sender",
  default_account_id: null,
  attachments_dir: "",
  list_sort: [],
  view_sorts: {},
  large_mb: 25,
  image_max_px: 1600,
  compose_format: "plain",
  quota_warn: true,
  quota_levels: [90, 95],
  quota_repeat: "threshold",
  close_action: "ask",
  background_without_tray: false,
  autostart: "off",
  tray_count: true,
  tray_always: true,
  hints: true,
  markdown_parts_note: true,
  day_start: "9:00",
  evening_start: "18:00",
  work_days: [1, 2, 3, 4, 5],
});

/** Answers of an empty mailbox; tests change what they look at. */
export function resetFakes() {
  for (const m of Object.values(api)) (m as Mock).mockReset();
  for (const m of [...Object.values(eventModule), ...Object.values(win), webviewListen]) m.mockReset();
  handlers.clear();
  api.accounts.mockResolvedValue([]);
  api.folders.mockResolvedValue([]);
  api.outbox.mockResolvedValue([]);
  api.settings.mockResolvedValue(settings());
  api.language.mockResolvedValue("en");
  api.tasks.mockResolvedValue([]);
  api.extensions.mockResolvedValue([]);
  api.messages.mockResolvedValue([]);
  api.messagesById.mockResolvedValue([]);
  api.thread.mockResolvedValue([]);
  api.setFlag.mockResolvedValue(undefined);
  api.syncNow.mockResolvedValue(undefined);
  api.undo.mockResolvedValue(undefined);
  for (const a of ["archive", "remove", "spam", "move"] as const) {
    api[a].mockImplementation(async (ids: number[]) => [{ account_id: "a", from: "INBOX", to: "Archive", message_ids: ids.map(String) }]);
  }
  // The extension host listens to its frames on the window; there is no DOM here.
  vi.stubGlobal("window", { addEventListener: () => {} });
}

export function row(id: number, extra: Partial<MessageRow> = {}): MessageRow {
  return {
    id,
    account_id: "a",
    folder: "INBOX",
    uid: id,
    message_id: `<${id}@example.com>`,
    in_reply_to: null,
    references: [],
    subject: `Letter ${id}`,
    from: { name: null, email: "someone@example.com" },
    to: [],
    cc: [],
    reply_to: [],
    date: 1_000_000 - id,
    size: 1,
    flags: { seen: false, flagged: false, answered: false, draft: false, deleted: false },
    has_attachments: false,
    thread: `t${id}`,
    bulk: false,
    thread_count: 1,
    thread_date: 1_000_000 - id,
    thread_senders: [],
    thread_draft: false,
    snoozed_until: null,
    followup_due: null,
    ...extra,
  };
}

export function rows(from: number, n: number): MessageRow[] {
  return Array.from({ length: n }, (_, i) => row(from + i));
}

export function opened(r: MessageRow): OpenedMessage {
  return {
    row: structuredClone(r),
    view: {
      summary: {
        message_id: r.message_id,
        in_reply_to: r.in_reply_to,
        references: r.references,
        subject: r.subject,
        from: r.from,
        to: r.to,
        cc: r.cc,
        reply_to: r.reply_to,
        date: r.date,
        has_attachments: r.has_attachments,
        bulk: r.bulk,
        unsubscribe: null,
      },
      text: "",
      html: null,
      has_remote_content: false,
      authenticated: false,
      attachments: [],
    },
    trusted_sender: false,
  };
}

/** A promise settled from the outside. */
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every settled promise run its continuations. */
export async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/**
 * What a test puts in place of `app` (`vi.mock("../store.svelte", …)`): only the parts the code
 * under test reads. Typed against the store, so a renamed member breaks the mock, not a run.
 */
export interface AppMock {
  ui?: Partial<AppStore["ui"]>;
  selection?: Partial<AppStore["selection"]>;
  compose?: Partial<AppStore["compose"]>;
  settingsCtl?: { settings?: Partial<AppStore["settingsCtl"]["settings"]> };
  mailboxes?: Partial<AppStore["mailboxes"]>;
  activeCompose?: AppStore["activeCompose"];
  closeCompose?: AppStore["closeCompose"];
  showCompose?: AppStore["showCompose"];
  send?: AppStore["send"];
}

export const appMock = <T extends AppMock>(parts: T) => parts satisfies AppMock;
