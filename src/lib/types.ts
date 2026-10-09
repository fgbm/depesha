// Mirrors of the Rust types that cross the IPC boundary (snake_case as serialized).

export type Security = "tls" | "starttls" | "plain";

export interface ServerConfig {
  host: string;
  port: number;
  security: Security;
  trusted_cert?: string;
}

export type OAuthProvider = "google" | "yandex" | "microsoft";

/** How the account logs in; absent means a password. */
export type AuthMethod = { kind: "password" } | { kind: "oauth"; provider: OAuthProvider };

/** Exchange Web Services instead of IMAP and SMTP. */
export interface EwsConfig {
  url: string;
  trusted_cert?: string;
}

export interface Account {
  id: string;
  /** What the user calls the mailbox in the app; empty shows the address. */
  label?: string;
  /** `#rrggbb`; empty takes one from the palette by the mailbox's place. */
  color?: string;
  display_name: string;
  email: string;
  username: string;
  imap: ServerConfig;
  smtp: ServerConfig;
  save_sent_copy: boolean;
  /** The mailbox's signatures in the user's order; absent is none. */
  signatures?: Signature[];
  /** The id of the signature new letters get; absent puts none. */
  default_signature?: string | null;
  /** The id of the signature replies and forwards get; absent takes `default_signature`. */
  reply_signature?: string | null;
  /** How new letters from this mailbox are written; absent takes the settings' format. */
  compose_format?: BodyFormat | null;
  /** How this mailbox's letters are shown; absent takes the form from the settings. */
  letter_view?: ViewRule | null;
  /** Where this mailbox's attachments are saved without asking; empty takes the settings' folder. */
  attachments_dir?: string;
  auth?: AuthMethod;
  ews?: EwsConfig;
  /** Warn when the mailbox fills up; on unless set off. */
  quota_warn?: boolean;
  /** The mailbox's own limit for the warnings, in MB; 0 or none takes the server's quota. */
  quota_limit_mb?: number;
  /** The inbox as a queue: absent is off. */
  waiting?: Waiting;
}

/** What an answer does with a letter of the inbox (#59). */
export interface Waiting {
  /** An answer takes the letter, with its conversation, to the folder until the reply comes. */
  park: boolean;
  /** The folder as the cache names it; empty: "Waiting for reply", made at the first answer. */
  folder: string;
  /** "Stop waiting" takes the letters to the archive instead of back to the inbox. */
  stop_to_archive: boolean;
}

/** A signature of a mailbox: under the letter in a block of its own, put in whole. */
export interface Signature {
  id: string;
  name: string;
  /** As in an HTML letter; its pictures are inside as `data:` images. */
  html: string;
  /** What a letter in plain text or Markdown gets under "-- "; made from `html`. */
  text: string;
}

export interface OAuthProviderView {
  provider: OAuthProvider;
  title: string;
  configured: boolean;
}

/** A finished browser sign-in, passed by id to account_check and account_save. */
export interface OAuthGrant {
  id: string;
  provider: OAuthProvider;
  email: string;
  name: string | null;
  imap: ServerConfig;
  smtp: ServerConfig;
}

export interface OAuthClient {
  client_id: string;
  client_secret?: string;
}

export interface EwsDetection {
  url: string | null;
  source: string;
  notes: string[];
}

export interface CertProblem {
  host: string;
  reason: string;
  sha256: string;
  subject: string;
  issuer: string;
  not_after: number | null;
}

export interface CmdError {
  kind: string;
  message: string;
  cert?: CertProblem;
}

export interface AccountStatus {
  state: "connecting" | "online" | "error" | "paused";
  error?: CmdError;
}

export interface AccountView extends Account {
  status: AccountStatus | null;
}

export interface Detection {
  imap: ServerConfig | null;
  smtp: ServerConfig | null;
  username: string;
  source: string;
  notes: string[];
}

export type FolderRole = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "snoozed";

export interface FolderInfo {
  account_id: string;
  name: string;
  display_name: string;
  delimiter: string | null;
  role: FolderRole | null;
  selectable: boolean;
  hidden: boolean;
  total: number;
  unread: number;
}

/** Who a folder belongs to, from NAMESPACE (mirrors Rust's `acl::Owner`). */
export type Owner = { kind: "mine" } | { kind: "shared" } | { kind: "other"; name: string };

