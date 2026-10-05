// Turns built-in plugins on and off by the settings and gives each its context. A plugin
// only sees `PluginContext`; the host keeps the wiring to the app store here.

import { listen } from "@tauri-apps/api/event";
import { BUILTIN } from "../../plugins";
import type { Command, Plugin, PluginContext, Text } from "../plugin-api";
import { call } from "../lib/api";
import { i18n } from "../lib/i18n.svelte";
import { app } from "../lib/store.svelte";
import { coreCommands } from "../lib/commands";
import { registry } from "./registry.svelte";

function fill(s: string, params?: Record<string, string | number>): string {
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s;
}

function pick(text: Text): string {
  return i18n.lang === "ru" ? text.ru : text.en;
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
    mail: {
      opened: () => app.opened,
      selection: () => app.selectedIds(),
      accounts: () => app.accounts,
      folders: () => app.folders,
      perform: (text, ids, run, failText) => app.perform(text, ids, run, failText),
      reload: () => app.reload(),
      showView: (view) => app.setView({ kind: "plugin", id: view }),
      viewing: (view) => app.view.kind === "plugin" && app.view.id === view,
      compose: () => app.newMessage(),
      reply: (all) => app.replyTo(all),
    },
    backend: <T>(command: string, args?: Record<string, unknown>) => call<T>(command, args),
    onBackend: (event, run) => {
      const off = listen(event, (e) => run(e.payload));
      disposers.push(() => void off.then((f) => f()));
    },
    openLink: (url) => app.openLink(url),
    toast: (text, o) => app.toast(text, o?.error ?? false, o?.action, o?.ms),
    fail: (e, prefix) => app.fail(e, prefix),
    settings: {
      get: <T>(key: string, fallback: T) => (key in own() ? (own()[key] as T) : fallback),
      set: (key, value) =>
        app.saveSettings({
          ...app.settings,
          plugin_settings: { ...(app.settings.plugin_settings ?? {}), [id]: { ...own(), [key]: value } },
        }),
    },
    ui: {
      command: (c) => registry.add("commands", id, c),
      keybinding: (key, run, when) => registry.add("keybindings", id, { key, run, when }),
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

  enabled(id: string): boolean {
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
    const off = (app.settings.disabled_plugins ?? []).filter((x) => x !== id);
    app.saveSettings({ ...app.settings, disabled_plugins: on ? off : [...off, id] });
  }
}

export const host = new Host();
