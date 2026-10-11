// The in-memory backend of the live mockup: `invoke(cmd, args)` answers the same commands the
// Rust backend does (`src-tauri/src/lib.rs`), from the demo data of `./data.ts`. The state is
// copied once and mutated by the actions (read, archive, delete, snooze, flag, labels), and
// the same events the real backend sends are emitted (`mail-changed`, `settings-changed`, …),
// so the interface reacts exactly as in the app.
//
// The commands of the main screens are implemented for real; the rest have an explicit,
// sensible empty answer in `STUBS`. A command in neither list is a mistake the guard
// (`scripts/demo-commands.mjs`) catches; at runtime it is warned about once and answered
// with `undefined`, never a crash.

import type {
  AccountView,
  AccountSync,
  Counters,
  Emptied,
  FlagChange,
  FolderCount,
  FolderInfo,
  FolderProps,
  Label,
  LabelCount,
  ListQuery,
  MessageRow,
  MessageView,
  Moved,
  OpenedMessage,
  OutboxItem,
  SearchTotals,
  ServerView,
  Settings,
  SortKey,
  Task,
  UpdateStatus,
} from "../lib/types";
import type { Added, Forgotten, Merge, Merged, Person, Snapshot, Suggestion } from "../lib/people";
import type { HintCount, HintState } from "../lib/hints";
import type { PickedFile } from "../lib/api";
import { ACCOUNTS, FOLDERS, LABELS, LETTERS, LOGO_HOME, LOGO_WORK, OUTBOX, PEOPLE, SETTINGS, TASKS, type DemoLetter } from "./data";
import { emit } from "./tauri/event";

type Args = Record<string, unknown>;
type Handler = (a: Args) => unknown;

/** The state of the mockup: a copy of the demo data, changed by the actions. */
const letters: DemoLetter[] = structuredClone(LETTERS);
const accounts: AccountView[] = structuredClone(ACCOUNTS);
const folders: FolderInfo[] = structuredClone(FOLDERS);
const labels: Label[] = structuredClone(LABELS);
const people: Person[] = structuredClone(PEOPLE);
const tasks: Task[] = structuredClone(TASKS);
const outbox: OutboxItem[] = structuredClone(OUTBOX);
const settings: Settings = structuredClone(SETTINGS);
let hintStates: HintState[] = [];
let hintCounters: HintCount[] = [];
let draftGeneration = 0;

const SNOOZED = "Отложенные";

// ---- helpers ---------------------------------------------------------------

function str(a: Args, key: string): string {
  return String(a[key] ?? "");
}

function num(a: Args, key: string): number {
  return Number(a[key] ?? 0);
}

function ids(a: Args): number[] {
  return Array.isArray(a.ids) ? (a.ids as number[]).map(Number) : [];
}

function byId(id: number): DemoLetter | undefined {
  return letters.find((l) => l.row.id === id);
}

function roleOf(accountId: string, folder: string): FolderInfo["role"] {
  return folders.find((f) => f.account_id === accountId && f.name === folder)?.role ?? null;
}

function rowFor(l: DemoLetter): MessageRow {
  return structuredClone(l.row);
}

/** Tells the windows a letter's folder changed, as the backend does. */
function mailChanged(accountId: string, folder: string) {
  void emit("mail-changed", { account_id: accountId, folder });
}

/** A letter counts for the query when it is in scope (account, folder, role, unread…). */
function inScope(l: DemoLetter, q: ListQuery): boolean {
  const r = l.row;
  if (q.account_id && r.account_id !== q.account_id) return false;
  if (q.folder && r.folder !== q.folder) return false;
  if (q.role && roleOf(r.account_id, r.folder) !== q.role) return false;
  if (q.snoozed_only && r.snoozed_until === null) return false;
  if (q.followups_only && r.followup?.status !== (q.followup_status ?? "waiting")) return false;
  if (q.unread_only && r.flags.seen) return false;
  if (q.flagged_only && !r.flags.flagged) return false;
  if (q.bulk === true && !r.bulk) return false;
  if (q.bulk === false && r.bulk) return false;
  return true;
}

