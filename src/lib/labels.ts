// Права на папки, общие папки и метки писем (#42): права — действиями, а не буквами
// ACL; общие и чужие папки — группой по владельцу из NAMESPACE; метки — ключ на
// сервере, название и цвет в Депеше. Чистые функции, покрыты labels.test.ts.

import type { FolderAction, FolderInfo, Label, NamespaceFolder, NamespaceInfo, Owner, Rights } from "./types";

/** Короткий устойчивый хеш точного имени (FNV-1a, младшие 32 бита), как в Rust
 *  `acl::short_hash`. */
function shortHash(name: string): string {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(name);
  for (const b of bytes) {
    hash ^= BigInt(b);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return (hash & 0xffffffffn).toString(16).padStart(8, "0");
}

/** Ключ метки на сервере (тот же расчёт, что в Rust `acl::keyword_of`). Имя, уже
 *  записанное канонически, даёт слаг `depesha-…`; любое другое — слаг с коротким хешем
 *  точного имени, чтобы имена, схлопывающиеся в один слаг, не делили один ключ. */
export function keywordForName(name: string): string {
  if (/^[A-Za-z0-9 _-]*$/.test(name)) {
    const out = name
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((w) => w.toLowerCase())
      .join("-");
    if (out && /^[a-z]/.test(out)) {
      if (name === out) return `depesha-${out}`;
      return `depesha-${out}-${shortHash(name)}`;
    }
  }
  return `depesha-${shortHash(name)}`;
}

/** Права в действия: раскладка кнопок и карточки одна и та же, меняются лишь исходы.
 *  Порядок задан здесь и совпадает с макетом (кадр 4). */
const ACTION_ORDER: { action: FolderAction; allows: (r: Rights) => boolean }[] = [
  { action: "read", allows: (r) => r.read },
  { action: "mark_seen", allows: (r) => r.seen },
  { action: "write", allows: (r) => r.write },
  { action: "insert", allows: (r) => r.insert },
  { action: "delete", allows: (r) => r.delete_messages && r.expunge },
  { action: "create_child", allows: (r) => r.create_child },
  { action: "delete_folder", allows: (r) => r.delete_folder },
  { action: "administer", allows: (r) => r.administer },
];

/** Действия папки по её правам. */
export function actionsOf(rights: Rights): { action: FolderAction; allowed: boolean }[] {
  return ACTION_ORDER.map(({ action, allows }) => ({ action, allowed: allows(rights) }));
}

/** Папка читается, но менять общее в ней нельзя: отметка «Только чтение» в шапке
 *  списка. Право `s` (отметка прочитанным для себя) не считается записью — в общей
 *  папке оно хранится отдельно для каждого пользователя. */
export function readOnly(rights: Rights): boolean {
  return (
    rights.read &&
    !rights.other &&
    !(
      rights.write ||
      rights.insert ||
      rights.delete_messages ||
      rights.expunge ||
      rights.create_child ||
      rights.delete_folder ||
      rights.administer
    )
  );
}

/** Папка в списке «Папки» подраздела «Сервер» (кадр 2). */
export interface FolderGrouping {
  mine: FolderInfo[];
  shared: FolderInfo[];
  others: { owner: string; folders: FolderInfo[] }[];
}

function under(name: string, ns: NamespaceFolder): boolean {
  return ns.prefix !== "" && name.startsWith(ns.prefix);
}

/** The namespace root itself: `shared/` names the root `shared`, `Other Users/` names
 *  `Other Users`. It exists only to hold the folders that go into a group, so it is not
 *  a folder of the mailbox's own tree (#42, кадр 6Б). */
function rootOf(name: string, ns: NamespaceFolder): boolean {
  if (ns.prefix === "") return false;
  const root = ns.prefix.endsWith(ns.delimiter) ? ns.prefix.slice(0, -ns.delimiter.length) : ns.prefix;
  return name === root;
}

/** Namespace roots — `shared`, `Other Users` and another person's own `Other Users/maria`
 *  — are containers of the grouped folders, not folders of the mailbox. They must not
 *  stay in the account's own tree; only what went into a group is shown (#42, кадр 6Б). */
function namespaceRoot(name: string, ns: NamespaceInfo): boolean {
  for (const n of ns.shared) if (rootOf(name, n)) return true;
  for (const n of ns.other_users) {
    if (rootOf(name, n)) return true;
    // `Other Users/maria` names the owner: the segment after the prefix, nothing deeper.
    if (under(name, n) && !name.slice(n.prefix.length).includes(n.delimiter)) return true;
  }
  return false;
}

function ownerOf(name: string, ns: NamespaceInfo): Owner | null {
  for (const n of ns.shared) if (under(name, n)) return { kind: "shared" };
  for (const n of ns.other_users) {
    if (!under(name, n)) continue;
    const rest = name.slice(n.prefix.length);
    const owner = rest.split(n.delimiter)[0];
    if (owner) return { kind: "other", name: owner };
  }
  return null;
}

/** Свои, общие и чужие папки — по NAMESPACE. Без него всё остаётся в общем списке. */
export function groupFolders(folders: FolderInfo[], ns: NamespaceInfo | null): FolderGrouping {
  const out: FolderGrouping = { mine: [], shared: [], others: [] };
  const byOwner = new Map<string, FolderInfo[]>();
  for (const f of folders) {
    if (ns && namespaceRoot(f.name, ns)) continue;
    const owner = ns ? ownerOf(f.name, ns) : null;
    if (!owner || owner.kind === "mine") out.mine.push(f);
    else if (owner.kind === "shared") out.shared.push(f);
    else {
      const list = byOwner.get(owner.name) ?? [];
      list.push(f);
      byOwner.set(owner.name, list);
    }
  }
  out.others = [...byOwner.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, folders]) => ({ owner, folders }));
  return out;
}

