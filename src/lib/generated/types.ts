// Generated from the Rust structs by `scripts/gen-types.sh` (#143). Do not edit by hand:
// change the Rust type and run the script; the test `generated_types_are_current` checks it.

export type Account = { id: string, 
/**
 * What the user calls the mailbox in the app ("Work"); empty shows the address.
 */
label?: string, 
/**
 * Colour that marks the mailbox in the sidebar and in shared lists (`#3f7cc4`);
 * empty takes one from the palette by the mailbox's place.
 */
color?: string, 
/**
 * Sender name recipients see in From.
 */
display_name: string, email: string, username: string, imap: ServerConfig, smtp: ServerConfig, 
/**
 * Put a copy of sent mail into Sent. Off for servers that do it themselves (Gmail).
 */
save_sent_copy: boolean, 
/**
 * The one plain-text signature of versions before 0.6.0. Read only to be moved into
 * `signatures` (`Account::adopt_old_signature`); never written.
 */
signature?: string, 
/**
 * The mailbox's signatures, in the user's order; none is fine.
 */
signatures?: Array<Signature>, 
/**
 * The id of the signature new letters get; none puts none.
 */
default_signature?: string | null, 
/**
 * The id of the signature replies and forwards get; none takes `default_signature`.
 * Added after 0.6.3: absent in older configs, which read as none.
 */
reply_signature?: string | null, 
/**
 * How new letters from this mailbox are written; none takes the format from the settings.
 */
compose_format?: BodyFormat | null, 
/**
 * How this mailbox's letters are shown: `html`, `markdown` or `text`; none takes the
 * form from the settings. Added after 0.6.3: absent in older configs, which read as none.
 */
letter_view?: "" | "html" | "markdown" | "text" | null, 
/**
 * Where this mailbox's attachments are saved without asking; empty takes the
 * folder from the settings.
 */
attachments_dir?: string, 
/**
 * How the account logs in. Accounts saved before OAuth use a password.
 */
auth?: AuthMethod, 
/**
 * Exchange Web Services instead of IMAP and SMTP: `imap` and `smtp` are then unused.
 */
ews?: EwsConfig | null, 
/**
 * Warn when the mailbox fills up (the levels are in the settings).
 */
quota_warn?: boolean, 
/**
 * The user's own limit for the warnings, in megabytes; 0 takes the server's quota.
 * The quota on the server stays as it is.
 */
quota_limit_mb?: number, 
/**
 * What an answer does with a letter of the inbox: off until the user switches it on.
 */
waiting?: Waiting, };

export type AccountState = "connecting" | "online" | "error" | "paused";

export type AccountStatus = { state: AccountState, error?: CmdError | null, };

export type AccountSync = { account_id: string, last_sync: number | null, 
/**
 * Messages in the offline window with their text downloaded, and all of them.
 */
offline_done: number, offline_total: number, paused: boolean, };

export type AccountView = { status: AccountStatus | null, id: string, 
/**
 * What the user calls the mailbox in the app ("Work"); empty shows the address.
 */
label?: string, 
/**
 * Colour that marks the mailbox in the sidebar and in shared lists (`#3f7cc4`);
 * empty takes one from the palette by the mailbox's place.
 */
color?: string, 
/**
 * Sender name recipients see in From.
 */
display_name: string, email: string, username: string, imap: ServerConfig, smtp: ServerConfig, 
/**
 * Put a copy of sent mail into Sent. Off for servers that do it themselves (Gmail).
 */
save_sent_copy: boolean, 
/**
 * The one plain-text signature of versions before 0.6.0. Read only to be moved into
 * `signatures` (`Account::adopt_old_signature`); never written.
 */
signature?: string, 
/**
 * The mailbox's signatures, in the user's order; none is fine.
 */
signatures?: Array<Signature>, 
/**
 * The id of the signature new letters get; none puts none.
 */
default_signature?: string | null, 
/**
 * The id of the signature replies and forwards get; none takes `default_signature`.
 * Added after 0.6.3: absent in older configs, which read as none.
 */
reply_signature?: string | null, 
/**
 * How new letters from this mailbox are written; none takes the format from the settings.
 */
compose_format?: BodyFormat | null, 
/**
 * How this mailbox's letters are shown: `html`, `markdown` or `text`; none takes the
 * form from the settings. Added after 0.6.3: absent in older configs, which read as none.
 */
letter_view?: "" | "html" | "markdown" | "text" | null, 
/**
 * Where this mailbox's attachments are saved without asking; empty takes the
 * folder from the settings.
 */
attachments_dir?: string, 
/**
 * How the account logs in. Accounts saved before OAuth use a password.
 */
auth?: AuthMethod, 
/**
 * Exchange Web Services instead of IMAP and SMTP: `imap` and `smtp` are then unused.
 */
ews?: EwsConfig | null, 
/**
 * Warn when the mailbox fills up (the levels are in the settings).
 */
quota_warn?: boolean, 
/**
 * The user's own limit for the warnings, in megabytes; 0 takes the server's quota.
 * The quota on the server stays as it is.
 */
quota_limit_mb?: number, 
/**
 * What an answer does with a letter of the inbox: off until the user switches it on.
 */
waiting?: Waiting, };