/** The rows of a conversation, my answers in Sent included. */
function threadLetters(l: DemoLetter): DemoLetter[] {
  return letters.filter((x) => x.row.thread === l.row.thread && x.row.account_id === l.row.account_id);
}

function voiceOf(l: DemoLetter): MessageRow["thread_voices"][number] {
  return { from: l.row.from ?? { name: null, email: "" }, dmarc: l.row.dmarc, id: l.row.id };
}

/** One row per conversation: the newest letter in scope, the rest counted in `thread_*`. */
function grouped(l: DemoLetter): MessageRow {
  const all = threadLetters(l).sort((a, b) => a.row.date - b.row.date);
  const row = rowFor(l);
  const senders = all.map((x) => x.row.from).filter((a): a is NonNullable<typeof a> => !!a);
  row.thread_count = all.length;
  row.thread_date = Math.max(...all.map((x) => x.row.date));
  row.thread_size = all.reduce((n, x) => n + x.row.size, 0);
  row.thread_senders = senders;
  row.thread_voices = all.map(voiceOf);
  row.thread_draft = all.some((x) => x.row.flags.draft);
  return row;
}

function compare(a: MessageRow, b: MessageRow, sort: SortKey[]): number {
  for (const key of sort) {
    const sign = key.desc ? -1 : 1;
    const d = byField(a, b, key.by);
    if (d !== 0) return d * sign;
  }
  return b.date - a.date;
}

function byField(a: MessageRow, b: MessageRow, by: SortKey["by"]): number {
  if (by === "subject") return a.subject.localeCompare(b.subject, "ru");
  if (by === "sender") return (a.from?.name ?? a.from?.email ?? "").localeCompare(b.from?.name ?? b.from?.email ?? "", "ru");
  if (by === "size") return (a.thread_size ?? a.size) - (b.thread_size ?? b.size);
  if (by === "unread") return Number(a.flags.seen) - Number(b.flags.seen);
  if (by === "flagged") return Number(a.flags.flagged) - Number(b.flags.flagged);
  return a.date - b.date;
}

function sorted(rows: MessageRow[], sort: SortKey[]): MessageRow[] {
  return [...rows].sort((a, b) => compare(a, b, sort));
}

// ---- list and reader -------------------------------------------------------

function listMessages(a: Args): MessageRow[] {
  const q = (a.query ?? {}) as ListQuery;
  const scope = letters.filter((l) => inScope(l, q));
  const keep = new Set(q.keep_ids ?? []);
  const rows = q.threads
    ? [...new Map(scope.map((l) => [l.row.thread, l])).values()].map(grouped)
    : scope.map(rowFor);
  const withKept = q.keep_ids?.length ? [...rows, ...letters.filter((l) => keep.has(l.row.id) && !scope.includes(l)).map(rowFor)] : rows;
  const ordered = sorted(withKept, q.sort ?? []);
  const offset = q.offset ?? 0;
  const limit = q.limit ?? 200;
  return ordered.slice(offset, offset + limit);
}

function searchText(l: DemoLetter, text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  const hay = [l.row.subject, l.row.from?.name, l.row.from?.email, l.text, ...l.row.to.map((x) => x.email)].join(" ").toLowerCase();
  return hay.includes(t);
}

function listSearch(a: Args): MessageRow[] {
  const text = str(a, "text");
  const account = (a.accountId as string | null) ?? null;
  const found = letters.filter((l) => (!account || l.row.account_id === account) && searchText(l, text));
  return sorted(found.map(rowFor), (a.sort as SortKey[]) ?? []);
}

function searchTotals(a: Args): SearchTotals {
  const text = str(a, "text");
  const account = (a.accountId as string | null) ?? null;
  const found = letters.filter((l) => (!account || l.row.account_id === account) && searchText(l, text));
  return { count: found.length, size: found.reduce((n, l) => n + l.row.size, 0) };
}