/** An RFC 4314 right set; the flags mirror Rust's `acl::Rights`. */
export interface Rights {
  lookup: boolean;
  read: boolean;
  seen: boolean;
  write: boolean;
  insert: boolean;
  post: boolean;
  create_child: boolean;
  delete_folder: boolean;
  delete_messages: boolean;
  expunge: boolean;
  administer: boolean;
  other: boolean;
}

/** One action the folder card shows, with its rights outcome. */
export interface ActionRight {
  action: FolderAction;
  allowed: boolean;
  /** The action is unknown until the folder is checked: shown neither on nor off. */
  unknown: boolean;
}

export type FolderAction = "read" | "mark_seen" | "write" | "insert" | "delete" | "create_child" | "delete_folder" | "administer";

/** One namespace prefix and its delimiter (mirrors Rust's `acl::NamespaceFolder`). */
export interface NamespaceFolder {
  prefix: string;
  delimiter: string;
}

/** The three NAMESPACE groups; empty arrays mean the server named none. */
export interface NamespaceInfo {
  personal: NamespaceFolder[];
  other_users: NamespaceFolder[];
  shared: NamespaceFolder[];
}

/** What the cache knows about one folder: rights, labels, owner, the last refusal. */
export interface FolderProps {
  folder: string;
  display_name: string;
  owner: Owner;
  rights?: Rights | null;
  /** Whether own labels can be stored on the server; absent is unknown. */
  labels_on_server?: boolean | null;
  /** The PERMANENTFLAGS the server listed, for the details. */
  permanent?: string[];
  /** The outcome of a label check on a test message (#42, frame 9); absent is never checked. */
  label_check?: LabelCheck | null;
  /** The remembered refusal (`no-rights`), if any. */
  refused?: string | null;
  /** When the props were read, Unix time; 0 is never. */
  checked: number;
}

/** A label the user made: its name, the server keyword and its colour. */
export interface Label {
  name: string;
  keyword: string;
  color: string;
  /** Being taken off every letter of the mailbox (#42, frame 4Б): shown as «удаляется…». */
  stripping?: boolean;
}

/** How many cached letters carry a label, by its keyword (#42, frame 2). */
export interface LabelCount {
  keyword: string;
  count: number;
}

/** The outcome of a label check on a test message (#42, frame 9). */
export type LabelCheck = "saves" | "not-saves" | "claimed-but-lost";

export interface Addr {
  name: string | null;
  email: string;
}

export interface Flags {
  seen: boolean;
  answered: boolean;
  flagged: boolean;
  draft: boolean;
  deleted: boolean;
  /** Forwarded, by the server's word (`$Forwarded`, Exchange's last verb). */
  forwarded?: boolean;
  /** Answered to all: only Exchange tells it. */
  answered_all?: boolean;
}

/** What a letter does with the one it was written from. */
export type Act = "reply" | "reply_all" | "forward";

/** One thing done with a letter: when Depesha did it, or `null` when only the server says so. */
export interface Mark {
  act: Act;
  at: number | null;
}

/** An answer or forward of the letter waiting in the outbox. */
export interface Outgoing {
  act: Act;
  /** When it leaves. */
  at: number;
  /** It takes the letter to wait for a reply. */
  park: boolean;
  /** Sent later at a chosen time: nothing is done yet. */
  scheduled: boolean;
}

/** The letter an answer or a forward is written from. */
export interface ActsOn {
  account_id: string;
  message_id: string;
  /** Where it was when the answer was written. */
  folder: string;
  act: Act;
  /** It waits for a reply in the folder already. */
  waiting: boolean;
}