export type Act = "reply" | "reply_all" | "forward";

export type ActsOn = { account_id: string, message_id: string, 
/**
 * Where it was when the answer was written, as the cache names the folder.
 */
folder: string, act: Act, 
/**
 * It waits for a reply in the folder already: the answer leaves it there.
 */
waiting: boolean, };

export type Addr = { name: string | null, email: string, };

export type AttachmentInfo = { index: number, name: string, mime: string, size: number, content_id: string | null, inline: boolean, };

export type AttachmentSource = { "kind": "file", path: string, 
/**
 * The name and size the window shows: Rust takes the letter from the source, not from them.
 */
name: string, size: number, } | { "kind": "message", id: number, index: number, name: string, size: number, };

export type AuthMethod = { "kind": "password" } | { "kind": "oauth", provider: OAuthProvider, };

export type BodyFormat = "plain" | "html" | "markdown";

export type BodyView = "text" | "html" | "markdown";

export type CachedDraft = { key: string, account_id: string, 
/**
 * The window's draft verbatim (a `ComposeDraft` of the interface).
 */
draft: ComposeDraft, 
/**
 * The server copy this one continues, so a restore replaces it instead of adding a twin.
 */
draft_id?: number | null, 
/**
 * The Message-ID of that server copy: the number alone may be handed out again to
 * another draft, so a delete checks both (#92). Absent in copies written before.
 */
draft_message_id?: string | null, 
/**
 * When it was last written, seconds since the epoch.
 */
updated: number, };

export type CertProblem = { host: string, 
/**
 * Why, in English; the words the user reads are made from `why` (or this, for `Other`).
 */
reason: string, why: CertWhy, 
/**
 * SHA-256 of the DER certificate, lowercase hex; this is what gets pinned.
 */
sha256: string, subject: string, issuer: string, not_after: number | null, };

export type CertWhy = "Expired" | "NotYetValid" | "UnknownIssuer" | "WrongName" | "Revoked" | "Failed" | "Other";

export type CmdError = { kind: ErrorKind, message: string, cert?: CertProblem | null, };

export type ComposeDraft = { from: Addr | null, to: Array<Addr>, cc: Array<Addr>, bcc: Array<Addr>, subject: string, text: string, 
/**
 * The letter from the visual editor; only an HTML letter has it.
 */
html?: string | null, 
/**
 * The HTML of the signature a Markdown letter carries (#67).
 */
signature?: string | null, format?: BodyFormat, in_reply_to: string | null, references: Array<string>, attachments: Array<AttachmentSource>, 
/**
 * Scheduled sending time: kept with a saved draft, the send takes `at` instead.
 */
send_at?: number | null, 
/**
 * The letter this one answers or forwards.
 */
acts_on?: ActsOn | null, 
/**
 * Asked to be read first (#72).
 */
importance?: Importance, };

export type Counters = { snoozed: number, 
/**
 * Letters waiting for an answer: the badge.
 */
followups: number, 
/**
 * Waits kept after they ended: the view stays in the sidebar for them.
 */
followups_closed: number, };

export type Detection = { imap: ServerConfig | null, smtp: ServerConfig | null, username: string, source: string, notes: Array<string>, };

export type Draft = { from: Addr | null, to: Array<Addr>, cc: Array<Addr>, bcc: Array<Addr>, subject: string, 
/**
 * The plain-text version; for Markdown, the Markdown itself.
 */
text: string, 
/**
 * The letter as HTML, when it was written formatted.
 */
html: string | null, 
/**
 * The HTML of the signature a Markdown letter carries (#67): the window shows it
 * formatted, and the parts it goes out in — HTML, Markdown and text — are built here.
 * An HTML letter keeps its signature inside `html`, a plain one its text inside `text`.
 */
signature?: string | null, 
/**
 * Outbox entries saved before formats existed are plain text.
 */
format: BodyFormat, in_reply_to: string | null, references: Array<string>, attachments: Array<OutgoingAttachment>, 
/**
 * The letter this one answers or forwards; none for a new one.
 */
acts_on?: ActsOn | null, 
/**
 * The sender asks to read the letter first (#72): `Importance: high` and `X-Priority: 1`.
 * The window offers high only; a normal letter says nothing.
 */
importance?: Importance, };

