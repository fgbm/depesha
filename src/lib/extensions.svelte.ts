// The host side of extensions. Each one runs in a sandboxed frame served from `ext:`
// (its own origin, no Tauri bridge, no network but the hosts in its manifest) with the
// code in a worker on its own thread. It is started on first use, every call has a
// time limit, and a stuck worker is replaced: an extension cannot slow the mail window.

import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api, asError } from "./api";
import { i18n } from "./i18n.svelte";
import type { ComposeDraft, ExtText, Extension, MessageRow, OpenedMessage } from "./types";

const LOAD_TIMEOUT = 5000;
const HOOK_TIMEOUT = 1500;
const COMMAND_TIMEOUT = 15000;
const MAX_TEXT = 200_000;

export interface Stats {
  /** Time from creating the sandbox to the extension being ready, ms. */
  startMs: number | null;
  calls: number;
  errors: number;
  timeouts: number;
  lastError: string | null;
}

export interface Banner {
  ext: string;
  name: string;
  messageId: number;
  text: string;
  tone: "info" | "warn";
  actions: { id: string; title: string }[];
}

/** What an extension may do with mail it is given (needs `messages.modify`). */
export type MailAction =
  | { id: number; do: "archive" | "read" | "unread" | "flag" | "delete" | "spam" }
  | { id: number; do: "move"; folder: string };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Runner {
  ext: Extension;
  frame: HTMLIFrameElement;
  ready: Promise<void>;
  markReady: () => void;
  pending: Map<number, Pending>;
  seq: number;
  started: number;
}

/** Mail as an extension sees it: headers, flags and plain text, nothing else. */
export interface ExtMessage {
  id: number;
  account: string;
  folder: string;
  subject: string;
  from: { name: string | null; email: string } | null;
  to: { name: string | null; email: string }[];
  cc: { name: string | null; email: string }[];
  date: number;
  bulk: boolean;
  seen: boolean;
  flagged: boolean;
  text: string | null;
}

export function fromRow(m: MessageRow, accountEmail: string, text: string | null = null): ExtMessage {
  return {
    id: m.id,
    account: accountEmail,
    folder: m.folder,
    subject: m.subject,
    from: m.from,
    to: m.to,
    cc: m.cc,
    date: m.date,
    bulk: m.bulk,
    seen: m.flags.seen,
    flagged: m.flags.flagged,
    text: text ? text.slice(0, MAX_TEXT) : null,
  };
}

export function textOf(t: ExtText | null | undefined): string {
  if (!t) return "";
  return i18n.lang === "ru" && t.ru ? t.ru : t.en;
}

class ExtensionHost {
  list = $state<Extension[]>([]);
  stats = $state<Record<string, Stats>>({});
  banners = $state<Banner[]>([]);
  /** Shows extension notes to the user; set by the app store. */
  toast: (text: string, error?: boolean) => void = () => {};
  private runners = new Map<string, Runner>();
  private listening = false;
  /** Letters the reader shows now: banners are kept for them only. */
  private shown = new Set<number>();

  async load() {
    try {
      this.list = await api.extensions();
    } catch (e) {
      this.toast(asError(e).message, true);
      return;
    }
    // Disabled or removed extensions stop at once.
    for (const id of [...this.runners.keys()]) {
      if (!this.enabled().some((e) => e.id === id)) this.stop(id);
    }
    if (!this.listening) {
      this.listening = true;
      window.addEventListener("message", (e) => this.onFrameMessage(e));
    }
  }

  enabled(): Extension[] {
    return this.list.filter((e) => e.enabled);
  }

  can(ext: Extension, permission: string): boolean {
    return ext.permissions.includes(permission);
  }

  /** Commands of enabled extensions; `message` ones also need an open message. */
  commands(): { ext: Extension; id: string; title: string; message: boolean }[] {
    return this.enabled().flatMap((ext) =>
      ext.contributes.commands.map((c) => ({ ext, id: c.id, title: textOf(c.title), message: c.message })),
    );
  }