export interface MessageRow {
  id: number;
  account_id: string;
  folder: string;
  uid: number;
  message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  subject: string;
  from: Addr | null;
  to: Addr[];
  cc: Addr[];
  reply_to: Addr[];
  date: number;
  size: number;
  flags: Flags;
  /** The message's own keywords (labels) on the server, by their keyword names. */
  keywords?: string[];
  has_attachments: boolean;
  thread: string;
  bulk: boolean;
  /** Letters of the conversation, my answers in Sent included; 1 when the list is not grouped. */
  thread_count: number;
  /** The newest letter of the conversation, mine included; the row's own date otherwise. */
  thread_date: number;
  /** Who wrote in the conversation, in order of first appearance; empty when not grouped. */
  thread_senders: Addr[];
  /** The conversation has a saved draft of an answer. */
  thread_draft: boolean;
  /** Bytes of the conversation's letters in the list; the row's own size when not grouped. */
  thread_size?: number;
  snoozed_until: number | null;
  /** The next reminder while the sender waits for an answer to this letter. */
  followup_due: number | null;
  /** The wait for an answer to this letter, also when it is over. */
  followup?: FollowupInfo | null;
  /** What was done with the letter: answered, answered to all, forwarded. */
  marks?: Mark[];
  /** My latest answer to it, when it is in the cache. */
  my_answer?: number | null;
  /** An answer or forward of it waiting in the outbox. */
  outgoing?: Outgoing | null;
  /** Back from waiting with the reply and not opened since (for a conversation: any letter of it). */
  answer_came?: boolean;
  /** The receiving server vouched for the sender with DMARC: a company logo may stand by them (#108). */
  dmarc?: boolean;
  /** Who wrote in the conversation with that verdict on each, the newest last; empty when not grouped. */
  thread_voices?: Voice[];
}

/** A writer of a conversation and whether the receiving server vouched for them (#108). */
export interface Voice {
  from: Addr;
  dmarc: boolean;
}

/** Overdue is a waiting one past its deadline. */
export type FollowupStatus = "waiting" | "answered" | "closed";

export interface FollowupInfo {
  status: FollowupStatus;
  /** The next reminder. */
  due: number;
  /** When the answer is expected by. */
  deadline: number;
  /** The deadline was given apart from the reminder ("a day before the deadline"). */
  own_deadline: boolean;
  /** Reminded again this often until an answer comes; 0: once. */
  repeat_secs: number;
  /** Only an answer from this address counts; empty: from anyone. */
  expect: string;
  /** The name of the reminder choice. */
  kind: string;
  /** When it ended: the date of the answer, or when it was closed by hand. */
  ended: number | null;
  answered_by: Addr | null;
  /** The answer in the cache, when it is there. */
  answer: number | null;
  /** When the reminders came, oldest first. */
  reminded: number[];
  /** When the letter waited for went. */
  sent: number;
  /** Where the letters answered are: "" none moved, "pending" still in the inbox, "parked" in the folder, "back"/"undo" on their way back, "returned" back with the reply, "done". */
  park: string;
  park_folder: string;
  /** The latest auto-reply or newsletter that answered and did not count. */
  auto_reply: number | null;
}

/** What a wait asks besides its first reminder; sent with the letter. */
export interface FollowupPlan {
  /** The answer is expected by this long after sending; 0: by the first reminder. */
  deadline_secs: number;
  /** The first reminder at this time (unix seconds), not counted from sending; 0: `secs` after sending. */
  due_at?: number;
  /** The answer is expected by this time (unix seconds), not counted from sending; 0: none. */
  deadline_at?: number;
  repeat_secs: number;
  expect: string;
  kind: string;
  /** An answer takes its letter to wait in the folder; absent: as the mailbox says. */
  park?: boolean | null;
  /** An answer takes its letter to the archive, with no wait (#106); absent: as the mailbox says. */
  archive?: boolean | null;
}

export interface Unsubscribe {
  one_click: string | null;
  http: string | null;
  mailto: string | null;
}

export interface Summary {
  message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  subject: string;
  from: Addr | null;
  to: Addr[];
  cc: Addr[];
  reply_to: Addr[];
  date: number | null;
  has_attachments: boolean;
  bulk: boolean;
  unsubscribe: Unsubscribe | null;
}

export interface AttachmentInfo {
  index: number;
  name: string;
  mime: string;
  size: number;
  content_id: string | null;
  inline: boolean;
}

