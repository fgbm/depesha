// The mechanism of design variants for the live mockup. A design decision that is not made
// yet becomes a question with numbered options; a component reads `variant("1.1")` and shows
// the option chosen for it. The choice lives in the URL (`?v=1.1:V,2.1:B`) and in
// localStorage, so a link carries a whole set of decisions and a reload keeps them.
//
// Defaults matter: with nothing chosen, `variant()` answers `now` — «как сейчас», the app as
// it is today. The recommended option is marked in the panel but is **not** chosen by
// default: an unanswered question must look unanswered, or the mockup would quietly decide
// for the operator.
//
// How a variant reaches a component without polluting the app: it does not reach the app at
// all. `variant()` and this file live under `src/demo/`, which never enters the production
// bundle (`scripts/demo-guard.mjs` fails the build if it does). A variant is used on the
// mockup branch only (`mock/<version>`): the component there calls `variant("1.1")` with a
// literal id, and when the operator settles the question, the winning branch is written into
// the component as plain code and the `variant()` call is deleted. The main line therefore
// never contains a `variant()` call, and no `if (demo)` appears anywhere.

/** The id of «как сейчас»: what an unanswered question answers with. */
export const NOW = "now";

/** One option of a question: a short id shown in the URL and a title shown in the panel. */
export interface VariantOption {
  id: string;
  title: string;
  /** The panel marks it with a star; it is not chosen by default. */
  recommended?: boolean;
}

/** A design decision put to the operator. */
export interface Question {
  /** The number the operator answers by, e.g. `1.1`. */
  id: string;
  title: string;
  options: VariantOption[];
}

const KEY = "depesha.demo.variants";

/** The answers a `?v=` query carries: `1.1:V,2.1:B`. */
export function parseUrl(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = new URLSearchParams(search).get("v") ?? "";
  for (const part of raw.split(",")) {
    const at = part.indexOf(":");
    if (at <= 0) continue;
    const id = part.slice(0, at).trim();
    const option = part.slice(at + 1).trim();
    if (id && option) out[id] = option;
  }
  return out;
}

function parseStored(raw: string | null): Record<string, string> {
  if (!raw) return {};
  const data: unknown = JSON.parse(raw);
  if (!data || typeof data !== "object") return {};
  const out: Record<string, string> = {};
  for (const [id, option] of Object.entries(data as Record<string, unknown>)) if (typeof option === "string") out[id] = option;
  return out;
}

function readStored(): Record<string, string> {
  try {
    return parseStored(localStorage.getItem(KEY));
  } catch {
    // Storage off (a private window): nothing is kept between reloads, which is fine.
    return {};
  }
}

class Variants {
  /** The option chosen per question; a question absent here answers `now`. */
  answers = $state<Record<string, string>>({});
  /** Free notes the operator adds; kept with the answers. */
  notes = $state<string[]>([]);
  /** The panel is open (the `` ` `` key toggles it). */
  open = $state(true);

  /** Reads the stored answers, then the URL over them (a link wins over what was kept). */
  init(search?: string) {
    const query = search ?? (typeof location !== "undefined" ? location.search : "");
    this.answers = { ...readStored(), ...parseUrl(query) };
  }

  get(id: string): string {
    return this.answers[id] ?? NOW;
  }

  set(id: string, option: string) {
    this.answers = { ...this.answers, [id]: option };
    this.persist();
  }

  clear(id: string) {
    const next = { ...this.answers };
    delete next[id];
    this.answers = next;
    this.persist();
  }

  addNote(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.notes = [...this.notes, trimmed];
  }

  private persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.answers));
    } catch {
      // Storage off: the answers still work for this page; the URL is the other way to keep them.
    }
    if (typeof location === "undefined" || typeof history === "undefined") return;
    const url = new URL(location.href);
    const v = Object.entries(this.answers).map(([id, option]) => `${id}:${option}`).join(",");
    if (v) url.searchParams.set("v", v);
    else url.searchParams.delete("v");
    try {
      history.replaceState(null, "", url);
    } catch {
      // A file:// URL may refuse a rewrite; the choice is still in memory and in storage.
    }
  }
}

export const variants = new Variants();

/** The option chosen for a question, or `now` while it is unanswered. */
export function variant(id: string): string {
  return variants.get(id);
}
