// Interface language: English or Russian. `t` reads a reactive language, so every
// template and $derived that uses it follows a language switch at once.

import { en, type Plural } from "./locales/en";
import { ru } from "./locales/ru";

export type Lang = "en" | "ru";
export type Key = keyof typeof en;
type Params = Record<string, string | number>;

class I18n {
  lang = $state<Lang>("en");
}

export const i18n = new I18n();

const dicts = { en, ru } as const;

function fill(s: string, params?: Params): string {
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s;
}

/** Text for `key` with `{name}` placeholders filled in. */
export function t(key: Key, params?: Params): string {
  const v = dicts[i18n.lang][key] ?? en[key];
  return fill(typeof v === "string" ? v : v.other, params);
}

/** Plural text for `n`: `{n}` and other placeholders filled in. */
export function tn(key: Key, n: number, params?: Params): string {
  const v = (dicts[i18n.lang][key] ?? en[key]) as string | Plural;
  if (typeof v === "string") return fill(v, { n, ...params });
  const form = new Intl.PluralRules(i18n.lang).select(n) as keyof Plural;
  return fill(v[form] ?? v.other, { n, ...params });
}

/** BCP 47 locale for Intl date and number formats. */
export function locale(): string {
  return i18n.lang === "ru" ? "ru-RU" : "en-GB";
}