export type Emptied = { 
/**
 * Messages the folder held when the run began, less the ones it was told to keep.
 */
total: number, done: number, 
/**
 * The run was stopped between two batches; the rest is still there.
 */
stopped: boolean, };

export type EnableAnswer = { ok: boolean, answer: string, at: number, };

export type ErrorKind = "certificate" | "no-tls" | "auth" | "not-found" | "too-large" | "imap-unavailable" | "rate-limited" | "paused" | "cache-too-new" | "folder-changed" | "no-rights" | "network" | "other" | "io" | "extension" | "bad-request" | "input" | "keyring" | "save-folder" | "dangerous" | "unsupported" | "print" | "cancelled" | "window" | "not-a-file" | "not-a-picture" | "update" | "not-chosen" | "copy-filed" | "superseded";

export type Estimate = { bytes: number, partial: boolean, counted: number, };

export type EwsConfig = { url: string, 
/**
 * SHA-256 of a certificate the user explicitly trusted for this server.
 */
trusted_cert?: string | null, };

export type EwsDetection = { url: string | null, source: string, notes: Array<string>, };

export type ExtCommand = { id: string, title: ExtText, 
/**
 * Shown in the message menu and given the open message (needs `messages.read`).
 */
message: boolean, };

export type ExtContributes = { commands: Array<ExtCommand>, };

export type ExtGrant = { permissions: Array<string>, hooks: Array<string>, };

export type ExtManifest = { id: string, name: ExtText, description: ExtText | null, version: string, author: string | null, main: string, permissions: Array<string>, 
/**
 * Events the extension handles; it is started only when one of them happens.
 */
hooks: Array<string>, contributes: ExtContributes, };

export type ExtPreview = { manifest: ExtManifest, 
/**
 * The installed copy with the same id, and what the user agreed to for it.
 */
previous: ExtPrevious | null, };

export type ExtPrevious = { version: string, 
/**
 * Empty when nothing was agreed to: every permission then counts as new.
 */
granted: ExtGrant, };

export type ExtText = { en: string, ru: string | null, };

export type Extension = { enabled: boolean, 
/**
 * Why it is not loaded: its manifest or script fails the checks.
 */
problem: string | null, 
/**
 * Waits for the user to approve its permissions before it runs.
 */
review: boolean, id: string, name: ExtText, description: ExtText | null, version: string, author: string | null, main: string, permissions: Array<string>, 
/**
 * Events the extension handles; it is started only when one of them happens.
 */
hooks: Array<string>, contributes: ExtContributes, };

export type FlagChange = { "flag": "seen", "value": boolean } | { "flag": "flagged", "value": boolean } | { "flag": "answered", "value": boolean } | { "flag": "answered_all", "value": boolean } | { "flag": "forwarded", "value": boolean };

export type Flags = { seen: boolean, answered: boolean, flagged: boolean, draft: boolean, deleted: boolean, 
/**
 * Forwarded: the `$Forwarded` keyword of IMAP, the last verb of Exchange.
 */
forwarded: boolean, 
/**
 * Answered to all: only Exchange tells it apart; IMAP has `\Answered` for both.
 */
answered_all: boolean, };

export type Folder = { 
/**
 * Name as the server knows it (modified UTF-7); used in IMAP commands.
 */
name: string, display_name: string, delimiter: string | null, role: FolderRole | null, selectable: boolean, 
/**
 * Not a mail folder (Exchange calendar, contacts...): hidden and never synced.
 */
hidden: boolean, };

export type FolderCount = { total: number, bound: number, };

export type FolderInfo = { account_id: string, total: number, unread: number, 
/**
 * Name as the server knows it (modified UTF-7); used in IMAP commands.
 */
name: string, display_name: string, delimiter: string | null, role: FolderRole | null, selectable: boolean, 
/**
 * Not a mail folder (Exchange calendar, contacts...): hidden and never synced.
 */
hidden: boolean, };

export type FolderProps = { folder: string, display_name: string, 
/**
 * The folder is not the user's: shared or another person's (from NAMESPACE).
 */
owner: Owner, rights: Rights | null, 
/**
 * Whether own labels can be stored here, from PERMANENTFLAGS; None when unknown.
 */
labels_on_server: boolean | null, 
/**
 * The PERMANENTFLAGS the server listed, for the details.
 */
permanent: Array<string>, 
/**
 * The outcome of the "check labels on a test message" run; None when never checked (#42, frame 9).
 */
label_check: LabelCheck | null, 
/**
 * The remembered refusal in this folder (`no-rights`), if any.
 */
refused: string | null, 
/**
 * When the props were read, Unix time; 0 when never.
 */
checked: number, };