function openMessage(a: Args): OpenedMessage {
  const l = byId(num(a, "id"));
  if (!l) throw { kind: "not-found", message: "нет такого письма" };
  const row = rowFor(l);
  const views: MessageView["views"] = l.html ? ["text", "html"] : ["text"];
  const view: MessageView = {
    summary: {
      message_id: row.message_id,
      in_reply_to: row.in_reply_to,
      references: row.references,
      subject: row.subject,
      from: row.from,
      to: row.to,
      cc: row.cc,
      reply_to: row.reply_to,
      date: row.date,
      has_attachments: row.has_attachments,
      bulk: row.bulk,
      unsubscribe: row.bulk ? { one_click: "https://example.net/unsubscribe", http: null, mailto: null } : null,
      thread_index: null,
      dmarc: row.dmarc,
      importance: row.importance,
    },
    text: l.text,
    html: l.html,
    has_remote_content: l.hasRemote,
    authenticated: row.dmarc,
    attachments: structuredClone(l.attachments),
    send_at: null,
    format: null,
    acts_on: null,
    markdown: null,
    views,
  };
  return { row, view, trusted_sender: false, sender_unverified: false };
}

// ---- actions that change the state -----------------------------------------

/** Moves the letters to a folder, one `Moved` per source folder. */
function moveTo(idsToMove: number[], to: string): Moved[] {
  const byFolder = new Map<string, DemoLetter[]>();
  for (const id of idsToMove) {
    const l = byId(id);
    if (!l) continue;
    const list = byFolder.get(l.row.folder) ?? [];
    list.push(l);
    byFolder.set(l.row.folder, list);
  }
  const moved: Moved[] = [];
  for (const [from, list] of byFolder) {
    const unseen = list.filter((l) => !l.row.flags.seen).map((l) => l.row.message_id ?? "");
    for (const l of list) {
      l.row.folder = to;
      l.row.flags.seen = true;
      l.row.snoozed_until = null;
    }
    moved.push({ account_id: list[0].row.account_id, from, to, message_ids: list.map((l) => l.row.message_id ?? ""), waits: [], unseen, snoozed: [] });
    mailChanged(list[0].row.account_id, from);
  }
  return moved;
}

function doFlag(a: Args): void {
  const change = a.change as FlagChange;
  for (const id of ids(a)) {
    const l = byId(id);
    if (!l) continue;
    l.row.flags[change.flag] = change.value;
    mailChanged(l.row.account_id, l.row.folder);
  }
}

function doLabel(a: Args): void {
  const name = str(a, "name");
  const value = a.value === true;
  const label = labels.find((x) => x.name === name);
  const keyword = label?.keyword ?? name;
  for (const id of ids(a)) {
    const l = byId(id);
    if (!l) continue;
    const set = new Set(l.row.keywords ?? []);
    if (value) set.add(keyword);
    else set.delete(keyword);
    l.row.keywords = [...set];
    mailChanged(l.row.account_id, l.row.folder);
  }
}

function undoMove(a: Args): void {
  const moved = (a.moved ?? []) as Moved[];
  for (const m of moved) {
    for (const mid of m.message_ids) {
      const l = letters.find((x) => x.row.message_id === mid);
      if (l) l.row.folder = m.from;
    }
    mailChanged(m.account_id, m.from);
  }
}

function doSnooze(a: Args): Moved[] {
  const until = num(a, "until");
  const moved = moveTo(ids(a), SNOOZED);
  for (const id of ids(a)) {
    const l = byId(id);
    if (l) l.row.snoozed_until = until;
  }
  return moved;
}

function doUnsnooze(a: Args): Moved[] {
  return moveTo(ids(a), "INBOX");
}

function counters(): Counters {
  return {
    snoozed: letters.filter((l) => l.row.snoozed_until !== null).length,
    followups: letters.filter((l) => l.row.followup?.status === "waiting").length,
    followups_closed: letters.filter((l) => l.row.followup?.status === "closed").length,
  };
}

