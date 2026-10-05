// The "Server" section's table: what a server offers, read from its CAPABILITY list, and
// what Depesha does with each feature. The Depesha column follows the code, not hopes:
// `Caps` in crates/depesha-core/src/imap.rs and where it is read. A new feature is a row
// of FEATURES with its texts in the locales; nothing else changes.

import { t, tn, type Key } from "./i18n.svelte";
import { gb } from "./quota";

/** What the server says about a feature. */
export type ServerMark = "yes" | "base" | "no" | "enabled" | "refused";

/** What Depesha does with it. */
export type UseMark = "used" | "notUsed" | "notNeeded" | "polling" | "workaround" | "byName" | "estimate" | "without";

export type Group = "used" | "unused" | "missing" | "refused";

interface Feature {
  id: string;
  /** Capability names that stand for it; `X=*` takes any value of X. */
  tokens: string[];
  /** Part of IMAP4rev2 (RFC 9051): a server of that version has it without naming it. */
  rev2?: boolean;
  /** Depesha uses it when the server has it. */
  used: boolean;
  /** Depesha does it itself, the server is not needed for it. */
  notNeeded?: boolean;
  /** What Depesha does without it; none: the row is not shown when the server lacks it. */
  missing?: UseMark;
  /** Its absence slows Depesha down where the user sees it: the section's dot. */
  important?: boolean;
}

const FEATURES: Feature[] = [
  { id: "idle", tokens: ["IDLE"], rev2: true, used: true, missing: "polling", important: true },
  { id: "condstore", tokens: ["CONDSTORE", "QRESYNC"], used: true, missing: "without" },
  { id: "qresync", tokens: ["QRESYNC"], used: true, missing: "without" },
  { id: "move", tokens: ["MOVE"], rev2: true, used: true, missing: "workaround", important: true },
  { id: "uidplus", tokens: ["UIDPLUS"], rev2: true, used: true, missing: "workaround" },
  { id: "specialUse", tokens: ["SPECIAL-USE"], rev2: true, used: true, missing: "byName" },
  { id: "quota", tokens: ["QUOTA"], used: true, missing: "estimate" },
  { id: "statusSize", tokens: ["STATUS=SIZE"], rev2: true, used: true, missing: "without" },
  { id: "literalPlus", tokens: ["LITERAL+"], used: true, missing: "without" },
  { id: "id", tokens: ["ID"], used: false },
  { id: "sortThread", tokens: ["SORT", "THREAD=*"], used: false, notNeeded: true },
  { id: "esearch", tokens: ["ESEARCH"], rev2: true, used: false },
  { id: "namespace", tokens: ["NAMESPACE"], rev2: true, used: false },
  { id: "acl", tokens: ["ACL"], used: false },
  { id: "appendLimit", tokens: ["APPENDLIMIT", "APPENDLIMIT=*"], used: false },
  { id: "compress", tokens: ["COMPRESS=DEFLATE"], used: false, missing: "notUsed" },
];

/** Names that are part of the protocol itself or of login: neither features nor unknown. */
const PROTOCOL = ["IMAP4REV1", "IMAP4REV2", "STARTTLS", "LOGINDISABLED", "AUTH=*", "ENABLE", "CHILDREN", "UNSELECT", "LIST-EXTENDED", "LIST-STATUS", "SORT=*", "QUOTA=*", "QUOTASET", "LITERAL-", "COMPRESS=*"];

function matches(name: string, token: string): boolean {
  const n = name.toUpperCase();
  return token.endsWith("=*") ? n.startsWith(token.slice(0, -1)) : n === token;
}

function has(caps: string[], tokens: string[]): string | undefined {
  return caps.find((c) => tokens.some((tk) => matches(c, tk)));
}

export interface Enable {
  ok: boolean;
  answer: string;
  at: number;
}

export interface FeatureRow {
  id: string;
  /** The names shown under the title: what the server listed, or what is looked for. */
  names: string;
  title: string;
  gives: string;
  server: ServerMark;
  /** A word under the server's mark: where it was switched on, what ENABLE answered. */
  serverNote?: string;
  depesha: UseMark;
  /** What the user loses without it; `important` ones are shown as a warning. */
  without?: string;
  important: boolean;
  group: Group;
}

/** The IMAP version the server speaks, for the section's first line. */
export function protocol(caps: string[]): string {
  return caps.some((c) => c.toUpperCase() === "IMAP4REV2") ? "IMAP4rev2" : "IMAP4rev1";
}

