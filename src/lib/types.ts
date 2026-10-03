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
  display_name: string;
  email: string;
  username: string;
  imap: ServerConfig;
  smtp: ServerConfig;
  save_sent_copy: boolean;
  signature: string;
  auth?: AuthMethod;
  ews?: EwsConfig;
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
  snoozed_until: number | null;
  followup_due: number | null;
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
  attachments: AttachmentInfo[];
}

export interface OpenedMessage {
  row: MessageRow;
  view: MessageView;
  trusted_sender: boolean;
}

export interface ListQuery {
  account_id?: string | null;
  folder?: string | null;
  role?: FolderRole | null;
  unread_only?: boolean;
  flagged_only?: boolean;
  bulk?: boolean | null;
  threads?: boolean;
  snoozed_only?: boolean;
  followups_only?: boolean;
  limit?: number;
  offset?: number;
}

export type FlagChange = { flag: "seen" | "flagged" | "answered"; value: boolean };

export type AttachmentSource =
  | { kind: "file"; path: string; name: string; size: number }
  | { kind: "message"; id: number; index: number; name: string; size: number };

export interface ComposeDraft {
  from: Addr | null;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  text: string;
  in_reply_to: string | null;
  references: string[];
  attachments: AttachmentSource[];
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
}

export interface Template {
  name: string;
  text: string;
}

/** `system` follows the system's light or dark mode with `paper` and `night`. */
export type Theme = "system" | "paper" | "night" | "snow" | "graphite";

export interface Settings {
  undo_send_secs: number;
  notify: "people" | "all" | "none";
  dnd_until: number;
  threads: boolean;
  templates: Template[];
  updates: "auto" | "notify" | "off";
  language: "auto" | "en" | "ru";
  theme: Theme;
  disabled_plugins: string[];
  plugin_settings: Record<string, Record<string, unknown>>;
  disabled_extensions: string[];
  oauth_clients: Partial<Record<OAuthProvider, OAuthClient>>;
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

export interface Extension {
  id: string;
  name: ExtText;
  description: ExtText | null;
  version: string;
  author: string | null;
  main: string;
  permissions: string[];
  hooks: string[];
  contributes: { commands: ExtCommand[] };
  enabled: boolean;
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
}

export interface Counters {
  snoozed: number;
  followups: number;
}

export type Unsubscribed = { kind: "done" } | { kind: "mail-sent"; to: string } | { kind: "link"; url: string };