  stop(id: string) {
    const r = this.runners.get(id);
    if (!r) return;
    for (const p of r.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("stopped"));
    }
    r.frame.remove();
    this.runners.delete(id);
  }

  private stat(id: string): Stats {
    if (!this.stats[id]) this.stats[id] = { startMs: null, calls: 0, errors: 0, timeouts: 0, lastError: null };
    return this.stats[id];
  }

  private runner(ext: Extension): Runner {
    const existing = this.runners.get(ext.id);
    if (existing) return existing;
    const frame = document.createElement("iframe");
    // allow-scripts without allow-same-origin: an opaque origin, no storage, no parent access.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    let markReady = () => {};
    const ready = new Promise<void>((resolve) => (markReady = resolve));
    const r: Runner = { ext, frame, ready, markReady, pending: new Map(), seq: 0, started: performance.now() };
    this.runners.set(ext.id, r);
    frame.src = convertFileSrc(ext.id, "ext");
    document.body.appendChild(frame);
    return r;
  }

  private onFrameMessage(e: MessageEvent) {
    const r = [...this.runners.values()].find((x) => x.frame.contentWindow === e.source);
    if (!r) return;
    const m = e.data ?? {};
    const st = this.stat(r.ext.id);
    if (m.type === "ready") {
      if (st.startMs === null) st.startMs = Math.round(performance.now() - r.started);
      r.markReady();
    } else if (m.type === "result") {
      const p = r.pending.get(m.id);
      if (!p) return;
      r.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) {
        st.errors++;
        st.lastError = String(m.error);
        p.reject(new Error(String(m.error)));
      } else p.resolve(m.result);
    } else if (m.type === "error") {
      st.errors++;
      st.lastError = String(m.message);
    } else if (m.type === "rpc") {
      this.rpc(r, m.method, m.args ?? []).then(
        (result) => r.frame.contentWindow?.postMessage({ type: "rpc-result", id: m.id, result }, "*"),
        (err) => r.frame.contentWindow?.postMessage({ type: "rpc-result", id: m.id, error: asError(err).message }, "*"),
      );
    }
  }

  /** Requests from an extension, checked against its permissions. */
  private async rpc(r: Runner, method: string, args: unknown[]): Promise<unknown> {
    const ext = r.ext;
    switch (method) {
      case "toast":
        this.toast(`${textOf(ext.name)}: ${String(args[0]).slice(0, 300)}`);
        return null;
      case "storage.get":
        if (!this.can(ext, "storage")) throw new Error("permission denied: storage");
        return api.extensionStorageGet(ext.id, String(args[0]));
      case "storage.set":
        if (!this.can(ext, "storage")) throw new Error("permission denied: storage");
        return api.extensionStorageSet(ext.id, String(args[0]), args[1] ?? null);
      default:
        throw new Error(`unknown method ${method}`);
    }
  }

  /** Sends an event to the extension, starting it if needed; rejects after `timeout`. */
  async call(ext: Extension, name: string, args: unknown[], timeout: number): Promise<unknown> {
    const r = this.runner(ext);
    const st = this.stat(ext.id);
    const loaded = await Promise.race([r.ready.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), LOAD_TIMEOUT))]);
    if (!loaded) {
      st.timeouts++;
      st.lastError = "did not start in time";
      this.stop(ext.id);
      throw new Error(st.lastError);
    }
    st.calls++;
    const id = ++r.seq;
    // Plain data only: reactive proxies of the interface cannot cross into the sandbox.
    const plain = JSON.parse(JSON.stringify(args)) as unknown[];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        r.pending.delete(id);
        st.timeouts++;
        st.lastError = `${name}: no answer in ${timeout} ms`;
        // A worker stuck in a loop is replaced; the next call starts it afresh.
        let markReady = () => {};
        r.ready = new Promise<void>((res) => (markReady = res));
        r.markReady = markReady;
        r.started = performance.now();
        r.frame.contentWindow?.postMessage({ type: "restart" }, "*");
        reject(new Error(st.lastError));
      }, timeout);
      r.pending.set(id, { resolve, reject, timer });
      r.frame.contentWindow?.postMessage({ type: "event", id, name, args: plain }, "*");
    });
  }

  private with(hook: string): Extension[] {
    return this.enabled().filter((e) => e.hooks.includes(hook));
  }

  /** The reader now shows these letters (the open one, its conversation): banners of others go. */
  showing(ids: Iterable<number>) {
    this.shown = new Set(ids);
    if (this.banners.some((b) => !this.shown.has(b.messageId))) this.banners = this.banners.filter((b) => this.shown.has(b.messageId));
  }

  /** Banners for the opened message. Runs beside opening, never in its way. */
  async messageOpen(msg: OpenedMessage, accountEmail: string) {
    const exts = this.with("messageOpen");
    if (!exts.length) return;
    const data = fromRow(msg.row, accountEmail, msg.view.text);
    await Promise.all(
      exts.map(async (ext) => {
        try {
          const res = (await this.call(ext, "messageOpen", [data], HOOK_TIMEOUT)) as { banner?: Partial<Banner> & { actions?: { id: string; title: string }[] } } | null;
          const b = res?.banner;
          // A banner that comes after its letter was left is not kept.
          if (!b || typeof b.text !== "string" || !this.shown.has(msg.row.id)) return;
          this.banners = [
            ...this.banners.filter((x) => !(x.ext === ext.id && x.messageId === msg.row.id)),
            {
              ext: ext.id,
              name: textOf(ext.name),
              messageId: msg.row.id,
              text: b.text.slice(0, 500),
              tone: b.tone === "warn" ? "warn" : "info",
              actions: (b.actions ?? []).slice(0, 3).map((a) => ({ id: String(a.id), title: String(a.title).slice(0, 40) })),
            },
          ];
        } catch {
          // Recorded in the stats; a failing extension only loses its banner.
        }
      }),
    );
  }

  /** Warnings from extensions before sending. */
  async beforeSend(draft: ComposeDraft, accountEmail: string): Promise<string[]> {
    const data = {
      account: accountEmail,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      text: draft.text.slice(0, MAX_TEXT),
      attachments: draft.attachments.map((a) => ({ name: a.name, size: a.size })),
    };
    const out = await Promise.all(
      this.with("beforeSend").map(async (ext) => {
        try {
          const res = (await this.call(ext, "beforeSend", [data], HOOK_TIMEOUT)) as { warnings?: unknown[] } | null;
          return (res?.warnings ?? []).slice(0, 5).map((w) => `${textOf(ext.name)}: ${String(w).slice(0, 300)}`);
        } catch {
          return [];
        }
      }),
    );
    return out.flat();
  }

  /** New mail goes past mail rules of extensions; returns the actions to apply. */
  async newMail(rows: MessageRow[], accountOf: (id: string) => string): Promise<{ ext: Extension; actions: MailAction[] }[]> {
    const out = [];
    for (const ext of this.with("newMail")) {
      if (!this.can(ext, "messages.modify")) continue;
      try {
        const data = rows.map((m) => fromRow(m, accountOf(m.account_id)));
        const res = (await this.call(ext, "newMail", [data], HOOK_TIMEOUT)) as { actions?: MailAction[] } | null;
        const allowed = new Set(rows.map((m) => m.id));
        const actions = (res?.actions ?? []).filter(
          (a) => a && allowed.has(a.id) && ["archive", "read", "unread", "flag", "delete", "spam", "move"].includes(a.do),
        );
        if (actions.length) out.push({ ext, actions });
      } catch {
        // Recorded in the stats.
      }
    }
    return out;
  }

  /** Runs a command; `message` commands get the open message. */
  async command(ext: Extension, id: string, message: ExtMessage | null): Promise<void> {
    try {
      const res = (await this.call(ext, "command", [id, { message }], COMMAND_TIMEOUT)) as { toast?: string } | null;
      if (res?.toast) this.toast(`${textOf(ext.name)}: ${String(res.toast).slice(0, 300)}`);
    } catch (e) {
      this.toast(`${textOf(ext.name)}: ${asError(e).message}`, true);
    }
  }
}

export const extensions = new ExtensionHost();

/** Extension events from the backend. */
export async function listenForMail(onNew: (ids: number[]) => void) {
  await listen<{ ids: number[] }>("mail-arrived", (e) => onNew(e.payload.ids));
}
