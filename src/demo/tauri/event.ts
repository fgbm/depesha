// The demo stand-in for `@tauri-apps/api/event`. A live mockup is one page, so there is one
// window: `emit` and `emitTo` reach every listener alike, as the real app's global `listen`
// hears both. The shape matches Tauri's (`Event<T>` with `payload`), so the app's own event
// code (`src/lib/events.ts`, `background.svelte.ts`, `plugin-host/host.svelte.ts`) is unchanged.

export type UnlistenFn = () => void;

export interface Event<T> {
  event: string;
  payload: T;
}

export type EventCallback<T> = (event: Event<T>) => void;

type Handler = (event: Event<unknown>) => void;

const listeners = new Map<string, Set<Handler>>();

/** Subscribes to an event; the returned function stops it, as Tauri's does. */
export async function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  const h = handler as Handler;
  set.add(h);
  return () => {
    set.delete(h);
  };
}

function dispatch(event: string, payload: unknown) {
  const set = listeners.get(event);
  if (!set) return;
  // A copy: a handler may unsubscribe while the burst is delivered.
  for (const h of [...set]) h({ event, payload });
}

/** Tells every listener in the page (the demo backend uses this for `mail-changed` and the like). */
export async function emit(event: string, payload?: unknown): Promise<void> {
  dispatch(event, payload);
}

/** As `emit`: a live mockup has no second window to single out. */
export async function emitTo(_target: string | { label?: string }, event: string, payload?: unknown): Promise<void> {
  dispatch(event, payload);
}
