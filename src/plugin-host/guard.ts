// A plugin's functions as the core calls them. A throw costs only that plugin's answer and is
// logged with its name, so one plugin cannot break the palette, the keys or the list
// (registry.collect does the same for banners and row tags).

import type { Command, KeyBinding, ListFilter, View } from "../plugin-api";

/** How a failed action of a plugin reaches the user: an action that does nothing must say so. */
export type Fail = (e: unknown) => void;

function logged(owner: string, what: string, e: unknown) {
  console.error(`plugin ${owner}: ${what} failed:`, e);
}

/** A function whose answer the core reads; a throw gives `fallback`. */
export function answer<A extends unknown[], R>(owner: string, what: string, fn: (...args: A) => R, fallback: R): (...args: A) => R {
  return (...args) => {
    try {
      return fn(...args);
    } catch (e) {
      logged(owner, what, e);
      return fallback;
    }
  };
}

/** A function the user starts; a throw, or a promise that rejects, is logged and shown with `fail`. */
export function action<A extends unknown[]>(owner: string, what: string, fn: (...args: A) => unknown, fail: Fail): (...args: A) => void {
  const failed = (e: unknown) => {
    logged(owner, what, e);
    fail(e);
  };
  return (...args) => {
    try {
      const done = fn(...args);
      if (done instanceof Promise) done.catch(failed);
    } catch (e) {
      failed(e);
    }
  };
}

export function guardCommand(owner: string, c: Command, fail: Fail): Command {
  return {
    ...c,
    title: answer(owner, `title of ${c.id}`, c.title, c.id),
    hint: c.hint && answer(owner, `hint of ${c.id}`, c.hint, ""),
    synonyms: c.synonyms && answer(owner, `synonyms of ${c.id}`, c.synonyms, ""),
    when: c.when && answer(owner, `when of ${c.id}`, c.when, false),
    run: action(owner, c.id, c.run, fail),
  };
}

export function guardKey(owner: string, k: KeyBinding, fail: Fail): KeyBinding {
  return {
    ...k,
    title: answer(owner, `title of ${k.id}`, k.title, k.id),
    when: k.when && answer(owner, `when of ${k.id}`, k.when, false),
    run: action(owner, k.id, k.run, fail),
  };
}

/** A view that throws shows no badge and no entry. Its `query` has no safe answer and is called as given. */
export function guardView(owner: string, v: View, fail: Fail): View {
  const tabs = v.tabs;
  return {
    ...v,
    title: answer(owner, `title of view ${v.id}`, v.title, v.id),
    count: answer(owner, `count of view ${v.id}`, v.count, 0),
    empty: answer(owner, `empty text of view ${v.id}`, v.empty, ""),
    shown: v.shown && answer(owner, `shown of view ${v.id}`, v.shown, false),
    tabs: tabs && {
      options: answer(owner, `tabs of view ${v.id}`, tabs.options, []),
      current: answer(owner, `current tab of view ${v.id}`, tabs.current, ""),
      select: action(owner, `tab of view ${v.id}`, tabs.select, fail),
    },
  };
}

/** A filter that throws narrows nothing: the list shows all its messages rather than none. */
export function guardListFilter(owner: string, f: ListFilter, fail: Fail): ListFilter {
  return {
    ...f,
    title: answer(owner, "title of a list filter", f.title, ""),
    options: answer(owner, "options of a list filter", f.options, []),
    current: answer(owner, "current option of a list filter", f.current, ""),
    select: action(owner, "option of a list filter", f.select, fail),
    query: answer(owner, "query of a list filter", f.query, {}),
    count: f.count && answer(owner, "count of a list filter", f.count, undefined),
  };
}
