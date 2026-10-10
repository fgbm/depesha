// A typed channel for the commands and events of the interface: the name of an event and the
// type of what it carries are one map (`UiEvents`). It is a leaf module with no state of the
// app: anyone may subscribe, and a subscription is a function that takes itself back, which
// is what a Svelte `$effect` wants to return:
//
//   $effect(() => bus.on("people.search", () => searchEl?.focus()));
//
// Several subscribers to one event are fine; an event nobody hears is dropped (a command is not
// kept for a component that is not there yet; what must outlive the moment is state, not an event).
// Data that only has to be read again is not sent here: it is `$state` and `$derived`.

/** What `emit` of an event hands to its subscribers: a collector of the answers they owe. */
export interface Gather<T> {
  /** Adds an answer; the one who emitted waits for all of them. */
  add(answer: Promise<T>): void;
}

/**
 * The events of the interface and what each carries. An event that carries nothing is `void`.
 * The commands are named by what they ask for, the events by what has happened.
 */
export interface UiEvents {
  /** Focus the search box of the mail list. */
  "mail.search": void;
  /** Focus the search box of the address book (only the open book hears it). */
  "people.search": void;
  /** A merge of people is over, done or not: the book gives its list the focus back. */
  "people.merge-ended": void;
  /** Show the card of the open letter's sender (its key, #104). */
  "reader.sender-card": void;
  /** `openSettings` was called: an open settings window turns to this page. */
  "settings.open": { page: string };
  /** A quit or a closing window asks every open draft to be kept (#71). */
  "compose.save-all": Gather<boolean>;
}

type Args<M, K extends keyof M> = M[K] extends void ? [] : [payload: M[K]];

export interface Bus<M> {
  /** Subscribes; the returned function takes the subscription back (calling it twice is fine). */
  on<K extends keyof M>(name: K, handler: (...args: Args<M, K>) => void): () => void;
  /** Tells every current subscriber, in the order they came. One that throws does not stop the rest; the first error is thrown after all heard. */
  emit<K extends keyof M>(name: K, ...args: Args<M, K>): void;
  /** How many subscribers an event has: for tests of the leaks. */
  count(name: keyof M): number;
}

export function createBus<M>(): Bus<M> {
  const handlers = new Map<keyof M, Set<(...args: never[]) => void>>();
  return {
    on(name, handler) {
      const entry = handler as (...args: never[]) => void;
      // A set would merge the same function subscribed twice, and one off would take both.
      const mine = (...args: never[]) => entry(...args);
      let set = handlers.get(name);
      if (!set) handlers.set(name, (set = new Set()));
      set.add(mine);
      return () => {
        const now = handlers.get(name);
        if (!now) return;
        now.delete(mine);
        if (!now.size) handlers.delete(name);
      };
    },
    emit(name, ...args) {
      const set = handlers.get(name);
      if (!set) return;
      const failed: unknown[] = [];
      for (const h of [...set]) {
        // A subscriber taken back by an earlier one in this very round no longer hears it.
        if (!set.has(h)) continue;
        try {
          (h as (...a: unknown[]) => void)(...args);
        } catch (e) {
          failed.push(e);
        }
      }
      if (failed.length) throw failed[0];
    },
    count: (name) => handlers.get(name)?.size ?? 0,
  };
}

export const bus: Bus<UiEvents> = createBus<UiEvents>();