export interface MessageView {
  summary: Summary;
  text: string | null;
  html: string | null;
  has_remote_content: boolean;
  /** The receiving server says it passed DMARC for its From domain: a brand logo may show. */
  authenticated: boolean;
  attachments: AttachmentInfo[];
  /** A draft's scheduled sending time, unix seconds. */
  send_at?: number | null;
  /** How a draft of Depesha's was being written; absent for other letters. */
  format?: BodyFormat | null;
  /** The letter a saved draft answers or forwards; absent for other letters. */
  acts_on?: ActsOn | null;
  /** The letter's `text/markdown` part drawn as HTML, cleaned like `html`. */
  markdown?: string | null;
  /** The forms the letter came in, in its order: the sender's favourite last. */
  views?: BodyView[];
}

export interface OpenedMessage {
  row: MessageRow;
  view: MessageView;
  /** Remote pictures load: the sender is trusted and the receiving server vouches for From. */
  trusted_sender: boolean;
  /** The sender is trusted, but this letter's From is not confirmed: pictures stay hidden. */
  sender_unverified?: boolean;
}

export interface ListQuery {
  account_id?: string | null;
  folder?: string | null;
  role?: FolderRole | null;
  unread_only?: boolean;
  flagged_only?: boolean;
  /** Read or unflagged while the list is open: they stay in it. */
  keep_ids?: number[];
  bulk?: boolean | null;
  threads?: boolean;
  snoozed_only?: boolean;
  followups_only?: boolean;
  /** Which of them: still waiting (the default), or answered and closed by hand. */
  followup_status?: "active" | "closed";
  /** The order, first key first; newest first when empty. */
  sort?: SortKey[];
  /** Rows changed in the open list: they keep their place by the earlier state. */
  pins?: Pin[];
  limit?: number;
  offset?: number;
}

export type SortField = "date" | "unread" | "flagged" | "people" | "sender" | "subject" | "size" | "attachments" | "relevance";

/** One step of the order. `desc`: newest, biggest, Я→А; for yes/no keys the "yes" first. */
export interface SortKey {
  by: SortField;
  desc: boolean;
}

export interface Pin {
  id: number;
  unread: boolean;
  flagged: boolean;
}

export type FlagChange = { flag: "seen" | "flagged" | "answered" | "answered_all" | "forwarded"; value: boolean };

export type AttachmentSource =
  | { kind: "file"; path: string; name: string; size: number }
  | { kind: "message"; id: number; index: number; name: string; size: number };

/** How a letter is written: plain text, formatted in the visual editor, or Markdown. */
export type BodyFormat = "plain" | "html" | "markdown";

export interface ComposeDraft {
  from: Addr | null;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  /** The plain-text version; in Markdown, the Markdown itself. Plugins read and check it. */
  text: string;
  /** The letter from the visual editor; only an HTML letter has it. */
  html?: string | null;
  /** The HTML of a Markdown letter's signature (#67): the window shows it formatted and the
   *  backend builds the letter's HTML and Markdown parts from it. Absent for other formats. */
  signature?: string | null;
  /** Absent is plain text. */
  format?: BodyFormat;
  in_reply_to: string | null;
  references: string[];
  attachments: AttachmentSource[];
  /** Scheduled sending time, unix seconds: it stays with the draft until sent or cancelled. */
  send_at?: number | null;
  /** The letter this one answers or forwards; absent for a new one. */
  acts_on?: ActsOn | null;
}

/** A draft kept locally as a fallback if the app crashes before the server copy (#71). */
export interface CachedDraft {
  key: string;
  account_id: string;
  draft: ComposeDraft;
  /** The server copy this one continues, if the draft was saved there before. */
  draft_id?: number | null;
  /** The Message-ID of that server copy; absent in copies written before it was kept (#92). */
  draft_message_id?: string | null;
  updated: number;
}

export interface OutboxItem {
  id: number;
  account_id: string;
  draft: {
    subject: string;
    to: Addr[];
    attachments: { name: string }[];
  };
  attempts: number;
  next_attempt: number;
  last_error: string | null;
  failed: boolean;
  created: number;
  followup_secs: number;
  followup: FollowupPlan;
}

export interface Template {
  name: string;
  text: string;
}

/** The user's keys: only what differs from the defaults. */
export interface KeySettings {
  /** Keys by command id; an empty list is a command left without a key. */
  custom: Record<string, string[]>;
  /** Plugins' keys taken by someone else, "<command>:<key>", whose notice was seen. */
  dismissed: string[];
}

/** `system` follows the system's light or dark mode with `paper` and `night`. */
export type Theme = "system" | "paper" | "night" | "snow" | "graphite";

