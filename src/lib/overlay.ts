import { app } from "./store.svelte";
import { labels } from "./labels.svelte";

/** A window or a card of its own is open over the app: Esc and the keys of the lists are its, not the main window's. */
export const windowOpen = (): boolean => app.ui.settingsOpen || app.ui.tasksOpen || !!labels.card;