/** Ярлык метки в строке письма (кадр 10, вариант А). */
export interface LabelChip {
  name: string;
  color: string;
  /** Метка хранится только на этом устройстве: пунктирная рамка. */
  local: boolean;
}

/** Ярлыки письма по его ключам: незнакомые ключи (например `$Forwarded`) пропускаются.
 *  `local` помечает все метки письма, когда в папке нет серверного хранения. */
export function labelChips(keywords: string[], labels: Label[], local: boolean): LabelChip[] {
  const seen = new Set<string>();
  const out: LabelChip[] = [];
  for (const l of labels) {
    if (keywords.includes(l.keyword) && !seen.has(l.name)) {
      seen.add(l.name);
      out.push({ name: l.name, color: l.color, local });
    }
  }
  return out;
}

/** Названия меток письма без цвета — для подсказки и заголовка. */
export function labelNames(keywords: string[], labels: Label[]): string[] {
  const found = labels.filter((l) => keywords.includes(l.keyword)).map((l) => l.name);
  return [...new Set(found)].sort();
}

/** Что случилось с действием, которое оптимистично убрало письмо, а сервер отказал (#42, кадр 8). */
export type Refusal = "no-rights" | "error" | "no-answer";

/** Какое из трёх уведомлений показать по ответу сервера: нет прав, ошибка, нет ответа.
 *  Три разных вида, потому что и делать с ними надо разное (#11). */
export function refusalOf(kind: string): Refusal | null {
  if (kind === "no-rights") return "no-rights";
  if (kind === "network") return "no-answer";
  // Всё остальное — сервер ответил, но не так: не права и не обрыв.
  if (["other", "imap-unavailable", "not-found", "folder-changed", "too-large"].includes(kind)) return "error";
  return null;
}

/** Итог проверки меток на тестовом письме (кадр 9): сохраняет, не сохраняет или обещал и потерял. */
export type LabelCheck = "saves" | "not-saves" | "claimed-but-lost";

/** Строка «где хранятся» у выбора меток: по итогу проверки папки. `null` — не проверяли. */
export function storageOf(check: LabelCheck | null | undefined): "server" | "local" | "unconfirmed" {
  if (check === "saves") return "server";
  if (check === "not-saves") return "local";
  return "unconfirmed";
}