/** The table, in the order of FEATURES; rows the server lacks and nobody misses are left out. */
export function features(caps: string[], enable: Enable | null, pollSecs: number, time: (unix: number) => string): FeatureRow[] {
  const rev2 = caps.some((c) => c.toUpperCase() === "IMAP4REV2");
  const minutes = Math.max(1, Math.round(pollSecs / 60));
  const rows: FeatureRow[] = [];
  for (const f of FEATURES) {
    const listed = has(caps, f.tokens);
    const inBase = !listed && rev2 && !!f.rev2;
    if (!listed && !inBase && !f.missing) continue;
    // The condstore row stands for CONDSTORE alone in its names.
    const names = listed ?? f.tokens[0].replace("=*", "");
    let gives = t(`server.f.${f.id}.gives` as Key);
    if (f.id === "appendLimit") {
      const limit = Number(listed?.split("=")[1]);
      gives = limit > 0 ? t("server.f.appendLimit.givesSize", { size: gb(limit) }) : gives;
    }
    const row: FeatureRow = {
      id: f.id,
      names: f.id === "sortThread" ? caps.filter((c) => /^(SORT|THREAD=)/i.test(c)).join(", ") || "SORT, THREAD" : names,
      title: t(`server.f.${f.id}.title` as Key),
      gives,
      server: listed ? "yes" : inBase ? "base" : "no",
      depesha: "used",
      important: false,
      group: "used",
    };
    // Depesha reads the names in the list (Caps): a feature only in the base protocol is not used.
    const usable = !!listed || (f.id === "condstore" && !!has(caps, ["QRESYNC"]));
    if (usable && f.used) {
      row.depesha = "used";
      row.group = "used";
    } else if (usable) {
      row.depesha = f.notNeeded ? "notNeeded" : "notUsed";
      row.group = "unused";
    } else {
      row.depesha = f.missing ?? "notUsed";
      row.group = inBase ? "unused" : "missing";
      row.without = t(`server.f.${f.id}.without` as Key, { n: minutes, minutes: tn("server.minutes", minutes) });
      row.important = !!f.important;
    }
    if (f.id === "qresync" && listed && enable) {
      if (enable.ok) {
        row.server = "enabled";
        row.serverNote = t("server.inSyncSession");
      } else {
        row.server = "refused";
        row.serverNote = t("server.enableRefused", { time: time(enable.at) });
        row.depesha = "without";
        row.group = "refused";
        row.without = `${t("server.f.qresync.without")} ${t("server.refusedNote")}`;
      }
    }
    rows.push(row);
  }
  return rows;
}

/** The groups in their order, each with its rows; empty groups are left out. */
export function grouped(rows: FeatureRow[]): { group: Group; rows: FeatureRow[] }[] {
  const order: Group[] = ["missing", "refused", "used", "unused"];
  // A server that lacks something important shows that first; a modern one, what is used.
  const problems = rows.some((r) => r.important);
  const groups = problems ? order : (["used", "unused", "refused", "missing"] as Group[]);
  return groups.map((group) => ({ group, rows: rows.filter((r) => r.group === group) })).filter((g) => g.rows.length);
}

/** Names Depesha does not know: kept and shown, not counted as features. */
export function unknown(caps: string[]): string[] {
  const known = [...FEATURES.flatMap((f) => f.tokens), ...PROTOCOL];
  return caps.filter((c) => !known.some((k) => matches(c, k)));
}

/** The server slows Depesha down where the user sees it: no IDLE or no MOVE. */
export function needsAttention(caps: string[] | null | undefined): boolean {
  if (!caps?.length) return false;
  return !has(caps, ["IDLE"]) || !has(caps, ["MOVE"]);
}

/** The one-line verdict over the table. */
export function summary(rows: FeatureRow[], pollSecs: number): string {
  const minutes = Math.max(1, Math.round(pollSecs / 60));
  const parts: string[] = [];
  if (rows.some((r) => r.id === "idle" && r.important)) parts.push(t("server.summary.polling", { minutes: tn("server.minutes", minutes) }));
  if (rows.some((r) => r.id === "move" && r.important)) parts.push(t("server.summary.noMove"));
  if (parts.length) return t("server.summary.old", { what: parts.join(t("server.summary.and")) });
  if (rows.some((r) => r.group === "missing" && r.depesha !== "notUsed") || rows.some((r) => r.group === "refused")) return t("server.summary.mostly");
  return t("server.summary.modern");
}

/** The text block "Copy" puts on the clipboard: no passwords, tokens or letters in it. */
export function report(server: string, greeting: string, caps: string[], enable: Enable | null): string {
  const lines = [server];
  if (greeting) lines.push("", t("server.beforeLogin"), greeting);
  lines.push("", t("server.afterLogin"), `* CAPABILITY ${caps.join(" ")}`);
  if (enable) lines.push("", t("server.syncSession"), "C: ENABLE QRESYNC", enable.ok ? `S: * ${enable.answer}` : `S: NO ${enable.answer}`);
  const other = unknown(caps);
  if (other.length) lines.push("", t("server.unknown"), other.join(" "));
  return lines.join("\n");
}
