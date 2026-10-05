// What the windows know about each mailbox's server: for an open mailbox page, what the
// cache keeps about its server. The backend says `server-changed` when any of it moved.

import { api, asError } from "./api";
import type { AppStore } from "./store.svelte";
import type { ServerView } from "./types";

class Rooms {
  /** What the cache knows about a server, for the mailbox pages opened. */
  infos = $state<Record<string, ServerView>>({});
  /** "Check again" under way, by account id. */
  checking = $state<Record<string, boolean>>({});

  private app: AppStore | null = null;

  /** The main window: errors are told in its toasts. */
  start(app: AppStore) {
    this.app = app;
  }

  async loadInfo(accountId: string) {
    try {
      this.infos[accountId] = await api.serverInfo(accountId);
    } catch (e) {
      this.app?.fail(e);
    }
  }

  /** The backend's word: this mailbox's server state moved. */
  changed(accountId: string) {
    if (accountId in this.infos) this.loadInfo(accountId);
  }

  async check(accountId: string) {
    this.checking[accountId] = true;
    try {
      this.infos[accountId] = await api.serverCheck(accountId);
    } catch (e) {
      this.app?.toast(asError(e).message, true);
    } finally {
      this.checking[accountId] = false;
    }
  }
}

export const rooms = new Rooms();