// ---- folders, labels, people -----------------------------------------------

function folderProps(a: Args): FolderProps {
  const folder = str(a, "folder");
  const f = folders.find((x) => x.name === folder);
  const rights = {
    lookup: true,
    read: true,
    seen: true,
    write: true,
    insert: true,
    post: true,
    create_child: true,
    delete_folder: true,
    delete_messages: true,
    expunge: true,
    administer: false,
    other: false,
  };
  return {
    folder,
    display_name: f?.display_name ?? folder,
    owner: { kind: "mine" },
    rights,
    labels_on_server: true,
    permanent: ["\\Seen", "\\Flagged", "\\Answered"],
    label_check: "saves",
    refused: null,
    checked: Math.floor(Date.now() / 1000),
  };
}

function labelCounts(a: Args): LabelCount[] {
  const account = str(a, "accountId");
  return labels.map((l) => ({ keyword: l.keyword, count: letters.filter((x) => x.row.account_id === account && (x.row.keywords ?? []).includes(l.keyword)).length }));
}

function saveLabel(a: Args): Label {
  const account = str(a, "accountId");
  void account;
  const label: Label = { name: str(a, "name"), keyword: str(a, "name").toLowerCase().replace(/\s+/g, "-"), color: str(a, "color"), stripping: false };
  const existing = labels.findIndex((x) => x.name === label.name);
  if (existing >= 0) labels[existing] = label;
  else labels.push(label);
  return label;
}

function addresses(a: Args): Suggestion[] {
  const prefix = str(a, "prefix").trim().toLowerCase();
  if (!prefix) return [];
  return people
    .filter((p) => p.name.toLowerCase().includes(prefix) || p.email.toLowerCase().includes(prefix))
    .slice(0, 6)
    .map((p) => ({ email: p.email, name: p.name || null, emails: p.emails.map((e) => e.email) }));
}

function listPeople(a: Args): Person[] {
  const query = str(a, "query").trim().toLowerCase();
  if (!query) return structuredClone(people);
  return structuredClone(people.filter((p) => [p.name, p.email, p.note, ...p.emails.map((e) => e.email)].join(" ").toLowerCase().includes(query)));
}

function savePerson(a: Args): Person {
  const person = structuredClone(a.person as Person);
  const i = people.findIndex((p) => p.email === person.email);
  if (i >= 0) people[i] = person;
  else people.push(person);
  void emit("people-changed", {});
  return person;
}

function mergePeople(a: Args): Merged {
  const merge = a.merge as Merge;
  const primary = merge.primary;
  const found = people.filter((p) => merge.emails.includes(p.email));
  const emails = found.flatMap((p) => p.emails);
  const merged: Person = {
    id: found[0]?.id ?? 0,
    email: primary,
    emails: emails.map((e) => ({ ...e, primary: e.email === primary })),
    name: merge.name,
    send_format: merge.send_format,
    view: merge.view,
    note: found[0]?.note ?? "",
    hidden: merge.hidden,
    manual: true,
    via: "",
    uses: emails.reduce((n, e) => n + e.uses, 0),
    heard: true,
  };
  for (const p of found) people.splice(people.indexOf(p), 1);
  people.push(merged);
  void emit("people-changed", {});
  return { person: merged, undo: { kind: "merge" } as Snapshot };
}

function personForget(a: Args): Forgotten {
  const email = str(a, "email");
  const i = people.findIndex((p) => p.emails.some((e) => e.email === email));
  if (i >= 0) people.splice(i, 1);
  void emit("people-changed", {});
  return { removed: true, unmarked: false, undo: { kind: "forget", email } as Snapshot };
}

function updateStatus(): UpdateStatus {
  return { current: "0.8.3-demo", state: "idle", version: null, notes: null, error: null, install: "unsupported" };
}

