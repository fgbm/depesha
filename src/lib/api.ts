import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import type {
  Account,
  AccountSync,
  AccountView,
  CmdError,
  ComposeDraft,
  CachedDraft,
  Emptied,
  FolderCount,
  Counters,
  StuckCopy,
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
  FollowupPlan,
  ListQuery,
  MessageRow,
  MessageView,
  OpenedMessage,
  OutboxItem,
  SearchTotals,
  QuotaView,
  ServerView,
  SortKey,
  FolderProps,
  Label,
  LabelCheck,
  LabelCount,
} from "./types";
import type { Added, Forgotten, Merge, Merged, Person, Snapshot, Split, Suggestion } from "./people";
import type { HintCount, HintState } from "./hints";
import type { NotificationOpen } from "./arrivals.svelte";

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

/** The number the backend gave this page's compositions at load (`draftOpenReset`): its saves carry it. */
let draftGeneration: number | null = null;

export const api = {
  accounts: () => call<AccountView[]>("accounts"),
  detect: (email: string) => call<Detection>("detect", { email }),
  accountCheck: (account: Account, password: string | null, grant: string | null = null) =>
    call<void>("account_check", { account, password, grant }),
  /** The fields of a mailbox's page that do not reach the server; the connection is not touched. */
  accountPatchOwn: (id: string, patch: Record<string, unknown>) => call<Account>("account_patch_own", { id, patch }),
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
  searchTotals: (text: string, accountId?: string) =>
    call<SearchTotals>("search_totals", { text, accountId: accountId ?? null }),
  serverSearch: (text: string, accountId?: string) =>
    call<MessageRow[]>("server_search", { text, accountId: accountId ?? null }),
  open: (id: number, allowRemote: boolean, seq?: number) => call<OpenedMessage>("message_open", { id, allowRemote, seq }),
  setFlag: (ids: number[], change: FlagChange) => call<void>("set_flag", { ids, change }),
  /** Puts one label on rows or takes it off, by the label's name. */
  setLabel: (ids: number[], name: string, value: boolean) => call<void>("set_label", { ids, name, value }),
  labels: (accountId: string) => call<Label[]>("labels", { accountId }),
  labelSave: (accountId: string, name: string, color: string) => call<Label>("label_save", { accountId, name, color }),
  labelRemove: (accountId: string, name: string) => call<void>("label_remove", { accountId, name }),
  /** Renames a label: quiet on IMAP, a category rewrite on Exchange (#42, frame 3, 7). */
  labelRename: (accountId: string, from: string, to: string) => call<Label>("label_rename", { accountId, from, to }),
  /** How many cached letters carry each label, by its keyword (#42, frame 2). */
  labelCounts: (accountId: string) => call<LabelCount[]>("label_counts", { accountId }),
  /** Deletes a label: off the list at once, its keyword off every letter in the background (#42, frame 4Б). */
  labelStrip: (accountId: string, name: string) => call<void>("label_strip", { accountId, name }),
  /** A folder's properties card: rights, permanent flags, owner. */
  folderProps: (accountId: string, folder: string) =>
    call<FolderProps>("folder_props", { accountId, folder }),
  /** Checks own labels on a test message in the folder (#42, frame 9). */
  labelCheck: (accountId: string, folder: string) => call<LabelCheck>("label_check", { accountId, folder }),
  move: (ids: number[], to: string) => call<Moved[]>("move_messages", { ids, to }),
  /** `own`: the letters the action is about, of `ids` (the rest is their conversations): only they are marked read. All of `ids` when omitted. */
  remove: (ids: number[], own?: number[]) => call<Moved[]>("delete_messages", { ids, own }),
  archive: (ids: number[], own?: number[]) => call<Moved[]>("archive", { ids, own }),
  spam: (ids: number[], own?: number[]) => call<Moved[]>("mark_spam", { ids, own }),
  snooze: (ids: number[], until: number) => call<Moved[]>("snooze", { ids, until }),
  unsnooze: (ids: number[]) => call<Moved[]>("unsnooze", { ids }),
  undo: (moved: Moved[]) => call<void>("undo", { moved }),
  thread: (id: number) => call<MessageRow[]>("thread", { id }),
  counters: () => call<Counters>("counters"),
  /** "Keep in the inbox" right after an answer took the letter to wait. */
  followupUnpark: (accountId: string, messageId: string) => call<void>("followup_unpark", { accountId, messageId }),
  unsubscribe: (id: number, way: "one-click" | "mail") => call<Unsubscribed>("unsubscribe", { id, way }),
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
  settingsPatch: (patch: Record<string, unknown>) => call<void>("settings_patch", { patch }),
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
  serverInfo: (accountId: string) => call<ServerView>("server_info", { accountId }),
  serverCheck: (accountId: string) => call<ServerView>("server_check", { accountId }),
  quotaRefresh: (accountId: string) => call<void>("quota_refresh", { accountId }),
  quotas: () => call<QuotaView[]>("quotas"),
  folderSizesCount: (accountId: string) => call<void>("folder_sizes_count", { accountId }),
  folderSizesStop: (accountId: string) => call<void>("folder_sizes_stop", { accountId }),
  notifyFull: (title: string, body: string) => call<void>("notify_full", { title, body }),
  tasks: () => call<Task[]>("tasks_list"),
  taskDismiss: (key: string) => call<void>("task_dismiss", { key }),
  taskStop: (key: string) => call<void>("task_stop", { key }),
  folderTotal: (accountId: string, folder: string) => call<FolderCount>("folder_total", { accountId, folder }),
  folderEmpty: (accountId: string, folder: string, keepIds: number[], bound: number) =>
    call<Emptied>("folder_empty", { accountId, folder, keepIds, bound }),
  /** How many drafts of the mailbox windows have open (the main one and the letters'), as the backend knows. */
  openDrafts: (accountId: string) => call<number>("open_drafts", { accountId }),
  /** A window says which server draft its composition is (null: none, or closed). */
  draftOpen: (localId: string, draftId: number | null, messageId: string | null = null) => call<void>("draft_open", { localId, draftId, messageId }),
  draftOpenReset: async () => {
    draftGeneration = await call<number>("draft_open_reset");
  },
  stuckCopies: () => call<StuckCopy[]>("stuck_copies"),
  sentCopyRetry: (id: number) => call<boolean>("sent_copy_retry", { id }),
  sentCopySave: (id: number, path: string) => call<void>("sent_copy_save", { id, path }),
  sentCopyDrop: (id: number) => call<void>("sent_copy_drop", { id }),
  trustSender: (email: string) => call<void>("trust_sender", { email }),
  accountsArrange: (ids: string[]) => call<void>("accounts_arrange", { ids }),
  accountLook: (id: string, label: string, color: string) => call<void>("account_look", { id, label, color }),
  avatar: (accountId: string, email: string, messageId: number | null) =>
    call<string | null>("avatar", { accountId, email, messageId }),
  /** People for completion: each with the address to insert and the others to choose (#104). */
  addresses: (prefix: string) => call<Suggestion[]>("addresses", { prefix }),
  /** The address book (#66), filtered by a query over name, address and note. */
  people: (query: string) => call<Person[]>("people", { query }),
  /** Saves the fields of a person; the record as it is kept comes back. */
  personSave: (person: Person) => call<Person>("person_save", { person }),
  /** Adds an address to the person who has `to` among theirs; one of another person is named, not moved (#104). */
  personAddAddress: (to: string, email: string) => call<Added>("person_add_address", { to, email }),
  personSetPrimary: (email: string) => call<Person | null>("person_set_primary", { email }),
  personMerge: (merge: Merge) => call<Merged | null>("person_merge", { merge }),
  personSplit: (email: string) => call<Split | null>("person_split", { email }),
  /** Puts back what a merge or a split changed. */
  personRestore: (undo: Snapshot) => call<void>("person_restore", { undo }),
  /** Removes a person added by hand; one with an address in the correspondence only loses the mark. */
  personForget: (email: string) => call<Forgotten>("person_forget", { email }),
  /** The decisions about the suggestions (#69). */
  hints: () => call<HintState[]>("hints"),
  hintSave: (hint: HintState) => call<void>("hint_save", { hint }),
  hintsClear: () => call<void>("hints_clear"),
  /** The counters of the detectors of #69. */
  hintCounts: () => call<HintCount[]>("hint_counts"),
  countHint: (id: string, subject: string, now: number) => call<number>("count_hint", { id, subject, now }),
  clearHintCount: (id: string, subject: string) => call<void>("clear_hint_count", { id, subject }),
  attachmentSave: (id: number, index: number, path: string) => call<void>("attachment_save", { id, index, path }),
  /** Into `dir` just picked with `pickFolder`, or without it into the folder from the settings. */
  attachmentsSaveAll: (id: number, dir: string | null) => call<number>("attachments_save_all", { id, dir }),
  /** Into the folder from the settings; returns the path. */
  attachmentSaveIn: (id: number, index: number) => call<string>("attachment_save_in", { id, index }),
  attachmentOpen: (id: number, index: number) => call<void>("attachment_open", { id, index }),
  messageWindow: (id: number, title: string) => call<void>("message_window", { id, title }),
  /** Arrives as binary, not as JSON. */
  attachmentBytes: (id: number, index: number) => call<ArrayBuffer>("attachment_bytes", { id, index }),
  /** A letter's raw bytes (an attached .eml), parsed as the reader shows it. */
  letterView: (bytes: ArrayBuffer) => call<MessageView>("letter_view", new Uint8Array(bytes)),
  documentHtml: (text: string, markdown: boolean) => call<string>("document_html", { text, markdown }),
  /** A letter in Markdown as the HTML it goes out as. */
  markdownHtml: (text: string) => call<string>("markdown_html", { text }),
  openLink: (url: string) => call<void>("open_link", { url }),
  send: (accountId: string, draft: ComposeDraft, discardDraft: number | null, discardMessageId: string | null, at: number | null, followupSecs: number | null, followup: FollowupPlan | null = null) =>
    call<{ id: number; at: number }>("send", { accountId, draft: wireDraft(draft), discardDraft, discardMessageId, at, followupSecs, followup }),
  draftSave: (accountId: string, draft: ComposeDraft, replace: number | null, replaceMessageId: string | null, localId: string | null = null) =>
    call<{ id: number; message_id: string | null } | null>("draft_save", { accountId, draft: wireDraft(draft), replace, replaceMessageId, localId, generation: draftGeneration }),
  draftDiscard: (accountId: string, id: number, messageId: string | null) => call<void>("draft_discard", { accountId, id, messageId }),
  /** The local copy of a draft, kept on every typing pause as a fallback for a crash (#71). */
  draftCachePut: (key: string, accountId: string, draft: ComposeDraft, draftId: number | null = null, draftMessageId: string | null = null) =>
    call<void>("draft_cache_put", { key, accountId, draft, draftId, draftMessageId }),
  /** Drafts kept locally, to offer restoring when the app starts. */
  draftCacheList: () => call<CachedDraft[]>("draft_cache_list"),
  /** The draft reached the server (or was thrown away): its local copy goes. */
  draftCacheDrop: (key: string) => call<void>("draft_cache_drop", { key }),
  outbox: () => call<OutboxItem[]>("outbox"),
  outboxRetry: (id: number) => call<void>("outbox_retry", { id }),
  /** Letters held back since the last call: they missed their time. */
  outboxMissed: () => call<number[]>("outbox_missed"),
  /** A letter's window says whether it holds a letter being written: a quit asks it first. */
  composeUnsaved: (unsaved: boolean) => call<void>("compose_unsaved", { unsaved }),
  /** The main window saved its drafts for a quit: the quit waiting for it goes on. */
  composeSaved: () => call<void>("compose_unsaved", { unsaved: false }),
  /** The user keeps the letter being written: a quit waiting for the window stops. */
  quitCancel: () => call<void>("quit_cancel"),
  /** The sheet of a letter into the system print panel; macOS only (print.ts). */
  printSheet: (html: string) => call<void>("print_sheet", { html }),
  /** Says in the backend log that the page heard of a drop: the count only, never the names. */
  dropSeen: (count: number) => call<void>("drop_seen", { count }),
  /** Says in the backend log what the page did with a drop: numbers only, never the names. */
  dropOutcome: (o: { outcome: "attached" | "no_compose" | "missed_zone"; attached: number; inline: number; zone: "inline" | "attach" | "none"; x: number; y: number; width: number; height: number }) => call<void>("drop_outcome", o),
  /** Whether the system shows tray icons. */
  backgroundStatus: () => call<{ tray: "checking" | "present" | "absent" }>("background_status"),
  /** A toast click while the app was closed, kept until the window listens; null otherwise. */
  deepLinkTake: () => call<NotificationOpen | null>("deep_link_take"),
  /** Hides the main window; the app works on in the background. */
  windowHide: () => call<void>("window_hide"),
  /** Quits; letters due soon make the window ask first, unless `force`. */
  appQuit: (force: boolean) => call<void>("app_quit", { force }),
  outboxCancel: (id: number) =>
    call<{ account_id: string; draft: ComposeDraft & { attachments: unknown[] }; attachments: [string, string, string][] } | null>(
      "outbox_cancel",
      { id },
    ),
  tempAttachment: (name: string, data: string) => call<string>("temp_attachment", { name, data }),
  /** Name and size of a file dropped on the window. */
  fileInfo: (path: string) => call<PickedFile>("file_info", { path }),
  // The system dialogs are opened by the backend: it reads and writes only what the user picked there.
  /** `images`: the dialog shows pictures first. */
  pickFiles: (title: string, images = false) => call<PickedFile[]>("pick_files", { title, images }),
  /** A picked or dropped picture as a `data:` URL, for the text of a letter. */
  inlineImage: (path: string) => call<string>("inline_image", { path }),
  pickFolder: (to: "save" | "plugin", title: string, current: string | null = null) =>
    call<string | null>("pick_folder", { to, title, current }),
  pickSaveFile: (title: string, name: string) => call<string | null>("pick_save_file", { title, name }),
  pluginSettingsSet: (plugin: string, values: Record<string, unknown>) =>
    call<void>("plugin_settings_set", { plugin, values }),
};

export type PickedFile = { path: string; name: string; size: number };
