import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import type {
  Account,
  AccountSync,
  AccountView,
  Addr,
  CmdError,
  ComposeDraft,
  Counters,
  Extension,
  ExtGrant,
  ExtManifest,
  ExtPreview,
  Moved,
  Settings,
  Task,
  Unsubscribed,
  UpdateStatus,
  Detection,
  EwsDetection,
  FlagChange,
  OAuthGrant,
  OAuthProvider,
  OAuthProviderView,
  FolderInfo,
  ListQuery,
  MessageRow,
  MessageView,
  OpenedMessage,
  OutboxItem,
  SortKey,
} from "./types";

/** Backend errors arrive as `CmdError`; anything else is wrapped so callers can rely on the shape. */
export function asError(e: unknown): CmdError {
  if (e && typeof e === "object" && "message" in e && "kind" in e) return e as CmdError;
  return { kind: "other", message: String(e) };
}

export async function call<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw asError(e);
  }
}

// The backend takes ComposeDraft attachments as {kind, path} or {kind, id, index}.
function wireDraft(d: ComposeDraft) {
  return {
    ...d,
    attachments: d.attachments.map((a) =>
      a.kind === "file" ? { kind: "file", path: a.path } : { kind: "message", id: a.id, index: a.index },
    ),
  };
}

export const api = {
  accounts: () => call<AccountView[]>("accounts"),
  detect: (email: string) => call<Detection>("detect", { email }),
  accountCheck: (account: Account, password: string | null, grant: string | null = null) =>
    call<void>("account_check", { account, password, grant }),
  accountSave: (account: Account, password: string | null, grant: string | null = null) =>
    call<Account>("account_save", { account, password, grant }),
  oauthProviders: () => call<OAuthProviderView[]>("oauth_providers"),
  oauthSignIn: (provider: OAuthProvider, loginHint: string | null) =>
    call<OAuthGrant>("oauth_sign_in", { provider, loginHint }),
  oauthCancel: () => call<void>("oauth_cancel"),
  exchangeDetect: (email: string, username: string, password: string, server: string | null) =>
    call<EwsDetection>("exchange_detect", { email, username, password, server }),
  accountRemove: (id: string) => call<void>("account_remove", { id }),
  folders: (accountId?: string) => call<FolderInfo[]>("folders", { accountId: accountId ?? null }),
  messages: (query: ListQuery) => call<MessageRow[]>("messages", { query }),
  search: (text: string, sort: SortKey[] = [], accountId?: string) =>
    call<MessageRow[]>("search", { text, accountId: accountId ?? null, sort }),
  serverSearch: (text: string, accountId?: string) =>
    call<MessageRow[]>("server_search", { text, accountId: accountId ?? null }),
  open: (id: number, allowRemote: boolean) => call<OpenedMessage>("message_open", { id, allowRemote }),
  setFlag: (ids: number[], change: FlagChange) => call<void>("set_flag", { ids, change }),
  move: (ids: number[], to: string) => call<Moved[]>("move_messages", { ids, to }),
  remove: (ids: number[]) => call<Moved[]>("delete_messages", { ids }),
  archive: (ids: number[]) => call<Moved[]>("archive", { ids }),
  spam: (ids: number[]) => call<Moved[]>("mark_spam", { ids }),
  snooze: (ids: number[], until: number) => call<Moved[]>("snooze", { ids, until }),
  undo: (moved: Moved[]) => call<void>("undo", { moved }),
  thread: (id: number) => call<MessageRow[]>("thread", { id }),
  counters: () => call<Counters>("counters"),
  followupCancel: (id: number) => call<void>("followup_cancel", { id }),
  unsubscribe: (id: number) => call<Unsubscribed>("unsubscribe", { id }),
  settings: () => call<Settings>("settings_get"),
  language: () => call<"en" | "ru">("language"),
  extensions: () => call<Extension[]>("extensions"),
  extensionInspect: (path: string) => call<ExtPreview>("extension_inspect", { path }),
  extensionInstall: (path: string, grant: ExtGrant) => call<ExtManifest>("extension_install", { path, ...grant }),
  extensionApprove: (id: string, grant: ExtGrant) => call<void>("extension_approve", { id, ...grant }),
  extensionRemove: (id: string) => call<void>("extension_remove", { id }),
  extensionStorageGet: (id: string, key: string) => call<unknown>("extension_storage_get", { id, key }),
  extensionStorageSet: (id: string, key: string, value: unknown) => call<void>("extension_storage_set", { id, key, value }),
  messagesById: (ids: number[]) => call<MessageRow[]>("messages_by_id", { ids }),
  saveSettings: (settings: Settings) => call<void>("settings_set", { settings }),
  updateStatus: () => call<UpdateStatus>("update_status"),
  updateCheck: () => call<UpdateStatus>("update_check"),
  updateInstall: () => call<UpdateStatus>("update_install"),
  updateRestart: () => call<void>("update_restart"),
  loadOlder: (accountId: string, folder: string) => call<number>("load_older", { accountId, folder }),
  syncNow: (accountId?: string, folder?: string) =>
    call<void>("sync_now", { accountId: accountId ?? null, folder: folder ?? null }),
  syncOverview: () => call<AccountSync[]>("sync_overview"),
  folderCreate: (accountId: string, parent: string | null, name: string) =>
    call<void>("folder_create", { accountId, parent, name }),
  offlinePause: (accountId: string, paused: boolean) => call<void>("offline_pause", { accountId, paused }),
  tasks: () => call<Task[]>("tasks_list"),
  taskDismiss: (key: string) => call<void>("task_dismiss", { key }),
  trustSender: (email: string) => call<void>("trust_sender", { email }),
  accountsArrange: (ids: string[]) => call<void>("accounts_arrange", { ids }),
  accountLook: (id: string, label: string, color: string) => call<void>("account_look", { id, label, color }),
  avatar: (accountId: string, email: string, authenticated: boolean) =>
    call<string | null>("avatar", { accountId, email, authenticated }),
  addresses: (prefix: string) => call<Addr[]>("addresses", { prefix }),
  attachmentSave: (id: number, index: number, path: string) => call<void>("attachment_save", { id, index, path }),
  attachmentsSaveAll: (id: number, dir: string) => call<number>("attachments_save_all", { id, dir }),
  attachmentSaveIn: (id: number, index: number, dir: string) => call<string>("attachment_save_in", { id, index, dir }),
  attachmentOpen: (id: number, index: number) => call<void>("attachment_open", { id, index }),
  messageWindow: (id: number, title: string) => call<void>("message_window", { id, title }),
  /** Arrives as binary, not as JSON. */
  attachmentBytes: (id: number, index: number) => call<ArrayBuffer>("attachment_bytes", { id, index }),
  /** A letter's raw bytes (an attached .eml), parsed as the reader shows it. */
  letterView: (bytes: ArrayBuffer) => call<MessageView>("letter_view", new Uint8Array(bytes)),
  documentHtml: (text: string, markdown: boolean) => call<string>("document_html", { text, markdown }),
  openLink: (url: string) => call<void>("open_link", { url }),
  send: (accountId: string, draft: ComposeDraft, discardDraft: number | null, at: number | null, followupSecs: number | null) =>
    call<{ id: number; at: number }>("send", { accountId, draft: wireDraft(draft), discardDraft, at, followupSecs }),
  draftSave: (accountId: string, draft: ComposeDraft, replace: number | null) =>
    call<number | null>("draft_save", { accountId, draft: wireDraft(draft), replace }),
  draftDiscard: (id: number) => call<void>("draft_discard", { id }),
  outbox: () => call<OutboxItem[]>("outbox"),
  outboxRetry: (id: number) => call<void>("outbox_retry", { id }),
  outboxCancel: (id: number) =>
    call<{ account_id: string; draft: ComposeDraft & { attachments: unknown[] }; attachments: [string, string, string][] } | null>(
      "outbox_cancel",
      { id },
    ),
  tempAttachment: (name: string, data: string) => call<string>("temp_attachment", { name, data }),
  fileInfo: (path: string) => call<{ name: string; size: number }>("file_info", { path }),
};
