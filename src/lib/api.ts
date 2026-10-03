import { invoke } from "@tauri-apps/api/core";
import type {
  Account,
  AccountView,
  Addr,
  CmdError,
  ComposeDraft,
  Detection,
  FlagChange,
  FolderInfo,
  ListQuery,
  MessageRow,
  OpenedMessage,
  OutboxItem,
} from "./types";

/** Backend errors arrive as `CmdError`; anything else is wrapped so callers can rely on the shape. */
export function asError(e: unknown): CmdError {
  if (e && typeof e === "object" && "message" in e && "kind" in e) return e as CmdError;
  return { kind: "other", message: String(e) };
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
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
  accountCheck: (account: Account, password: string | null) => call<void>("account_check", { account, password }),
  accountSave: (account: Account, password: string | null) => call<Account>("account_save", { account, password }),
  accountRemove: (id: string) => call<void>("account_remove", { id }),
  folders: (accountId?: string) => call<FolderInfo[]>("folders", { accountId: accountId ?? null }),
  messages: (query: ListQuery) => call<MessageRow[]>("messages", { query }),
  search: (text: string, accountId?: string) => call<MessageRow[]>("search", { text, accountId: accountId ?? null }),
  serverSearch: (text: string, accountId?: string) =>
    call<MessageRow[]>("server_search", { text, accountId: accountId ?? null }),
  open: (id: number, allowRemote: boolean) => call<OpenedMessage>("message_open", { id, allowRemote }),
  setFlag: (ids: number[], change: FlagChange) => call<void>("set_flag", { ids, change }),
  move: (ids: number[], to: string) => call<void>("move_messages", { ids, to }),
  remove: (ids: number[]) => call<void>("delete_messages", { ids }),
  loadOlder: (accountId: string, folder: string) => call<number>("load_older", { accountId, folder }),
  syncNow: (accountId?: string, folder?: string) =>
    call<void>("sync_now", { accountId: accountId ?? null, folder: folder ?? null }),
  trustSender: (email: string) => call<void>("trust_sender", { email }),
  addresses: (prefix: string) => call<Addr[]>("addresses", { prefix }),
  attachmentSave: (id: number, index: number, path: string) => call<void>("attachment_save", { id, index, path }),
  attachmentsSaveAll: (id: number, dir: string) => call<number>("attachments_save_all", { id, dir }),
  attachmentOpen: (id: number, index: number) => call<void>("attachment_open", { id, index }),
  openLink: (url: string) => call<void>("open_link", { url }),
  send: (accountId: string, draft: ComposeDraft, discardDraft: number | null) =>
    call<number>("send", { accountId, draft: wireDraft(draft), discardDraft }),
  draftSave: (accountId: string, draft: ComposeDraft, replace: number | null) =>
    call<void>("draft_save", { accountId, draft: wireDraft(draft), replace }),
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
