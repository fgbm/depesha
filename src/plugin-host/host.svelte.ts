// Turns built-in plugins on and off by the settings and gives each its context. A plugin
// only sees `PluginContext`; the host keeps the wiring to the app store here.

import { listen } from "@tauri-apps/api/event";
import { BUILTIN } from "../../plugins";
import type { Command, KeyBinding, Plugin, PluginContext, Text } from "../plugin-api";
import { call } from "../lib/api";
import { i18n } from "../lib/i18n.svelte";
import { app } from "../lib/store.svelte";
import { coreCommands } from "../lib/commands";
import { keyAnchor } from "../lib/anchor";
import { workTimeFrom } from "../lib/workTime";
import { shortcuts } from "../lib/shortcuts.svelte";
import { registry } from "./registry.svelte";

function fill(s: string, params?: Record<string, string | number>): string {
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s;
}

function pick(text: Text): string {
  return i18n.lang === "ru" ? text.ru : text.en;
}

/**
 * The counters every plugin reads (#71): one request per burst of `counters-changed`,
 * held a moment, its answer shared by all of them.
 */
let countersPromise: Promise<unknown> | null = null;
let countersTimer: ReturnType<typeof setTimeout> | null = null;
let countersResolve: ((v: unknown) => void)[] = [];
let countersReject: ((e: unknown) => void)[] = [];

function sharedCounters<T>(): Promise<T> {
  countersPromise ??= new Promise<unknown>((resolve, reject) => {
    countersResolve.push(resolve);
    countersReject.push(reject);
  });
  if (!countersTimer) {
    countersTimer = setTimeout(() => {
      countersTimer = null;
      countersPromise = null;
      const resolve = countersResolve;
      const reject = countersReject;
      countersResolve = [];
      countersReject = [];
      call<unknown>("counters").then(
        (c) => resolve.forEach((f) => f(c)),
        (e) => reject.forEach((f) => f(e)),
      );
    }, 300);
  }
  return countersPromise as Promise<T>;
}

/** Commands of the core and of every active plugin, as offered right now. */
export function allCommands(): Command[] {
  return [...coreCommands(), ...registry.items("commands")].filter((c) => !c.when || c.when());
}