export type FolderRole = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "snoozed";

export type FolderSize = { folder: string, bytes: number | null, messages: number | null, 
/**
 * The server's refusal (no rights, gone): the folder is left out, not counted as empty.
 */
error?: string | null, };

export type FolderSizes = { counted: number, method: SizeMethod, folders: Array<FolderSize>, };

export type FollowupFilter = "active" | "closed";

export type FollowupInfo = { status: FollowupStatus, 
/**
 * The next reminder.
 */
due: number, deadline: number, 
/**
 * The deadline was given apart from the reminder ("a day before the deadline").
 */
own_deadline: boolean, repeat_secs: number, expect: string, kind: string, 
/**
 * When it ended: the date of the answer, or when it was closed by hand.
 */
ended: number | null, answered_by: Addr | null, 
/**
 * The answer in the cache, when it is there.
 */
answer: number | null, 
/**
 * When the reminders came, oldest first.
 */
reminded: Array<number>, 
/**
 * When the letter waited for went: the wait is from then on.
 */
sent: number, 
/**
 * Where the letters answered are (#59): "" none moved, "pending" still in the inbox,
 * "parked" in `park_folder`, "back" and "undo" on their way back, "returned" back
 * with the reply, "done" back by hand or moved elsewhere.
 */
park: string, park_folder: string, 
/**
 * The latest auto-reply or newsletter that answered and did not count.
 */
auto_reply: number | null, };

export type FollowupPlan = { 
/**
 * The answer is expected by this long after sending; 0: by the first reminder.
 */
deadline_secs: number, 
/**
 * The first reminder at this time (unix seconds) instead of `secs` after sending: a
 * day of the week, a date, a time before a deadline do not move with the sending.
 * 0: `secs` after sending.
 */
due_at?: number, 
/**
 * The answer is expected by this time (unix seconds) instead of `deadline_secs`; 0: none.
 */
deadline_at?: number, 
/**
 * Remind again this often until an answer comes; 0: once.
 */
repeat_secs: number, 
/**
 * Only an answer from this address counts; empty: from anyone.
 */
expect: string, 
/**
 * The name of the choice the wait was set with, shown with it.
 */
kind: string, 
/**
 * An answer takes the letter it answers to wait in the folder (#59): asked in the
 * compose window, the mailbox's setting when not asked. The outbox keeps it decided.
 */
park?: boolean | null, 
/**
 * An answer takes the letter it answers to the archive, with no wait (#106): asked in
 * the compose window, the mailbox's setting when not asked. A wait goes before it.
 */
archive?: boolean | null, };

export type FollowupStatus = "waiting" | "answered" | "closed";

export type Importance = "low" | "normal" | "high";

export type Install = "in-place" | "installer" | "package" | "unsupported";

export type JsonValue = number | string | boolean | Array<JsonValue> | { [key in string]: JsonValue } | null;

export type KeySettings = { 
/**
 * An empty list is a command left without a key.
 */
custom: { [key in string]: Array<string> }, 
/**
 * Plugins' keys taken by someone else, `<command>:<key>`, whose notice was seen.
 */
dismissed: Array<string>, };

export type Label = { name: string, 
/**
 * The IMAP keyword (an atom) or the Exchange category name.
 */
keyword: string, 
/**
 * `#rrggbb`, chosen in Depesha; not synced.
 */
color: string, 
/**
 * Being taken off every letter of the mailbox (#42, frame 4Б): the label stays in the
 * list, marked as such, until the server work is done; a restart or a pause resumes it.
 */
stripping: boolean, };

export type LabelCheck = "saves" | "not-saves" | "claimed-but-lost";

export type LabelCount = { keyword: string, count: number, };

export type ListQuery = { account_id?: string | null, folder?: string | null, 
/**
 * Folder role across all accounts, e.g. every inbox. Defaults to inbox
 * when no folder is given.
 */
role?: FolderRole | null, unread_only?: boolean, flagged_only?: boolean, 
/**
 * Messages that stay in an unread or flagged list although they no longer
 * match: the ones read or unflagged while it is open, as in Gmail.
 */
keep_ids?: Array<number>, 
/**
 * Only mail from people (`false`) or only lists and notifications (`true`).
 */
bulk?: boolean | null, 
/**
 * One row per conversation: its newest message, with the count.
 */
threads?: boolean, 
/**
 * Snoozed mail of every account, wherever it waits.
 */
snoozed_only?: boolean, 
/**
 * Sent mail with a wait for an answer: those still waiting, or `followup_status`.
 */
followups_only?: boolean, followup_status?: FollowupFilter, 
/**
 * The order, first key first; newest first when empty.
 */
sort?: Array<SortKey>, 
/**
 * Rows changed in the open list: they sort by their earlier state.
 */
pins?: Array<Pin>, limit?: number, offset?: number, };