export interface Settings {
  undo_send_secs: number;
  notify: "people" | "all" | "none";
  dnd_until: number;
  threads: boolean;
  list_avatars: boolean;
  templates: Template[];
  updates: "auto" | "notify" | "off";
  language: "auto" | "en" | "ru";
  theme: Theme;
  disabled_plugins: string[];
  /** Plugins the user switched on explicitly; only those off by default use it. */
  enabled_plugins: string[];
  plugin_settings: Record<string, Record<string, unknown>>;
  /** The user's keys of commands (Settings → Keys). */
  keybindings: KeySettings;
  disabled_extensions: string[];
  oauth_clients: Partial<Record<OAuthProvider, OAuthClient>>;
  /** Mail kept whole for offline reading: off, the last N days, or all. */
  offline: "off" | "30" | "90" | "365" | "all";
  offline_attachments: boolean;
  /** Brand logos (BIMI) next to mail that passed DMARC. */
  sender_logos: boolean;
  /** Where attachments are saved without asking; empty asks every time. */
  attachments_dir: string;
  /** The order of lists without one of their own; newest first when empty. */
  list_sort: SortKey[];
  /** Lists ordered their own way, by view key. */
  view_sorts: Record<string, SortKey[]>;
  /** What counts as a large letter in the ready queries (Settings → Storage → Search), megabytes. */
  large_mb: number;
  /** A picture put into a letter's text is drawn no wider than this on its long side, pixels. */
  image_max_px: number;
  /** How new letters are written; a mailbox may have its own. */
  compose_format: BodyFormat;
  /** Which form of a letter the reader shows; a letter's switch overrides it. */
  letter_view: LetterViewPref;
  /** The mailbox new letters are written from; null follows the open folder or letter. */
  default_account_id: string | null;
  /** Warn when a mailbox fills up: at these two levels (percent) and when full. */
  quota_warn: boolean;
  quota_levels: [number, number];
  /** Once per level crossed, or again every day while above it. */
  quota_repeat: "threshold" | "daily";
  /** Closing the main window: ask (once, with «Remember»), keep working in the background, or quit. */
  close_action: "ask" | "background" | "quit";
  /** Agreed to work in the background with no tray icon to come back by. */
  background_without_tray: boolean;
  /** Start at login: not at all, with the window, or only the tray icon. */
  autostart: "off" | "window" | "background";
  /** The number of unread letters in the inboxes on the tray icon. */
  tray_count: boolean;
  /** The tray icon stays while the window is open. */
  tray_always: boolean;
  /** The suggestions of 0.7 (#69): the one switch that turns every one of them off. */
  hints: boolean;
  /** The note about the three parts of a Markdown letter, in the format menu (#103): false once it was closed. */
  markdown_parts_note: boolean;
  /** When the day and the evening begin for «Snooze» (#95), «9:00»; the days it counts as work, ISO 1 Monday … 7 Sunday. */
  day_start: string;
  evening_start: string;
  work_days: number[];
}

/** What a search found in the cache: letters and their bytes. */
export interface SearchTotals {
  count: number;
  size: number;
}

/** The sender's favourite form, or HTML, Markdown or plain text when the letter has it. */
export type LetterViewPref = "sender" | "html" | "markdown" | "text";

/** What a person, a mailbox or a letter asks the reader to show: "" leaves it to the next. */
export type ViewRule = "" | "html" | "markdown" | "text";

/** A form of a letter's text: a part of its `multipart/alternative`. */
export type BodyView = "text" | "html" | "markdown";

/** Background work shown in the tasks window. */
export interface Task {
  key: string;
  kind: "sync" | "prefetch" | "older" | "search" | "send" | "sizes" | "labels" | "stuck-copy" | "empty";
  account_id?: string;
  label: string;
  done: number;
  /** 0 when unknown. */
  total: number;
  state: "running" | "failed";
  error?: CmdError;
  started: number;
}

/** What a folder holds on the server, and the bound that counted it: the clearing touches only that (#74). */
export interface FolderCount {
  total: number;
  /** Opaque; handed back to `folderEmpty`, also by its retry. */
  bound: number;
}