function syncOverview(): AccountSync[] {
  return accounts.map((a) => ({ account_id: a.id, last_sync: Math.floor(Date.now() / 1000), offline_done: 30, offline_total: 30, paused: false }));
}

function serverView(a: Args): ServerView {
  return {
    cache_bytes: 48_000_000,
    poll_secs: 300,
    counting: null,
    namespaces: { personal: [{ prefix: "", delimiter: "/" }], other_users: [], shared: [] },
    folders: folders.filter((f) => f.account_id === str(a, "accountId")).map((f) => folderProps({ folder: f.name })),
    caps: { greeting: "IMAP4rev1", capabilities: ["IMAP4rev1", "IDLE", "MOVE"], detected: Math.floor(Date.now() / 1000) },
    enable: null,
    quota: { checked: Math.floor(Date.now() / 1000), root: "User quota", used: 48_000_000, limit: 1_000_000_000, messages: [240, 100_000] },
    sizes: null,
  };
}

// ---- files and attachments -------------------------------------------------

/** A small PNG, for the attachment viewer of a picture. */
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAP0lEQVR42u3RMQ0AMAgAsA0Z0PBPiCPh0V0JAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwzQMtIAGB0Nx1AAAAAElFTkSuQmCC";

function bytesOf(base64: string): ArrayBuffer {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function attachmentBytes(a: Args): ArrayBuffer {
  const l = byId(num(a, "id"));
  const index = num(a, "index");
  const info = l?.attachments.find((x) => x.index === index);
  if (info?.mime.startsWith("image/")) return bytesOf(PNG_1PX);
  return new TextEncoder().encode(`${info?.name ?? "file"}\n`).buffer;
}

function pickedFile(a: Args): PickedFile {
  const path = str(a, "path");
  const name = path.split("/").pop() ?? path;
  return { path, name, size: 1024 };
}

function pickFiles(a: Args): PickedFile[] {
  const name = a.images === true ? "Фотография.png" : "Документ.pdf";
  return [{ path: `/home/anna/${name}`, name, size: 42_000 }];
}

function toHtml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<p>${escaped.split(/\n{2,}/).map((p) => p.replace(/\n/g, "<br>")).join("</p><p>")}</p>`;
}

// ---- the table of implemented commands -------------------------------------

const HANDLERS: Record<string, Handler> = {
  accounts: () => accounts,
  folders: (a) => folders.filter((f) => !a.accountId || f.account_id === a.accountId),
  messages: listMessages,
  search: listSearch,
  search_totals: searchTotals,
  server_search: () => [],
  message_open: openMessage,
  thread: (a) => {
    const l = byId(num(a, "id"));
    return l ? threadLetters(l).map(rowFor) : [];
  },
  messages_by_id: (a) => letters.filter((l) => ids(a).includes(l.row.id)).map(rowFor),
  set_flag: doFlag,
  set_label: doLabel,
  labels: () => labels,
  label_counts: labelCounts,
  label_save: saveLabel,
  label_remove: (a) => void labels.splice(labels.findIndex((x) => x.name === str(a, "name")), 1),
  label_strip: (a) => void labels.splice(labels.findIndex((x) => x.name === str(a, "name")), 1),
  label_rename: (a) => {
    const l = labels.find((x) => x.name === str(a, "from"));
    if (l) l.name = str(a, "to");
    return l ?? labels[0];
  },
  folder_props: folderProps,
  label_check: () => "saves",
  move_messages: (a) => moveTo(ids(a), str(a, "to")),
  delete_messages: (a) => moveTo(ids(a), "Trash"),
  archive: (a) => moveTo(ids(a), "Archive"),
  mark_spam: (a) => moveTo(ids(a), "Junk"),
  snooze: doSnooze,
  unsnooze: doUnsnooze,
  undo: (a) => undoMove(a),
  counters: () => counters(),
  settings_get: () => settings,
  settings_set: (a) => {
    Object.assign(settings, a.settings ?? {});
    void emit("settings-changed", {});
  },
  settings_patch: (a) => {
    Object.assign(settings, a.patch ?? {});
    void emit("settings-changed", {});
  },
  plugin_settings_set: (a) => {
    settings.plugin_settings = { ...settings.plugin_settings, [str(a, "plugin")]: (a.values ?? {}) as Record<string, unknown> };
    void emit("settings-changed", {});
  },
  language: () => "ru",
  extensions: () => [],
  extension_storage_get: () => null,
  extension_storage_set: () => undefined,
  update_status: updateStatus,
  update_check: updateStatus,
  update_install: () => ({ ...updateStatus(), state: "installed" }),
  update_restart: () => undefined,
  load_older: () => 0,
  sync_now: () => undefined,
  server_info: serverView,
  server_check: serverView,
  quotas: () => accounts.map((a) => ({ account_id: a.id, quota: null, estimate: null })),
  quota_refresh: () => undefined,
  folder_sizes_count: () => undefined,
  folder_sizes_stop: () => undefined,
  notify_full: () => undefined,
  sync_overview: syncOverview,
  folder_create: () => undefined,
  offline_pause: () => undefined,
  tasks_list: () => tasks,
  task_dismiss: (a) => void tasks.splice(tasks.findIndex((x) => x.key === str(a, "key")), 1),
  task_stop: () => undefined,
  folder_total: (a): FolderCount => ({ total: letters.filter((l) => l.row.folder === str(a, "folder")).length, bound: 0 }),
  folder_empty: (a): Emptied => {
    const folder = str(a, "folder");
    for (const l of letters.filter((x) => x.row.folder === folder)) l.row.flags.deleted = true;
    return { total: 0, done: 0, stopped: false };
  },
  stuck_copies: () => [],
  sent_copy_retry: () => false,
  sent_copy_save: () => undefined,
  sent_copy_drop: () => undefined,
  trust_sender: () => undefined,
  avatar: (a) => logoFor(str(a, "email"), a.messageId !== null && a.messageId !== undefined),
  accounts_arrange: () => undefined,
  account_look: () => undefined,
  account_patch_own: (a) => {
    const acc = accounts.find((x) => x.id === str(a, "id"));
    if (acc) Object.assign(acc, a.patch ?? {});
    return acc;
  },
  addresses,
  people: listPeople,
  person_save: savePerson,
  person_add_address: (a): Added => ({ person: people[0] ?? null, owner: null, email: str(a, "email") } as unknown as Added),
  person_set_primary: () => people[0] ?? null,
  person_merge: mergePeople,
  person_split: () => null,
  person_restore: () => undefined,
  person_forget: personForget,
  hints: () => hintStates,
  hint_save: (a) => {
    hintStates = [...hintStates.filter((h) => !(h.id === (a.hint as HintState).id && h.subject === (a.hint as HintState).subject)), a.hint as HintState];
  },
  hints_clear: () => void (hintStates = []),
  hint_counts: () => hintCounters,
  count_hint: (a) => {
    const row = hintCounters.find((c) => c.id === str(a, "id") && c.subject === str(a, "subject"));
    if (row) return (row.n += 1);
    hintCounters.push({ id: str(a, "id"), subject: str(a, "subject"), n: 1, at: num(a, "now") });
    return 1;
  },
  clear_hint_count: (a) => void (hintCounters = hintCounters.filter((c) => !(c.id === str(a, "id") && c.subject === str(a, "subject")))),
  attachment_save: () => undefined,
  attachments_save_all: () => 1,
  attachment_save_in: () => "/home/anna/Загрузки/файл",
  attachment_open: () => undefined,
  attachment_bytes: attachmentBytes,
  message_window: (a) => {
    location.assign(`?message=${num(a, "id")}`);
  },
  letter_view: (a) => openMessage({ id: (a.bytes as unknown as { id?: number })?.id ?? firstLetterId() }),
  document_html: (a) => toHtml(str(a, "text")),
  markdown_html: (a) => toHtml(str(a, "text")),
  open_link: (a) => void globalThis.open?.(str(a, "url"), "_blank", "noopener"),
  send: (a) => {
    outbox.splice(0, outbox.length);
    void emit("outbox-changed", {});
    void emit("sent", { subject: (a.draft as { subject?: string })?.subject ?? "" });
    return { id: Date.now(), at: num(a, "at") };
  },
  draft_save: () => ({ id: Date.now(), message_id: null }),
  draft_open: () => undefined,
  draft_open_reset: () => ++draftGeneration,
  open_drafts: () => 0,
  draft_discard: () => undefined,
  outbox: () => outbox,
  outbox_retry: () => undefined,
  outbox_cancel: () => null,
  outbox_discard: () => undefined,
  outbox_missed: () => [],
  temp_attachment: (a) => `/tmp/${str(a, "name")}`,
  file_info: pickedFile,
  inline_image: () => LOGO_WORK,
  pick_files: pickFiles,
  pick_folder: () => null,
  pick_save_file: (a) => str(a, "name"),
  background_status: () => ({ tray: "absent" }),
  deep_link_take: () => null,
  window_hide: () => undefined,
  app_quit: () => undefined,
  compose_unsaved: () => undefined,
  quit_cancel: () => undefined,
  print_sheet: () => globalThis.print?.(),
  drop_seen: () => undefined,
  drop_outcome: () => undefined,
  draft_cache_put: () => undefined,
  draft_cache_list: () => [],
  draft_cache_drop: () => undefined,
  followup_unpark: () => undefined,
  followup_cancel: () => undefined,
  followup_resume: () => undefined,
  followup_postpone: () => undefined,
  followup_return: () => undefined,
  unsubscribe: () => ({ kind: "done" }),
  unsubscribe_plan: () => ({ way: { kind: "one-click", host: "example.net" }, from: "anna@example.org", foreign: false }),
};

function firstLetterId(): number {
  return letters[0]?.row.id ?? 0;
}

/** A logo for a sender the receiving server vouched for, or none (initials then). */
function logoFor(email: string, dmarc: boolean): string | null {
  if (!dmarc) return null;
  if (email === "billing@example.org" || email === "news@example.net") return LOGO_WORK;
  if (email === "book@example.net") return LOGO_HOME;
  return null;
}

// ---- stubs: every other command, with a sensible empty answer --------------

const NOOP = () => undefined;

/** Commands with no real behaviour in the mockup: an explicit, harmless answer each. */
export const STUBS: Record<string, Handler> = {
  detect: () => ({ imap: null, smtp: null, username: "", source: "", notes: [] }),
  account_check: NOOP,
  account_save: NOOP,
  account_remove: NOOP,
  oauth_providers: () => [],
  oauth_sign_in: NOOP,
  oauth_cancel: NOOP,
  exchange_detect: () => ({ url: null, source: "", notes: [] }),
  extension_inspect: NOOP,
  extension_install: NOOP,
  extension_approve: NOOP,
  extension_remove: NOOP,
  e2e_drop: NOOP,
  e2e_seed_message: NOOP,
};

// ---- dispatch --------------------------------------------------------------

const warned = new Set<string>();

/** The commands the mockup implements for real; the guard compares it with `generate_handler!`. */
export const IMPLEMENTED: string[] = Object.keys(HANDLERS);

/** Answers a command; an unknown one is warned about once and answered `undefined`. */
function dispatch(cmd: string, a: Args): unknown {
  const handler = HANDLERS[cmd] ?? STUBS[cmd];
  if (handler) return handler(a);
  if (!warned.has(cmd)) {
    warned.add(cmd);
    console.warn(`demo backend: «${cmd}» не реализована и не заглушена — пустой ответ`);
  }
  return undefined;
}

export const backend = {
  async invoke(cmd: string, args?: unknown): Promise<unknown> {
    return dispatch(cmd, (args ?? {}) as Args);
  },
};