function context(plugin: Plugin, disposers: (() => void)[]): PluginContext {
  const id = plugin.manifest.id;
  const own = (): Record<string, unknown> => (app.settings.plugin_settings?.[id] as Record<string, unknown>) ?? {};
  return {
    id,
    lang: () => i18n.lang,
    t: (text, params) => fill(pick(text), params),
    plural: (n, forms) => {
      const set = i18n.lang === "ru" ? forms.ru : forms.en;
      const cat = new Intl.PluralRules(i18n.lang).select(n) as keyof typeof set;
      return fill((set[cat] ?? set.other) as string, { n });
    },
    commands: allCommands,
    keyOf: (command) => shortcuts.key(command),
    keyTitle: (text, command) => shortcuts.titled(text, command),
    editKeys: (command, title) => app.editKeys(command, title),
    mail: {
      opened: () => app.opened,
      selection: () => app.selectedIds(),
      accounts: () => app.accounts,
      folders: () => app.folders,
      perform: (text, ids, run, failText) => app.perform(text, ids, run, failText),
      reload: () => app.reload(), scheduleReload: () => app.scheduleReload(),
      showView: (view) => app.setView({ kind: "plugin", id: view }),
      viewing: (view) => app.view.kind === "plugin" && app.view.id === view,
      compose: () => app.newMessage(),
      reply: (all) => app.replyTo(all),
      open: async (id, view) => {
        if (app.windowOf !== null) return;
        if (view) await app.setView({ kind: "plugin", id: view });
        await app.select(id);
      },
      main: () => app.windowOf === null,
    },
    backend: <T>(command: string, args?: Record<string, unknown>) => (command === "counters" ? sharedCounters<T>() : call<T>(command, args)),
    onBackend: (event, run) => {
      const off = listen(event, (e) => run(e.payload));
      disposers.push(() => void off.then((f) => f()));
    },
    openLink: (url) => app.openLink(url),
    toast: (text, o) => app.toast(text, o?.error ?? false, o?.action, o?.ms),
    fail: (e, prefix) => app.fail(e, prefix),
    anchor: () => keyAnchor(),
    workTime: () => workTimeFrom(app.settings),
    settings: {
      get: <T>(key: string, fallback: T) => (key in own() ? (own()[key] as T) : fallback),
      set: (key, value) => app.savePluginSettings(id, { ...own(), [key]: value }),
    },
    ui: {
      command: (c) => registry.add("commands", id, c),
      // A key alone, as before named keys (#46): its command is named by the plugin and the key.
      keybinding: (b: KeyBinding | string, run?: () => void, when?: () => boolean) =>
        registry.add("keybindings", id, typeof b === "string" ? { id: `${id}.key.${b}`, title: () => pick(plugin.manifest.name), key: b, run: run!, when } : b),
      readerToolbar: (r) => registry.add("readerToolbar", id, r),
      bulkToolbar: (r) => registry.add("bulkToolbar", id, r),
      readerHeader: (r) => registry.add("readerHeader", id, r),
      messageAction: (a) => registry.add("messageActions", id, a),
      rowAction: (a) => registry.add("rowActions", id, a),
      banner: (p) => registry.add("banners", id, p),
      rowTag: (p) => registry.add("rowTags", id, p),
      view: (v) => registry.add("views", id, v),
      listFilter: (f) => registry.add("listFilters", id, f),
      composeControl: (c) => registry.add("composeControls", id, c),
      sendCheck: (c) => registry.add("sendChecks", id, c),
      settingsSection: (s) => registry.add("settingsSections", id, s),
      overlay: (r) => registry.add("overlays", id, r),
      fileViewer: (v) => registry.add("fileViewers", id, v),
    },
  };
}

class Host {
  readonly plugins: Plugin[] = BUILTIN;
  private active = new Map<string, (() => void)[]>();

  /** A plugin off until the user switches it on: its id is listed in `enabled_plugins` while on. */
  private defaultOff(id: string): boolean {
    return this.plugins.find((p) => p.manifest.id === id)?.manifest.defaultOff === true;
  }

  enabled(id: string): boolean {
    if (this.defaultOff(id)) return (app.settings.enabled_plugins ?? []).includes(id);
    return !(app.settings.disabled_plugins ?? []).includes(id);
  }

  /** Brings the active set in line with the settings. */
  sync() {
    for (const p of this.plugins) {
      const id = p.manifest.id;
      const on = this.enabled(id);
      if (on && !this.active.has(id)) this.activate(p);
      else if (!on && this.active.has(id)) this.deactivate(id);
    }
  }

  private activate(p: Plugin) {
    const disposers: (() => void)[] = [];
    this.active.set(p.manifest.id, disposers);
    try {
      const done = p.activate(context(p, disposers));
      if (typeof done === "function") disposers.push(done);
    } catch (e) {
      console.error(`plugin ${p.manifest.id} failed to start:`, e);
      this.deactivate(p.manifest.id);
    }
  }

  private deactivate(id: string) {
    for (const d of this.active.get(id) ?? []) {
      try {
        d();
      } catch (e) {
        console.error(`plugin ${id} failed to stop:`, e);
      }
    }
    this.active.delete(id);
    registry.removeOwner(id);
  }

  setEnabled(id: string, on: boolean) {
    // A default-off plugin lists its id in `enabled_plugins` while the user wants it on;
    // the others list theirs in `disabled_plugins` while off.
    if (this.defaultOff(id)) {
      const rest = (app.settings.enabled_plugins ?? []).filter((x) => x !== id);
      app.patchSettings({ enabled_plugins: on ? [...rest, id] : rest });
      return;
    }
    const rest = (app.settings.disabled_plugins ?? []).filter((x) => x !== id);
    app.patchSettings({ disabled_plugins: on ? rest : [...rest, id] });
  }
}

export const host = new Host();
