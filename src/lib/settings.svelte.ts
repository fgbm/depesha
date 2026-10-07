// The settings of the app, the built-in plugins' own settings and the update check:
// reading them, saving them, and following the language and the theme they ask for.
// The app store keeps `settings` and `update` as fields of its own, so components
// read and write them exactly as before.

import { api } from "./api";
import { applyTheme } from "./theme";
import { i18n, t } from "./i18n.svelte";
import { shortcuts } from "./shortcuts.svelte";
import type { KeySettings, Settings, UpdateStatus } from "./types";

/** What the settings need from the app store. */
export interface SettingsHost {
  fail(e: unknown, prefix?: string): void;
  toast(text: string): void;
  /** The list is read again when the threading of letters changed. */
  reload(): void;
}

export class SettingsController {
  settings = $state<Settings>({
    undo_send_secs: 10,
    notify: "people",
    dnd_until: 0,
    threads: true,
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
    compose_format: "html",
    quota_warn: true,
    quota_levels: [90, 95],
    quota_repeat: "threshold",
    close_action: "ask",
    background_without_tray: false,
    autostart: "off",
    tray_count: true,
    tray_always: true,
    hints: true,
  });
  update = $state<UpdateStatus | null>(null);

  constructor(private host: SettingsHost) {
    shortcuts.use(() => this.settings.keybindings);
  }

  /** The language resolved by the backend: the setting, or the system locale. */
  async loadLanguage() {
    try {
      i18n.lang = await api.language();
      document.documentElement.lang = i18n.lang;
    } catch {
      // Stays English.
    }
  }

  async loadSettings() {
    try {
      this.settings = await api.settings();
      applyTheme(this.settings.theme);
    } catch (e) {
      this.host.fail(e);
    }
  }

  async saveSettings(next: Settings) {
    const threadsChanged = next.threads !== this.settings.threads;
    this.settings = next;
    applyTheme(next.theme);
    try {
      await api.saveSettings($state.snapshot(next));
    } catch (e) {
      this.host.fail(e, t("err.settings"));
      // Refused (a folder not picked in the dialog): the window shows what is saved.
      await this.loadSettings();
    }
    await this.loadLanguage();
    if (threadsChanged) this.host.reload();
  }

  /**
   * The user's keys alone, saved at once (#46): a change on the «Keys» page takes effect
   * without the window's «Save», and the unsaved edits of other pages are left alone.
   */
  saveKeybindings(next: KeySettings) {
    return this.saveSettings({ ...$state.snapshot(this.settings), keybindings: $state.snapshot(next) });
  }

  /** A built-in plugin's own settings; a letter's window may save them, not the rest. */
  async savePluginSettings(plugin: string, values: Record<string, unknown>) {
    this.settings = { ...this.settings, plugin_settings: { ...(this.settings.plugin_settings ?? {}), [plugin]: values } };
    try {
      await api.pluginSettingsSet(plugin, $state.snapshot(values));
    } catch (e) {
      this.host.fail(e, t("err.settings"));
    }
  }

  async checkUpdates() {
    try {
      this.update = await api.updateCheck();
      if (this.update.state === "idle") this.host.toast(t("update.latest", { version: this.update.current }));
    } catch (e) {
      this.host.fail(e);
    }
  }

  async installUpdate() {
    try {
      this.update = await api.updateInstall();
    } catch (e) {
      this.host.fail(e, t("update.title"));
    }
  }

  restartForUpdate() {
    api.updateRestart().catch((e) => this.host.fail(e));
  }
}
