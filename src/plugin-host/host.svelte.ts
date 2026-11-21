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
import { addressesOf, allMailQuery, blankPerson, matchPerson } from "../lib/people";
import { peopleBook } from "../lib/peopleBook.svelte";
import { registry } from "./registry.svelte";
import { guardCommand, guardKey, guardListFilter, guardView } from "./guard";

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

/** What a plugin's key does now, if the plugin has one under this id and it applies; the windows' key handlers share it. */
export function keybindingRun(id: string): (() => void) | undefined {
  return registry.items("keybindings").find((b) => b.id === id && (!b.when || b.when()))?.run;
}

/** What a plugin registers while it is on; once it is off, its context adds nothing more. */
function liveAdd(live: () => boolean): typeof registry.add {
  return (kind, owner, item) => {
    if (live()) registry.add(kind, owner, item);
  };
}

/** A backend event for a plugin that is still on: its listener goes when the plugin goes. */
function subscribe(disposers: (() => void)[], live: () => boolean, event: string, run: (payload: unknown) => void) {
  if (!live()) return;
  const off = listen(event, (e) => run(e.payload));
  disposers.push(() => void off.then((f) => f()));
}

const fail = (e: unknown) => app.ui.fail(e);

function context(plugin: Plugin, disposers: (() => void)[], live: () => boolean): PluginContext {
  const id = plugin.manifest.id;
  const add = liveAdd(live);
  const own = (): Record<string, unknown> => (app.settingsCtl.settings.plugin_settings?.[id] as Record<string, unknown>) ?? {};
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
    editKeys: (command, title) => app.ui.editKeys(command, title),
    people: {
      find: (query) =>
        peopleBook.list
          .filter((p) => matchPerson(p, query))
          .slice(0, 6)
          .map((p) => ({ name: p.name || p.email, email: p.email, emails: addressesOf(p) })),
      open: (email) => void app.openPeople({ email }),
      allMail: (email) => void app.selection.setView({ kind: "search", text: allMailQuery(peopleBook.find(email) ?? blankPerson(email)) }),
    },
    mail: {
      opened: () => app.reader.opened,
      selection: () => app.selection.selectedIds(),
      accounts: () => app.mailboxes.accounts,
      folders: () => app.mailboxes.folders,
      perform: (text, ids, run, failText) => app.actions.perform(text, ids, run, failText),
      offerUndo: (text, run) => app.actions.offer(text, run),
      reload: () => app.selection.reload(), scheduleReload: () => app.selection.scheduleReload(),
      showView: (view) => app.selection.setView({ kind: "plugin", id: view }),
      viewing: (view) => app.list.view.kind === "plugin" && app.list.view.id === view,
      compose: () => app.compose.newMessage(),
      reply: (all) => app.compose.replyTo(all),
      open: async (id, view) => {
        if (app.windowOf !== null) return;
        if (view) await app.selection.setView({ kind: "plugin", id: view });
        await app.selection.select(id);
      },
      main: () => app.windowOf === null,
    },
    backend: <T>(command: string, args?: Record<string, unknown>) => (command === "counters" ? sharedCounters<T>() : call<T>(command, args)),
    onBackend: (event, run) => subscribe(disposers, live, event, run),
    openLink: (url) => app.ui.openLink(url),
    toast: (text, o) => app.ui.toast(text, o?.error ?? false, o?.action, o?.ms),
    fail: (e, prefix) => app.ui.fail(e, prefix),
    anchor: () => keyAnchor(),
    workTime: () => workTimeFrom(app.settingsCtl.settings),
    settings: {
      get: <T>(key: string, fallback: T) => (key in own() ? (own()[key] as T) : fallback),
      set: (key, value) => app.settingsCtl.savePluginSettings(id, { ...own(), [key]: value }),
    },
    ui: {
      command: (c) => add("commands", id, guardCommand(id, c, fail)),
      // A key alone, as before named keys (#46): its command is named by the plugin and the key.
      keybinding: (b: KeyBinding | string, run?: () => void, when?: () => boolean) =>
        add("keybindings", id, guardKey(id, typeof b === "string" ? { id: `${id}.key.${b}`, title: () => pick(plugin.manifest.name), key: b, run: run!, when } : b, fail)),
      readerToolbar: (r) => add("readerToolbar", id, r),
      bulkToolbar: (r) => add("bulkToolbar", id, r),
      readerHeader: (r) => add("readerHeader", id, r),
      messageAction: (a) => add("messageActions", id, a),
      rowAction: (a) => add("rowActions", id, a),
      banner: (p) => add("banners", id, p),
      rowTag: (p) => add("rowTags", id, p),
      view: (v) => add("views", id, guardView(id, v, fail)),
      listFilter: (f) => add("listFilters", id, guardListFilter(id, f, fail)),
      composeControl: (c) => add("composeControls", id, c),
      composeReplacements: (t) => add("composeReplacements", id, t),
      sendCheck: (c) => add("sendChecks", id, c),
      settingsSection: (s) => add("settingsSections", id, s),
      overlay: (r) => add("overlays", id, r),
      fileViewer: (v) => add("fileViewers", id, v),
    },
  };
}

class Host {
  readonly plugins: Plugin[] = BUILTIN;
  private active = new Map<string, (() => void)[]>();
  /** Plugins whose `activate` threw: not started again until the user switches them off and on. */
  private failed = new Set<string>();

  /** A plugin off until the user switches it on: its id is listed in `enabled_plugins` while on. */
  private defaultOff(id: string): boolean {
    return this.plugins.find((p) => p.manifest.id === id)?.manifest.defaultOff === true;
  }

  enabled(id: string): boolean {
    if (this.defaultOff(id)) return (app.settingsCtl.settings.enabled_plugins ?? []).includes(id);
    return !(app.settingsCtl.settings.disabled_plugins ?? []).includes(id);
  }

  /** Brings the active set in line with the settings; not before they are read, for the defaults would start what the user switched off (#158). */
  sync() {
    if (app.settingsCtl.pending) return;
    for (const p of this.plugins) {
      const id = p.manifest.id;
      const on = this.enabled(id);
      if (!on) this.failed.delete(id);
      if (on && !this.active.has(id) && !this.failed.has(id)) this.activate(p);
      else if (!on && this.active.has(id)) this.deactivate(id);
    }
  }

  private activate(p: Plugin) {
    const disposers: (() => void)[] = [];
    this.active.set(p.manifest.id, disposers);
    const live = () => this.active.get(p.manifest.id) === disposers;
    try {
      const done = p.activate(context(p, disposers, live));
      if (typeof done === "function") disposers.push(done);
    } catch (e) {
      console.error(`plugin ${p.manifest.id} failed to start:`, e);
      this.failed.add(p.manifest.id);
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
      const rest = (app.settingsCtl.settings.enabled_plugins ?? []).filter((x) => x !== id);
      app.settingsCtl.patchSettings({ enabled_plugins: on ? [...rest, id] : rest });
      return;
    }
    const rest = (app.settingsCtl.settings.disabled_plugins ?? []).filter((x) => x !== id);
    app.settingsCtl.patchSettings({ disabled_plugins: on ? rest : [...rest, id] });
  }
}

export const host = new Host();
