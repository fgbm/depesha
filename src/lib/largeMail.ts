// Ready-made queries for large mail. A query is only search text with the cache's
// operators (query.rs): it lands in the search box, where the threshold, the year or
// anything else can be changed by hand. The threshold comes from the settings.

import { size } from "./format";
import { i18n, t, type Lang } from "./i18n.svelte";
import type { SortKey } from "./types";

export interface ReadyQuery {
  id: string;
  title: string;
  text: string;
}

/** Operators in the interface language: a Russian search box gets Russian operators. */
const OPS: Record<Lang, { larger: string; mb: string; older: string; years: string; year: string; files: string; in: string }> = {
  en: { larger: "larger", mb: "M", older: "older", years: "y", year: "year", files: "has:attachment", in: "in" },
  ru: { larger: "больше", mb: "М", older: "старше", years: "г", year: "год", files: "есть:вложение", in: "в" },
};

/** `в:Работа/*`, quoted when the name has spaces. */
export function folderOperator(name: string, subfolders: boolean, lang: Lang = i18n.lang): string {
  const value = subfolders ? `${name}/*` : name;
  return `${OPS[lang].in}:${/\s/.test(value) ? `"${value}"` : value}`;
}

/**
 * The ready queries: large, large and older than one and two years, large in each of
 * the last two full years, with attachments and older than a year. `folder` (a folder's
 * full name) adds "large in this folder and its subfolders", as the palette offers it.
 */
export function readyQueries(thresholdMb: number, now = new Date(), folder: string | null = null): ReadyQuery[] {
  const o = OPS[i18n.lang];
  const mb = threshold(thresholdMb);
  const large = `${o.larger}:${mb}${o.mb}`;
  const year = now.getFullYear();
  const list: ReadyQuery[] = [
    { id: "large", title: t("ready.large", { size: size(mb * 1024 * 1024, 0) }), text: large },
    { id: "older1", title: t("ready.older1"), text: `${large} ${o.older}:1${o.years}` },
    { id: "older2", title: t("ready.older2"), text: `${large} ${o.older}:2${o.years}` },
    ...[year - 1, year - 2].map((y) => ({ id: `year${y}`, title: t("ready.year", { year: y }), text: `${large} ${o.year}:${y}` })),
    { id: "files", title: t("ready.files"), text: `${o.files} ${o.older}:1${o.years}` },
  ];
  if (folder) list.push({ id: "folder", title: t("ready.folder"), text: `${large} ${folderOperator(folder, true)}` });
  return list;
}

/** A usable threshold: a whole number of megabytes, at least 1. */
export function threshold(value: number, fallback = 25): number {
  return Number.isFinite(value) && value >= 1 ? Math.min(Math.round(value), 1024 * 1024) : fallback;
}

/** This year and the ones before it, newest first. */
export function recentYears(now = new Date(), n = 8): number[] {
  const y = now.getFullYear();
  return Array.from({ length: n }, (_, i) => y - i);
}

const LARGER = /(^|\s)(larger|больше):\S/i;

/** The search asks for letters above a size: it puts the largest first by itself. */
export function asksLarge(text: string): boolean {
  return LARGER.test(text);
}

/** The order of a search for large letters until the user picks another one. */
export const LARGEST_FIRST: SortKey[] = [{ by: "size", desc: true }];