export type Mark = { act: Act, 
/**
 * When Depesha did it; none when only the server says so: the time is unknown.
 */
at: number | null, };

export type MessageRow = { id: number, account_id: string, folder: string, uid: number, message_id: string | null, in_reply_to: string | null, references: Array<string>, subject: string, from: Addr | null, to: Array<Addr>, cc: Array<Addr>, reply_to: Array<Addr>, date: number, size: number, flags: Flags, 
/**
 * The message's own keywords (labels) on the server, by their keyword names.
 */
keywords?: Array<string>, has_attachments: boolean, thread: string, bulk: boolean, 
/**
 * Letters of the conversation, my answers in Sent included; 1 when the list is not grouped.
 */
thread_count: number, 
/**
 * The newest letter of the conversation, mine included; the row's own date otherwise.
 */
thread_date: number, 
/**
 * Bytes of the conversation's letters in the list; the row's own size otherwise.
 */
thread_size: number, 
/**
 * Who wrote in the conversation, in order of first appearance; empty when not grouped.
 */
thread_senders: Array<Addr>, 
/**
 * An answer is being written: the conversation has a saved draft.
 */
thread_draft: boolean, snoozed_until: number | null, 
/**
 * The sender waits for an answer to this message: the next reminder.
 */
followup_due: number | null, 
/**
 * The wait for an answer to this message, also when it is over.
 */
followup: FollowupInfo | null, 
/**
 * What was done with the letter: answered, answered to all, forwarded.
 */
marks: Array<Mark>, 
/**
 * My latest answer to it, when it is in the cache.
 */
my_answer: number | null, 
/**
 * An answer or forward of it waiting in the outbox.
 */
outgoing: Outgoing | null, 
/**
 * It came back from waiting with the reply, not opened since; for a conversation's
 * row, any letter of it.
 */
answer_came: boolean, 
/**
 * The receiving server vouched for the sender with DMARC (#108): a brand logo may show.
 */
dmarc: boolean, 
/**
 * How much the sender wants it read first (#72); only the high one is shown.
 */
importance: Importance, 
/**
 * Who wrote in the conversation with the verdict on each, the newest writer last
 * (#108: the avatar of a conversation is its last writer who is not me); empty when
 * the list is not grouped.
 */
thread_voices: Array<Voice>, };

export type MessageView = { summary: Summary, text: string | null, 
/**
 * Sanitized HTML, safe to put into a sandboxed iframe.
 */
html: string | null, 
/**
 * The message references remote images or styles (tracking pixels included).
 */
has_remote_content: boolean, 
/**
 * The receiving server says the message passed DMARC for its From domain:
 * a brand logo may stand next to it. `parse_view` leaves it false; the caller
 * that knows the mailbox fills it in from [`authenticity`].
 */
authenticated: boolean, attachments: Array<AttachmentInfo>, 
/**
 * A draft's scheduled sending time (`SEND_AT_HEADER`), unix seconds.
 */
send_at: number | null, 
/**
 * How a draft was being written (`FORMAT_HEADER`); absent for other letters.
 */
format: BodyFormat | null, 
/**
 * The letter a saved draft answers or forwards (`ACTS_ON_HEADER`); absent otherwise.
 */
acts_on: ActsOn | null, 
/**
 * The letter's Markdown (`text/markdown`, RFC 7763) drawn as HTML and cleaned like `html`.
 */
markdown: string | null, 
/**
 * The forms the letter came in, in the order it offers them: the sender's favourite last.
 */
views: Array<BodyView>, };

export type Moved = { account_id: string, from: string, to: string, message_ids: Array<string>, 
/**
 * The waits the move touched: their Message-IDs, so an undo parks them again.
 */
waits: Array<string>, 
/**
 * The letters that were unread when the action marked them read: an undo makes them
 * unread again.
 */
unseen: Array<string>, 
/**
 * The snoozes the move dropped (a snoozed letter brought back or moved by hand): an
 * undo sets them again, for the same time.
 */
snoozed: Array<Snooze>, };

export type NamespaceFolder = { prefix: string, delimiter: string, };

export type NamespaceInfo = { personal: Array<NamespaceFolder>, other_users: Array<NamespaceFolder>, shared: Array<NamespaceFolder>, };

export type OAuthClient = { client_id: string, client_secret?: string | null, };

export type OAuthGrant = { id: string, provider: OAuthProvider, email: string, name: string | null, imap: ServerConfig, smtp: ServerConfig, };