/** How far the clearing of a folder got (#74). */
export interface Emptied {
  total: number;
  done: number;
  /** Stopped between two batches; the rest is still in the folder. */
  stopped: boolean;
}

/** A copy of a sent letter the server refuses to keep in «Sent»; it waits for the user. */
export interface StuckCopy {
  id: number;
  account_id: string;
  subject: string;
  last_error?: string;
  refusals: number;
}

export interface AccountSync {
  account_id: string;
  last_sync: number | null;
  offline_done: number;
  offline_total: number;
  paused: boolean;
}

/** Text in the interface languages; English is required. */
export interface ExtText {
  en: string;
  ru?: string | null;
}

export interface ExtCommand {
  id: string;
  title: ExtText;
  message: boolean;
}

export interface ExtManifest {
  id: string;
  name: ExtText;
  description: ExtText | null;
  version: string;
  author: string | null;
  main: string;
  permissions: string[];
  hooks: string[];
  contributes: { commands: ExtCommand[] };
}

export interface Extension extends ExtManifest {
  enabled: boolean;
  /** Why it is not loaded: its manifest or script fails the checks. */
  problem: string | null;
  /** Installed before consent was asked and able to send mail out: waits for approval. */
  review: boolean;
}

/** Permissions and hooks, the set a user agrees to. */
export interface ExtGrant {
  permissions: string[];
  hooks: string[];
}

/** An extension folder looked at before installing. */
export interface ExtPreview {
  manifest: ExtManifest;
  /** The installed copy with the same id and what was agreed to for it. */
  previous: { version: string; granted: ExtGrant } | null;
}

export interface UpdateStatus {
  current: string;
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "installed" | "error";
  version: string | null;
  notes: string | null;
  error: string | null;
  install: "in-place" | "installer" | "package" | "unsupported";
}

/** A move the backend did; handed back to undo it. */
export interface Moved {
  account_id: string;
  from: string;
  to: string;
  message_ids: string[];
  /** Письма, которые действие пометило прочитанными: отмена снова делает их непрочитанными. */
  unseen?: string[];
  /** Отложенные письма, которые действие сняло с таймера: отмена откладывает их снова на тот же срок. */
  snoozed?: { subject: string }[];
}

export interface Counters {
  snoozed: number;
  /** Letters waiting for an answer: the badge. */
  followups: number;
  /** Waits kept after they ended. */
  followups_closed: number;
}

export type UnsubscribeWay =
  | { kind: "one-click"; host: string }
  | { kind: "mail"; to: string; subject: string; text: string }
  | { kind: "link"; url: string };

/** How a list would be left, shown to the user before anything is sent. */
export interface UnsubscribePlan {
  way: UnsubscribeWay;
  /** The mailbox a request by mail leaves from. */
  from: string;
  /** A request by mail goes to another organization than the sender. */
  foreign: boolean;
}

export type Unsubscribed =
  | { kind: "done" }
  | { kind: "mail-sent"; to: string }
  | { kind: "confirm"; plan: UnsubscribePlan; reason: string };

/** The last quota a server reported, in bytes; limit 0: no storage limit. */
export interface QuotaSeen {
  root: string;
  used: number;
  limit: number;
  messages?: [number, number];
  checked: number;
}

/** A mailbox's room for the sidebar: the quota, or the folder sizes counted. */
export interface QuotaView {
  account_id: string;
  quota: QuotaSeen | null;
  estimate: { bytes: number; partial: boolean; counted: number } | null;
}

export interface FolderSize {
  folder: string;
  bytes: number | null;
  messages: number | null;
  error?: string;
}

/** What the cache knows about a mailbox's server, for the "Server" and "Storage" sections. */
export interface ServerView {
  caps: { greeting: string; capabilities: string[]; detected: number } | null;
  enable: { ok: boolean; answer: string; at: number } | null;
  quota: QuotaSeen | null;
  sizes: { counted: number; method: "status" | "fetch"; folders: FolderSize[] } | null;
  cache_bytes: number;
  poll_secs: number;
  /** A folder size count under way: done and all. */
  counting: [number, number] | null;
  /** The namespaces the server named (RFC 2342); empty when unknown. */
  namespaces: NamespaceInfo;
  /** Every folder's props the cache has, for the "Folders" subsection. */
  folders: FolderProps[];
}
