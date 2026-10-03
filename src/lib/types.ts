// Mirrors of the Rust types that cross the IPC boundary (snake_case as serialized).

export type Security = "tls" | "starttls" | "plain";

export interface ServerConfig {
  host: string;
  port: number;
  security: Security;
  trusted_cert?: string;
}

export interface Account {
  id: string;
  display_name: string;
  email: string;
  username: string;
  imap: ServerConfig;
  smtp: ServerConfig;
  save_sent_copy: boolean;
  signature: string;
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

export type FolderRole = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive";

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
}