export type OAuthProvider = "google" | "yandex" | "microsoft";

export type OAuthProviderView = { provider: OAuthProvider, title: string, 
/**
 * A client is built in or set by the user.
 */
configured: boolean, };

export type OpenedMessage = { row: MessageRow, view: MessageView, trusted_sender: boolean, 
/**
 * The From address is on the trusted list, but the receiving server does not vouch
 * that this letter is really from it: its pictures stay hidden.
 */
sender_unverified: boolean, };

export type OutboxItem = { id: number, account_id: string, draft: Draft, attempts: number, next_attempt: number, last_error: string | null, 
/**
 * Permanent failure: waits for the user, not retried automatically.
 */
failed: boolean, 
/**
 * The draft does not parse (#146): `draft` is empty, the row is `failed` and waits for
 * the user to discard it. It is never sent, and its letter is not hidden from the list.
 */
broken: boolean, 
/**
 * When the send of this letter started (0: it has not); a restart that finds it set
 * cannot know whether the server took the letter.
 */
sending_started: number, created: number, 
/**
 * Remind about a missing answer this long after sending; 0 for no reminder.
 */
followup_secs: number, 
/**
 * The rest of that wait.
 */
followup: FollowupPlan, };

export type Outgoing = { act: Act, 
/**
 * When it leaves.
 */
at: number, 
/**
 * It takes the letter to wait for a reply when it leaves.
 */
park: boolean, 
/**
 * Sent later at a time of the user's, not after the undo delay: nothing is done yet.
 */
scheduled: boolean, };

export type OutgoingAttachment = { name: string, mime: string, data: string, };

export type Owner = { "kind": "mine" } | { "kind": "shared" } | { "kind": "other", "name": string };

export type Pin = { id: number, unread: boolean, flagged: boolean, };

export type Quota = { 
/**
 * The root's name, `User quota` on Dovecot; may be empty.
 */
root: string, 
/**
 * Bytes taken (STORAGE is counted in units of 1024 octets).
 */
used: number, 
/**
 * Bytes allowed; 0 when the root limits no storage.
 */
limit: number, 
/**
 * Messages, and how many are allowed, when the root limits them (MESSAGE).
 */
messages?: [number, number] | null, };

export type QuotaSeen = { checked: number, 
/**
 * The root's name, `User quota` on Dovecot; may be empty.
 */
root: string, 
/**
 * Bytes taken (STORAGE is counted in units of 1024 octets).
 */
used: number, 
/**
 * Bytes allowed; 0 when the root limits no storage.
 */
limit: number, 
/**
 * Messages, and how many are allowed, when the root limits them (MESSAGE).
 */
messages?: [number, number] | null, };

export type QuotaView = { account_id: string, quota: QuotaSeen | null, 
/**
 * The folders counted, in bytes; `partial` when some could not be.
 */
estimate: Estimate | null, };

export type Rights = { lookup: boolean, read: boolean, seen: boolean, write: boolean, insert: boolean, post: boolean, create_child: boolean, delete_folder: boolean, delete_messages: boolean, expunge: boolean, administer: boolean, 
/**
 * A right the server named that Depesha does not know (shown in the details only).
 */
other: boolean, };

export type SearchTotals = { count: number, size: number, };

export type Security = "tls" | "starttls" | "plain";

export type ServerCaps = { 
/**
 * The greeting's line when it listed capabilities before login; empty otherwise.
 */
greeting: string, capabilities: Array<string>, 
/**
 * When they were read, Unix time.
 */
detected: number, };

export type ServerConfig = { host: string, port: number, security: Security, 
/**
 * SHA-256 of a certificate the user explicitly trusted for this server.
 */
trusted_cert?: string | null, };

export type ServerInfo = { caps: ServerCaps | null, enable: EnableAnswer | null, quota: QuotaSeen | null, sizes: FolderSizes | null, };

export type ServerView = { 
/**
 * The account's mail kept whole on this computer: not on the server, not in the quota.
 */
cache_bytes: number, 
/**
 * How often INBOX is checked on a server without IDLE.
 */
poll_secs: number, 
/**
 * A folder size count under way: folders done and all of them.
 */
counting: [number, number] | null, 
/**
 * The namespaces the server named (RFC 2342); empty when unknown.
 */
namespaces: NamespaceInfo, 
/**
 * Every folder's props the cache has, for the "Folders" subsection.
 */
folders: Array<FolderProps>, caps: ServerCaps | null, enable: EnableAnswer | null, quota: QuotaSeen | null, sizes: FolderSizes | null, };

