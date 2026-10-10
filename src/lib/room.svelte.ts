// What the windows know about each mailbox's server: the room every mailbox has (the
// sidebar's line, the warnings) and, for an open mailbox page, the whole of what the
// cache keeps about its server. The backend says `server-changed` when any of it moved.

import { api, asError } from "./api";
import { accountLabel } from "./format";
import { t } from "./i18n.svelte";
import { largeMailSearch, levelOf, levels, percent, roomOf, usedOf, warning, wholePercent, type Level, type Room, type Warned } from "./quota";
import type { AppStore } from "./store.svelte";
import type { AccountView, QuotaView, ServerView } from "./types";

const WARNED_KEY = "depesha.quotaWarned";

function readWarned(): Record<string, Warned> {
  try {
    return JSON.parse(localStorage.getItem(WARNED_KEY) ?? "{}");
  } catch {
    // A broken stored value starts from nothing.
    return {};
  }
}

function writeWarned(w: Record<string, Warned>) {
  try {
    localStorage.setItem(WARNED_KEY, JSON.stringify(w));
  } catch {
    // Without storage a warning may come again after a restart; nothing worse.
  }
}

class Rooms {
  /** The room of every IMAP mailbox, by account id. */
  quotas = $state<Record<string, QuotaView>>({});
  /** What the cache knows about a server, for the mailbox pages opened. */
  infos = $state<Record<string, ServerView>>({});
  /** "Check again" under way, by account id. */
  checking = $state<Record<string, boolean>>({});

  private app: AppStore | null = null;

  /** The main window: loads the rooms and warns as they change. */
  start(app: AppStore) {
    this.app = app;
    return this.loadQuotas();
  }

  async loadQuotas() {
    try {
      const list = await api.quotas();
      this.quotas = Object.fromEntries(list.map((q) => [q.account_id, q]));
    } catch {
      // No bars until the next refresh.
      return;
    }
    this.warn();
  }

  async loadInfo(accountId: string) {
    try {
      this.infos[accountId] = await api.serverInfo(accountId);
    } catch (e) {
      this.app?.ui.fail(e);
    }
  }

  /** The backend's word: this mailbox's server state moved. */
  changed(accountId: string) {
    this.loadQuotas();
    if (accountId in this.infos) this.loadInfo(accountId);
  }

  async check(accountId: string) {
    this.checking[accountId] = true;
    try {
      this.infos[accountId] = await api.serverCheck(accountId);
    } catch (e) {
      this.app?.ui.toast(asError(e).message, true);
    } finally {
      this.checking[accountId] = false;
    }
  }

  /** Reads the quota again when the "Storage" section opens. */
  refresh(accountId: string) {
    // Quiet: the section was not asked for.
    api.quotaRefresh(accountId).catch(() => {});
  }

  async count(accountId: string) {
    try {
      await api.folderSizesCount(accountId);
      await this.loadInfo(accountId);
    } catch (e) {
      this.app?.ui.fail(e);
    }
  }

  async stop(accountId: string) {
    // Stopping is best effort; the info loaded below shows the real state.
    await api.folderSizesStop(accountId).catch(() => {});
    await this.loadInfo(accountId);
  }

  room(account: AccountView): Room | null {
    const r = roomOf(this.quotas[account.id], account);
    // A room with no limit (Exchange without the user's own limit) has nothing to show
    // as a bar in the sidebar: the "Storage" section shows the occupied volume itself.
    return r && r.limit > 0 ? r : null;
  }

  level(account: AccountView): Level {
    const r = this.room(account);
    return r && this.app ? levelOf(percent(r), levels(this.app.settings.quota_levels)) : 0;
  }

  /** Opens the large letters: the search with the threshold of large mail. */
  findLarge() {
    this.app?.selection.setView({ kind: "search", text: largeMailSearch(this.app.settings.large_mb) });
  }

  /** A toast once per level crossed (and a desktop notification when full and out of sight). */
  private warn() {
    const app = this.app;
    if (!app) return;
    const s = app.settings;
    const warned = readWarned();
    const now = Date.now();
    for (const acc of app.accounts) {
      const r = this.room(acc);
      const level = r && s.quota_warn !== false && acc.quota_warn !== false ? levelOf(percent(r), levels(s.quota_levels)) : 0;
      const { warn, next } = warning(warned[acc.id], level, now, s.quota_repeat);
      if (next) warned[acc.id] = next;
      else delete warned[acc.id];
      if (!warn || !r) continue;
      const { used, limit } = usedOf(r.used, r.limit);
      const name = accountLabel(acc);
      const source = r.estimate ? t("quota.sourceEstimate") : t("quota.sourceServer");
      const action = { label: t("storage.findLarge"), run: () => this.findLarge() };
      if (level === 3) {
        app.ui.toast(t("quota.toastFull", { name, used, limit, source }), true, action);
        // The system notification only repeats the toast above.
        api.notifyFull(t("quota.notifyTitle", { name }), t("quota.notifyBody", { used, limit })).catch(() => {});
      } else {
        app.ui.toast(t("quota.toast", { name, p: wholePercent(percent(r)), used, limit, source }), false, action);
      }
    }
    writeWarned(warned);
  }
}

export const rooms = new Rooms();