export type Settings = { 
/**
 * A sent message waits this long in the outbox so it can be taken back.
 */
undo_send_secs: number, 
/**
 * `people` (default), `all` or `none`.
 */
notify: "people" | "all" | "none", 
/**
 * Do not disturb until this Unix time; 0 when off.
 */
dnd_until: number, 
/**
 * Group the list into conversations.
 */
threads: boolean, 
/**
 * A round picture of the sender at the left of every row of the list (#108): a logo, a
 * photo or initials. Only the look of the list; the letter has its own always.
 */
list_avatars: boolean, templates: Array<Template>, 
/**
 * `auto` (default), `notify` or `off`, like OpenCode's `autoupdate`.
 */
updates: "auto" | "notify" | "off", 
/**
 * `auto` (from the system locale, default), `en` or `ru`.
 */
language: "auto" | "en" | "ru", 
/**
 * `system` (light or dark as the system says, default), `paper`, `night`,
 * `snow` or `graphite`.
 */
theme: "system" | "paper" | "night" | "snow" | "graphite", 
/**
 * Built-in plugins switched off, by id (`plugins/<id>`).
 */
disabled_plugins: Array<string>, 
/**
 * Built-in plugins the user switched on, by id; only those off by default
 * (`PluginManifest::default_off`) use it.
 */
enabled_plugins: Array<string>, 
/**
 * Settings of built-in plugins, by plugin id; each plugin owns its object.
 */
plugin_settings: Record<string, Record<string, unknown>>, 
/**
 * The user's keys of commands (Settings → Keys); only what differs from the defaults.
 */
keybindings: KeySettings, 
/**
 * Installed extensions switched off, by id.
 */
disabled_extensions: Array<string>, 
/**
 * The user's own OAuth clients; they win over the ones built into the app.
 */
oauth_clients: { [key in OAuthProvider]?: OAuthClient }, 
/**
 * Mail downloaded whole for reading without a network and for searching its
 * text: `off`, the last `30` (default), `90` or `365` days, or `all`.
 */
offline: "off" | "30" | "90" | "365" | "all", 
/**
 * Offline download takes messages with attachments too.
 */
offline_attachments: boolean, 
/**
 * Brand logos published with BIMI next to mail that passed DMARC: a DNS
 * lookup and a download from the brand's site, once a week per domain, in the list
 * and in the letter. Off, no lookup is made anywhere (#108).
 */
sender_logos: boolean, 
/**
 * Where attachments are saved without asking; empty asks every time.
 * A mailbox may have its own (`Account::attachments_dir`).
 */
attachments_dir: string, 
/**
 * The order of lists without one of their own; newest first when empty.
 */
list_sort: Array<SortKey>, 
/**
 * Lists ordered their own way, by view key (`folder:<account>:<name>`, `unified:inbox`…).
 */
view_sorts: { [key in string]: Array<SortKey> }, 
/**
 * What counts as a large letter in the ready-made searches (Settings → General → Search), megabytes.
 */
large_mb: number, 
/**
 * A picture put into a letter's text (HTML or Markdown) is drawn no wider than this on
 * its long side, pixels (decision on #45): a 4K photo is megabytes otherwise.
 */
image_max_px: number, 
/**
 * How new letters are written; a mailbox may have its own (`Account::compose_format`).
 * A new install writes HTML; one set up before the choice existed goes on with plain text.
 */
compose_format: BodyFormat, 
/**
 * Which form of a letter the reader shows: `sender` (the one the sender put last,
 * default), `markdown` or `text` when the letter has it. A letter's switch overrides it.
 */
letter_view: "sender" | "html" | "markdown" | "text", 
/**
 * Which mailbox new letters are written from; none follows the context (the open
 * folder or letter, else the first mailbox). Answers and forwards are unaffected.
 */
default_account_id: string | null, 
/**
 * Warn when a mailbox fills up: at the two levels, in percent, and when full.
 * The same for every mailbox; a mailbox may set its own limit (`Account::quota_limit_mb`).
 */
quota_warn: boolean, quota_levels: [number, number], 
/**
 * `threshold`: once per level crossed (default); `daily`: again every day while above.
 */
quota_repeat: "threshold" | "daily", 
/**
 * What closing the main window does: `ask` (default, every install asks once),
 * `background` (the window hides, mail keeps coming) or `quit`.
 */
close_action: "ask" | "background" | "quit", 
/**
 * The user agreed to work in the background with no tray icon to come back by.
 */
background_without_tray: boolean, 
/**
 * Start at login: `off` (default), `window` or `background` (only the tray icon).
 */
autostart: "off" | "window" | "background", 
/**
 * The number of unread letters in the inboxes drawn on the tray icon.
 */
tray_count: boolean, 
/**
 * The tray icon stays while the window is open; otherwise it shows only in the background.
 */
tray_always: boolean, 
/**
 * The suggestions of 0.7 (#69): the one switch that turns every one of them off.
 */
hints: boolean, 
/**
 * The note about the three parts of a Markdown letter in the format menu (#103): `false`
 * once the user closed it; Settings → Look → Hints brings it back.
 */
markdown_parts_note: boolean, 
/**
 * When the day begins for «Snooze» (#95), `H:MM`: «Tomorrow» and the working days point here.
 */
day_start: string, 
/**
 * When the evening begins for «Snooze», `H:MM`: «This evening» points here.
 */
evening_start: string, 
/**
 * Working days for «Snooze», ISO: 1 Monday … 7 Sunday. Empty means none.
 */
work_days: Array<number>, };

export type Signature = { id: string, name: string, 
/**
 * The signature in an HTML letter. Its pictures are inside as `data:` images: they
 * live here, with the mailbox's settings, and the file one came from is not needed.
 */
html: string, 
/**
 * What a letter in plain text or Markdown gets under "-- ": the text and the links
 * with their addresses, no pictures. Made from `html` when the signature is saved.
 */
text: string, };

export type SizeMethod = "status" | "fetch";

export type Snooze = { account_id: string, message_id: string, folder: string, return_to: string, until: number, subject: string, };

export type SortField = "date" | "unread" | "flagged" | "people" | "sender" | "subject" | "size" | "attachments" | "relevance";

export type SortKey = { by: SortField, desc: boolean, };

export type StuckCopy = { id: number, account_id: string, subject: string, last_error: string | null, refusals: number, 
/**
 * The server has the copy: what failed is the local finish of the letter.
 */
filed: boolean, };

export type Summary = { message_id: string | null, in_reply_to: string | null, references: Array<string>, subject: string, from: Addr | null, to: Array<Addr>, cc: Array<Addr>, reply_to: Array<Addr>, date: number | null, has_attachments: boolean, 
/**
 * Written by a program, not a person: a mailing list, newsletter or notification.
 */
bulk: boolean, unsubscribe: Unsubscribe | null, 
/**
 * Exchange's `Thread-Index`: links a conversation when `References` is missing.
 */
thread_index: string | null, 
/**
 * The receiving server checked DMARC and it passed for the From domain (#108): a
 * brand logo may stand next to the sender in the list. Only `parse_summary_for`
 * knows the receiver; a summary read without one never says yes.
 */
dmarc: boolean, 
/**
 * `Importance`, `X-Priority`, `X-MSMail-Priority` or `Priority` of the letter (#72).
 */
importance: Importance, };

export type Task = { key: string, kind: TaskKind, account_id?: string | null, label: string, done: number, 
/**
 * 0 when unknown.
 */
total: number, state: TaskState, error?: CmdError | null, started: number, };

export type TaskKind = "sync" | "prefetch" | "older" | "search" | "send" | "sizes" | "labels" | "stuck-copy" | "empty" | "waiting";

export type TaskState = "running" | "failed";

export type Template = { name: string, text: string, };

export type Unsubscribe = { 
/**
 * HTTPS address that unsubscribes on a POST without visiting a page (RFC 8058).
 */
one_click: string | null, http: string | null, mailto: string | null, };

export type UnsubscribePlan = { way: UnsubscribeWay, 
/**
 * The mailbox a request by mail leaves from.
 */
from: string, 
/**
 * A request by mail goes to another organization than the letter's sender.
 */
foreign: boolean, };

export type UnsubscribeWay = { "kind": "one-click", host: string, } | { "kind": "mail", to: string, subject: string, text: string, } | { "kind": "link", url: string, };

export type Unsubscribed = { "kind": "done" } | { "kind": "mail-sent", to: string, } | { "kind": "confirm", plan: UnsubscribePlan, reason: string, };

export type UpdateState = "idle" | "checking" | "available" | "downloading" | "ready" | "installed" | "error";

export type UpdateStatus = { current: string, state: UpdateState, version: string | null, notes: string | null, error: string | null, install: Install, };

export type Voice = { from: Addr, dmarc: boolean, 
/**
 * The letter of theirs the verdict is from: a logo is asked about by it (the backend
 * reads the verdict and the folder itself).
 */
id: number, };

export type Waiting = { 
/**
 * An answer to a letter of the inbox takes it to the folder until a reply comes.
 */
park: boolean, 
/**
 * The folder, as the cache names it; empty: "Waiting for reply", made at the first answer.
 */
folder: string, 
/**
 * "Stop waiting" takes the letters to the archive instead of back to the inbox.
 */
stop_to_archive: boolean, };

