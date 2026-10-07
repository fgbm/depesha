use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use depesha_core::account::{self, Account, AuthMethod, Credentials, OAuthProvider, ServerConfig};
use depesha_core::autodetect::{self, Detection};
use depesha_core::avatar::Receiver;
use depesha_core::ews::{self, EwsDetection};
use depesha_core::imap::{FlagChange, FolderRole};
use depesha_core::message::{self, Addr, MessageView, Unsubscribe};
use depesha_core::query::SearchQuery;
use depesha_core::smtp::{self, ActsOn, BodyFormat, Draft, OutgoingAttachment};
use depesha_core::store::{
    FolderInfo, FollowupPlan, HintCount, HintState, ListQuery, MessageRow, OutboxItem, Person, SearchTotals, Snooze,
    SortKey,
};
use depesha_core::unsubscribe::Way;
use depesha_core::{Error, avatar, mail, oauth};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::config::Settings;
use crate::error::{CmdError, CmdResult};
use crate::paths::Use;
use crate::secrets;
use crate::state::{AccountStatus, AppState};
use crate::worker::{self, Output, Work};
use depesha_core::lang::pick;
use depesha_core::tr;

type St<'a> = State<'a, Arc<AppState>>;

/// Total size of attachments in one message.
const MAX_ATTACHMENTS: u64 = 50 * 1024 * 1024;

#[derive(Serialize)]
pub struct AccountView {
    #[serde(flatten)]
    account: Account,
    status: Option<AccountStatus>,
}

#[tauri::command]
pub fn accounts(state: St<'_>) -> Vec<AccountView> {
    state
        .accounts()
        .into_iter()
        .map(|a| AccountView {
            status: state.status(&a.id),
            account: a,
        })
        .collect()
}

#[tauri::command]
pub async fn detect(email: String) -> Detection {
    autodetect::detect(&email).await
}

/// Logs in to IMAP and SMTP (or EWS) with the given settings; nothing is saved.
/// `grant` is a browser sign-in from `oauth_sign_in` for an account not saved yet.
#[tauri::command]
pub async fn account_check(
    state: St<'_>,
    account: Account,
    password: Option<String>,
    grant: Option<String>,
) -> CmdResult<()> {
    let creds = match (&account.auth, grant) {
        (AuthMethod::OAuth { .. }, Some(grant)) => {
            let token = state
                .grants
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&grant)
                .map(|g| g.tokens.access_token.clone())
                .ok_or_else(sign_in_again)?;
            Credentials::oauth(account.username.clone(), token)
        }
        (AuthMethod::OAuth { .. }, None) => state.credentials(&account).await?,
        (AuthMethod::Password, _) => {
            let password = match password.filter(|p| !p.is_empty()) {
                Some(p) => p,
                None => secrets::get(&account.id)
                    .await?
                    .ok_or_else(|| CmdError::new("auth", tr!("enter the password", "введите пароль")))?,
            };
            Credentials::new(account.username.clone(), password)
        }
    };
    mail::check(&account, &creds)
        .await
        .map_err(|(proto, e)| prefix(proto, e))
}

fn sign_in_again() -> CmdError {
    CmdError::new(
        "auth",
        tr!(
            "the sign-in has expired, sign in again",
            "вход устарел, войдите ещё раз"
        ),
    )
}

fn prefix(proto: &str, e: depesha_core::Error) -> CmdError {
    let mut err = CmdError::from(e);
    err.message = format!("{proto}: {}", err.message);
    err
}

/// The order of the mailboxes in the sidebar and wherever they are listed.
#[tauri::command]
pub fn accounts_arrange(state: St<'_>, ids: Vec<String>) -> CmdResult<()> {
    state.arrange_accounts(&ids)
}

/// How the mailbox is shown: its name in the app and its colour. Login data stays as is.
#[tauri::command]
pub fn account_look(state: St<'_>, id: String, label: String, color: String) -> CmdResult<()> {
    let mut account = state.account(&id)?;
    account.label = label.trim().to_owned();
    let color = color.trim();
    // Only `#rrggbb`: the value ends up in CSS.
    account.color = if color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit()) {
        color.to_ascii_lowercase()
    } else {
        String::new()
    };
    state.save_account(account)
}

#[tauri::command]
pub async fn account_save(
    state: St<'_>,
    mut account: Account,
    password: Option<String>,
    grant: Option<String>,
) -> CmdResult<Account> {
    if account.id.is_empty() {
        account.id = format!(
            "{}-{}",
            account.email.to_lowercase(),
            chrono::Utc::now().timestamp_millis()
        );
        // Gmail and Exchange Web Services put sent mail into Sent themselves.
        account.save_sent_copy = !account.imap.host.ends_with("gmail.com") && !account.is_ews();
    }
    if account.display_name.trim().is_empty() {
        account.display_name = account.email.clone();
    }
    // The default is one of the mailbox's signatures, or none; and so does the reply one,
    // which falls back to the default when it is not set.
    if !account
        .signatures
        .iter()
        .any(|s| account.default_signature.as_deref() == Some(s.id.as_str()))
    {
        account.default_signature = None;
    }
    if !account
        .signatures
        .iter()
        .any(|s| account.reply_signature.as_deref() == Some(s.id.as_str()))
    {
        account.reply_signature = None;
    }
    let before = state
        .accounts()
        .into_iter()
        .find(|a| a.id == account.id)
        .map(|a| a.attachments_dir)
        .unwrap_or_default();
    check_save_folder(&state, &before, &account.attachments_dir)?;
    let grant = grant.and_then(|g| state.grants.lock().unwrap_or_else(|e| e.into_inner()).remove(&g));
    match (&account.auth, grant) {
        (AuthMethod::OAuth { .. }, Some(grant)) => {
            secrets::set(&account.id, grant.tokens.refresh_token.clone()).await?;
            state.tokens.lock().unwrap_or_else(|e| e.into_inner()).insert(
                account.id.clone(),
                (grant.tokens.access_token.clone(), grant.tokens.expires_at),
            );
        }
        (AuthMethod::OAuth { .. }, None) => {}
        (AuthMethod::Password, _) => {
            state.forget_token(&account.id);
            if let Some(p) = password.filter(|p| !p.is_empty()) {
                secrets::set(&account.id, p).await?;
            }
        }
    }
    state.save_account(account.clone())?;
    let worker = worker::spawn(state.inner().clone(), account.clone());
    state.set_worker(&account.id, Some(worker));
    Ok(account)
}

#[tauri::command]
pub async fn account_remove(state: St<'_>, id: String) -> CmdResult<()> {
    state.set_worker(&id, None);
    state.tasks_forget_account(&id);
    // The cache first: while the account is in the settings, a failed removal can be
    // repeated; after that nothing would remove its leftovers.
    state.store.forget_account(&id)?;
    state.remove_account(&id)?;
    // The removed mailbox cannot be the default any more: a stale id would leave the
    // settings with nothing to show and would live on through every save.
    let mut settings = state.settings();
    if settings.default_account_id.as_deref() == Some(id.as_str()) {
        settings.default_account_id = None;
        state.save_settings(settings)?;
        state.emit("settings-changed", serde_json::json!({}));
    }
    state.forget_token(&id);
    secrets::delete(&id).await?;
    Ok(())
}

#[derive(Serialize)]
pub struct OAuthProviderView {
    provider: OAuthProvider,
    title: &'static str,
    /// A client is built in or set by the user.
    configured: bool,
}

#[tauri::command]
pub fn oauth_providers(state: St<'_>) -> Vec<OAuthProviderView> {
    let settings = state.settings();
    OAuthProvider::ALL
        .into_iter()
        .map(|p| OAuthProviderView {
            provider: p,
            title: p.title(),
            configured: settings.oauth_client(p).is_some(),
        })
        .collect()
}

/// A finished browser sign-in; `id` is passed to `account_check` and `account_save`.
#[derive(Serialize)]
pub struct OAuthGrantView {
    id: String,
    provider: OAuthProvider,
    email: String,
    name: Option<String>,
    imap: ServerConfig,
    smtp: ServerConfig,
}

/// Opens the provider's sign-in page in the browser and waits for it to come back.
#[tauri::command]
pub async fn oauth_sign_in(
    state: St<'_>,
    provider: OAuthProvider,
    login_hint: Option<String>,
) -> CmdResult<OAuthGrantView> {
    let client = state
        .settings()
        .oauth_client(provider)
        .ok_or_else(|| oauth::not_configured(provider))?;
    let app = state.app.clone();
    let open = move |url: &str| {
        app.opener().open_url(url, None::<&str>).map_err(|e| {
            depesha_core::Error::Protocol(tr!(
                "could not open the browser: {e}",
                "не удалось открыть браузер: {e}"
            ))
        })
    };
    // Listening from the start: a cancel that comes while the browser opens is not lost
    // (notify_waiters wakes only the waiters already there).
    let cancel = state.oauth_cancel.notified();
    tokio::pin!(cancel);
    cancel.as_mut().enable();
    let grant = oauth::sign_in(provider, &client, login_hint.as_deref(), open, cancel).await?;
    let id = format!("{}-{}", provider.as_str(), chrono::Utc::now().timestamp_millis());
    let (imap, smtp) = provider.servers();
    let view = OAuthGrantView {
        id: id.clone(),
        provider,
        email: grant.email.clone(),
        name: grant.name.clone(),
        imap,
        smtp,
    };
    state.grants.lock().unwrap_or_else(|e| e.into_inner()).insert(id, grant);
    Ok(view)
}

#[tauri::command]
pub fn oauth_cancel(state: St<'_>) {
    state.oauth_cancel.notify_waiters();
}

/// Finds the EWS address of an Exchange mailbox (Autodiscover needs the login).
#[tauri::command]
pub async fn exchange_detect(
    email: String,
    username: String,
    password: String,
    server: Option<String>,
) -> EwsDetection {
    let creds = Credentials::new(username, password);
    ews::discover(email.trim(), &creds, server.as_deref().filter(|s| !s.trim().is_empty())).await
}

// Commands that read the cache run off the main thread (`async`): while a sync holds
// the database, the window must keep drawing and taking input.
#[tauri::command(async)]
pub fn folders(state: St<'_>, account_id: Option<String>) -> CmdResult<Vec<FolderInfo>> {
    Ok(state.store.folders(account_id.as_deref())?)
}

#[tauri::command(async)]
pub fn messages(state: St<'_>, query: ListQuery) -> CmdResult<Vec<MessageRow>> {
    Ok(state.store.list(&query)?)
}

/// The mailbox a search looks in: the one `account:` names, else the one asked for, or
/// every mailbox. `None` when `account:` names no mailbox: nothing is found.
fn search_scope(state: &AppState, text: &str, account_id: Option<String>) -> Option<Option<String>> {
    match SearchQuery::parse(text).account {
        Some(name) => account::find(&state.accounts(), &name).map(|a| Some(a.id.clone())),
        None => Some(account_id),
    }
}

#[tauri::command(async)]
pub fn search(
    state: St<'_>,
    text: String,
    account_id: Option<String>,
    sort: Option<Vec<SortKey>>,
) -> CmdResult<Vec<MessageRow>> {
    let Some(account_id) = search_scope(&state, &text, account_id) else {
        return Ok(Vec::new());
    };
    Ok(state
        .store
        .search(&text, account_id.as_deref(), 300, &sort.unwrap_or_default())?)
}

/// How many letters the search finds in the cache and their size, the shown ones and the rest.
#[tauri::command(async)]
pub fn search_totals(state: St<'_>, text: String, account_id: Option<String>) -> CmdResult<SearchTotals> {
    let Some(account_id) = search_scope(&state, &text, account_id) else {
        return Ok(SearchTotals::default());
    };
    Ok(state.store.search_totals(&text, account_id.as_deref())?)
}

/// Searches on the servers: inbox, sent and archive of every account (or one account).
/// Finds mail older than the local cache window. Errors of single folders are skipped.
#[tauri::command]
pub async fn server_search(state: St<'_>, text: String, account_id: Option<String>) -> CmdResult<Vec<MessageRow>> {
    let label = tr!("Search on the server: «{text}»", "Поиск на сервере: «{text}»");
    state.task("search", "search", account_id.as_deref(), label, 0, 0);
    let result = search_servers(&state, &text, account_id).await;
    match &result {
        Ok(_) => state.task_done("search"),
        Err(e) => state.task_failed("search", e.clone()),
    }
    result
}

/// The folders a server search goes into: the one `in:` names (with `in:X/*`, its
/// subfolders too), else the inbox, sent and archive of the mailbox. Names come from the
/// cache, so `in:X/*` with an X the cache does not have finds nothing.
fn search_folders(q: &SearchQuery, account_folders: &[FolderInfo]) -> Vec<String> {
    let role = |word: &str| match word.to_lowercase().as_str() {
        "inbox" | "входящие" => Some(FolderRole::Inbox),
        "sent" | "отправленные" => Some(FolderRole::Sent),
        "drafts" | "черновики" => Some(FolderRole::Drafts),
        "archive" | "архив" => Some(FolderRole::Archive),
        "trash" | "корзина" => Some(FolderRole::Trash),
        "spam" | "junk" | "спам" => Some(FolderRole::Junk),
        "snoozed" | "отложенные" => Some(FolderRole::Snoozed),
        _ => None,
    };
    let by_name = |want: &str| {
        let lower = want.to_lowercase();
        account_folders
            .iter()
            .find(|f| f.folder.name.to_lowercase() == lower || f.folder.display_name.to_lowercase() == lower)
    };
    if let Some(want) = &q.folder {
        let name = by_name(want)
            .or_else(|| role(want).and_then(|r| account_folders.iter().find(|f| f.folder.role == Some(r))))
            .map(|f| f.folder.name.clone());
        let Some(name) = name else {
            return Vec::new();
        };
        let mut out = vec![name.clone()];
        if q.subfolders {
            let prefix = account_folders
                .iter()
                .find(|f| f.folder.name == name)
                .and_then(|f| f.folder.delimiter.as_deref())
                .filter(|d| !d.is_empty())
                .map(|d| format!("{name}{d}"));
            if let Some(prefix) = prefix {
                out.extend(
                    account_folders
                        .iter()
                        .filter(|f| f.folder.name.starts_with(&prefix))
                        .map(|f| f.folder.name.clone()),
                );
            }
        }
        return out;
    }
    [FolderRole::Inbox, FolderRole::Sent, FolderRole::Archive]
        .iter()
        .filter_map(|r| account_folders.iter().find(|f| f.folder.role == Some(*r)))
        .map(|f| f.folder.name.clone())
        .collect()
}

async fn search_servers(state: &AppState, text: &str, account_id: Option<String>) -> CmdResult<Vec<MessageRow>> {
    let Some(account_id) = search_scope(state, text, account_id) else {
        return Ok(Vec::new());
    };
    let accounts = match account_id {
        Some(id) => vec![state.account(&id)?],
        None => state.accounts(),
    };
    let query = SearchQuery::parse(text);
    let mut rows = Vec::new();
    let mut last_err = None;
    for account in accounts {
        let worker = state.worker(&account.id)?;
        let cache = state.store.folders(Some(&account.id))?;
        for folder in search_folders(&query, &cache) {
            match worker
                .run(Work::Search {
                    folder,
                    text: text.to_owned(),
                })
                .await
            {
                Ok(Output::Ids(ids)) => {
                    for id in ids {
                        if let Some(r) = state.store.get(id)? {
                            rows.push(r);
                        }
                    }
                }
                Ok(_) => {}
                Err(e) => last_err = Some(e),
            }
        }
    }
    if rows.is_empty()
        && let Some(e) = last_err
    {
        return Err(e.into());
    }
    rows.sort_by_key(|r| std::cmp::Reverse(r.date));
    Ok(rows)
}

#[derive(Serialize)]
pub struct OpenedMessage {
    row: MessageRow,
    view: MessageView,
    trusted_sender: bool,
    /// The From address is on the trusted list, but the receiving server does not vouch
    /// that this letter is really from it: its pictures stay hidden.
    sender_unverified: bool,
}

async fn raw_of(state: &AppState, row: &MessageRow) -> CmdResult<Vec<u8>> {
    // Already downloaded mail opens without the network.
    if let Some(raw) = state.store.body(row.id)? {
        return Ok(raw);
    }
    match state.worker(&row.account_id)?.run(Work::LoadBody(row.id)).await? {
        Output::Body(raw) => Ok(raw),
        _ => Err(CmdError::new(
            "other",
            tr!("the server did not return the message", "сервер не вернул письмо"),
        )),
    }
}

fn row(state: &AppState, id: i64) -> CmdResult<MessageRow> {
    state.store.get(id)?.ok_or_else(gone)
}

pub(crate) fn gone() -> CmdError {
    CmdError::new(
        "not-found",
        tr!("the message was deleted or moved", "письмо уже удалено или перемещено"),
    )
}

#[tauri::command]
pub async fn message_open(state: St<'_>, id: i64, allow_remote: bool) -> CmdResult<OpenedMessage> {
    let row = row(&state, id)?;
    let raw = raw_of(&state, &row).await?;
    let sender = row.from.as_ref().map(|a| a.email.clone()).unwrap_or_default();
    let listed = !sender.is_empty() && state.store.is_trusted_sender(&sender)?;
    // Anyone can write a trusted address into From: the trust holds only for a sender
    // the receiving server vouches for.
    let auth = message::authenticity(&raw, &Receiver::of(&state.account(&row.account_id)?));
    let trusted_sender = listed && auth.verified();
    let mut view = message::parse_view(&raw, allow_remote || trusted_sender)?;
    view.authenticated = auth.dmarc;
    // Back from waiting with the reply: read now, the list no longer says so.
    if let Some(mid) = &row.message_id
        && state.store.followup_noticed(&row.account_id, mid)?
    {
        state.emit(
            "mail-changed",
            serde_json::json!({ "account_id": row.account_id, "folder": row.folder }),
        );
    }
    Ok(OpenedMessage {
        row,
        view,
        trusted_sender,
        sender_unverified: listed && !trusted_sender,
    })
}

/// Message rows by (account, folder, UIDVALIDITY) for server operations: the worker
/// refuses UIDs of a folder renumbered since they were read.
fn group_rows(state: &AppState, ids: &[i64]) -> CmdResult<BTreeMap<(String, String, u32), Vec<MessageRow>>> {
    let mut groups: BTreeMap<(String, String, u32), Vec<MessageRow>> = BTreeMap::new();
    for (r, validity) in state.store.get_many_at(ids)? {
        groups
            .entry((r.account_id.clone(), r.folder.clone(), validity))
            .or_default()
            .push(r);
    }
    Ok(groups)
}

/// What a move did, so it can be undone. Messages are found again by Message-ID.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Moved {
    account_id: String,
    from: String,
    to: String,
    message_ids: Vec<String>,
}

async fn move_group(
    state: &AppState,
    (account_id, from, validity): &(String, String, u32),
    rows: &[MessageRow],
    to: &str,
) -> CmdResult<Moved> {
    state
        .worker(account_id)?
        .run(Work::Move {
            from: from.to_owned(),
            validity: *validity,
            uids: rows.iter().map(|r| r.uid).collect(),
            to: to.to_owned(),
        })
        .await?;
    let message_ids: Vec<String> = rows.iter().filter_map(|r| r.message_id.clone()).collect();
    // "Done" or a move out of "Waiting for reply": the wait is over, the reply brings nothing back.
    if state
        .store
        .followups_left(account_id, from, &message_ids, chrono::Utc::now().timestamp())?
        > 0
    {
        state.emit("counters-changed", serde_json::json!({}));
    }
    Ok(Moved {
        account_id: account_id.to_owned(),
        from: from.to_owned(),
        to: to.to_owned(),
        message_ids,
    })
}

/// Creates a folder on the server, inside `parent` (a folder name as the cache keeps it)
/// or at the top.
#[tauri::command]
pub async fn folder_create(state: St<'_>, account_id: String, parent: Option<String>, name: String) -> CmdResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CmdError::new(
            "other",
            tr!("the folder needs a name", "у папки должно быть имя"),
        ));
    }
    let account = state.account(&account_id)?;
    let full = match parent {
        Some(parent) => {
            let delimiter = state
                .store
                .folders(Some(&account_id))?
                .into_iter()
                .find(|f| f.folder.name == parent)
                .and_then(|f| f.folder.delimiter)
                .unwrap_or_else(|| "/".into());
            // IMAP names are kept in modified UTF-7, and creating encodes the whole path again.
            let parent = if account.is_ews() {
                parent
            } else {
                depesha_core::utf7::decode(&parent)
            };
            format!("{parent}{delimiter}{name}")
        }
        None => name.to_owned(),
    };
    state.worker(&account_id)?.run(Work::CreateFolder(full)).await?;
    Ok(())
}

/// The folder with this role, created under `name` when the server has none.
async fn role_folder(state: &AppState, account_id: &str, role: FolderRole, name: &str) -> CmdResult<String> {
    if let Some(f) = state.store.folder_by_role(account_id, role)? {
        return Ok(f);
    }
    state
        .worker(account_id)?
        .run(Work::CreateFolder(name.to_owned()))
        .await?;
    state.store.folder_by_role(account_id, role)?.ok_or_else(|| {
        CmdError::new(
            "not-found",
            tr!(
                "could not create the folder “{name}” on the server",
                "не удалось создать папку «{name}» на сервере"
            ),
        )
    })
}

#[tauri::command]
pub async fn set_flag(state: St<'_>, ids: Vec<i64>, change: FlagChange) -> CmdResult<()> {
    for ((account_id, folder, validity), rows) in group_rows(&state, &ids)? {
        let worker = state.worker(&account_id)?;
        let uids: Vec<u32> = rows.iter().map(|r| r.uid).collect();
        // A read mark in a folder with no right to keep it, or one where the server
        // refused, is kept only here: no request, no refusal (#42, frame 7, note 2).
        if let FlagChange::Seen(value) = change
            && local_seen_folder(&state, &account_id, &folder)
        {
            let at = chrono::Utc::now().timestamp();
            if value {
                state.store.set_local_seen(&account_id, &folder, &uids, at)?;
            } else {
                state.store.clear_local_seen(&account_id, &folder, &uids)?;
            }
            // The list reacts at once; no request goes to the server, so no refusal comes back.
            state
                .store
                .change_flags(&account_id, &folder, &uids, FlagChange::Seen(value))?;
            state.store.settle_flags(&account_id, &folder, &uids);
            state.emit(
                "mail-changed",
                serde_json::json!({ "account_id": account_id, "folder": folder }),
            );
            continue;
        }
        let mut done = flag_group(&state, &worker, &account_id, &folder, validity, &uids, change).await;
        if matches!(done, Err(Error::FolderChanged)) {
            done = reflag(&state, &worker, &account_id, &folder, &rows, change).await;
        }
        if done.is_err() {
            // Refused or not sent: the list shows the server's state again.
            worker.kick(Work::SyncFolder(folder.clone()));
        }
        if let Err(e) = &done
            && e.no_rights()
        {
            // No rights in this folder: remembered, so the button turns off here alone (#42).
            state
                .store
                .refuse_folder(&account_id, &folder, "no-rights", chrono::Utc::now().timestamp())?;
            crate::server::changed(&state, &account_id);
        }
        if done.is_ok() {
            let _ = state.store.clear_refusal(&account_id, &folder);
        }
        done?;
    }
    Ok(())
}

/// Whether a read mark must be kept only here: the folder is known to be read-only
/// without the `s` right, or the server refused an action in it (#42, frame 7, note 2).
fn local_seen_folder(state: &AppState, account_id: &str, folder: &str) -> bool {
    let Ok(Some(props)) = state.store.folder_prop(account_id, folder) else {
        return false;
    };
    if props.refused.is_some() {
        return true;
    }
    props.rights.is_some_and(|r| r.read && !r.seen)
}

/// Checks own labels on a test message in `folder` (#42, frame 9). The test letter is
/// always deleted, also on a failure; the outcome is remembered for the folder.
#[tauri::command]
pub async fn label_check(
    state: St<'_>,
    account_id: String,
    folder: String,
) -> CmdResult<depesha_core::acl::LabelCheck> {
    let keyword = depesha_core::acl::keyword_of("depesha-test");
    // A fresh Message-ID every run, so a leftover from an interrupted check is not reused.
    let stamp = chrono::Utc::now().timestamp_millis();
    let message_id = format!("depesha-test-{stamp}@depesha.local");
    let subject = pick("Depesha: label check", "Депеша: проверка меток").to_owned();
    let worker = state.worker(&account_id)?;
    let out = worker
        .run(Work::CheckLabels {
            folder: folder.clone(),
            keyword,
            message_id,
            subject,
        })
        .await?;
    let Output::LabelCheck(check) = out else {
        return Err(CmdError::new(
            "other",
            pick("the label check gave no answer", "проверка меток не дала ответа"),
        ));
    };
    state
        .store
        .set_label_check(&account_id, &folder, Some(check), chrono::Utc::now().timestamp())?;
    // A check that ended well also tells whether labels are kept: the props follow.
    crate::server::changed(&state, &account_id);
    Ok(check)
}

/// The account's labels, with the keyword each stores on the server.
#[tauri::command]
pub fn labels(state: St<'_>, account_id: String) -> CmdResult<Vec<depesha_core::acl::Label>> {
    Ok(state.store.labels(&account_id)?)
}

/// A new label; its keyword is made from the name. Renaming keeps the old keyword, so
/// letters already tagged stay tagged.
#[tauri::command]
pub fn label_save(
    state: St<'_>,
    account_id: String,
    name: String,
    color: String,
) -> CmdResult<depesha_core::acl::Label> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CmdError::new(
            "input",
            tr!("a label needs a name", "у метки должно быть название"),
        ));
    }
    let is_ews = state.account(&account_id)?.ews.is_some();
    let label = depesha_core::acl::Label {
        name: name.to_owned(),
        // An IMAP label stores a keyword made from the name; an Exchange category is the
        // name itself. Renaming keeps the old keyword, so letters already tagged stay tagged.
        keyword: state.store.label_keyword(&account_id, name)?.unwrap_or_else(|| {
            if is_ews {
                name.to_owned()
            } else {
                depesha_core::acl::keyword_of(name)
            }
        }),
        color,
    };
    state.store.save_label(&account_id, &label)?;
    Ok(label)
}

#[tauri::command]
pub fn label_remove(state: St<'_>, account_id: String, name: String) -> CmdResult<()> {
    state.store.remove_label(&account_id, &name)?;
    Ok(())
}

/// Puts a label on rows or takes it off: an IMAP keyword, an Exchange category.
#[tauri::command]
pub async fn set_label(state: St<'_>, ids: Vec<i64>, name: String, value: bool) -> CmdResult<()> {
    for ((account_id, folder, validity), rows) in group_rows(&state, &ids)? {
        let Some(keyword) = state.store.label_keyword(&account_id, &name)? else {
            continue;
        };
        let label = depesha_core::acl::Label {
            name: name.clone(),
            keyword,
            color: String::new(),
        };
        let (add, remove) = if value {
            (vec![label], Vec::new())
        } else {
            (Vec::new(), vec![label])
        };
        let worker = state.worker(&account_id)?;
        let uids: Vec<u32> = rows.iter().map(|r| r.uid).collect();
        let done = worker
            .run(Work::SetLabels {
                folder: folder.clone(),
                validity,
                uids,
                add,
                remove,
            })
            .await;
        if done.is_err() {
            worker.kick(Work::SyncFolder(folder.clone()));
        }
        if let Err(e) = &done
            && e.no_rights()
        {
            // No rights in this folder: remembered, so the button turns off here alone (#42).
            state
                .store
                .refuse_folder(&account_id, &folder, "no-rights", chrono::Utc::now().timestamp())?;
            crate::server::changed(&state, &account_id);
        }
        if done.is_ok() {
            let _ = state.store.clear_refusal(&account_id, &folder);
        }
        done?;
    }
    Ok(())
}
#[tauri::command]
pub async fn folder_props(
    state: St<'_>,
    account_id: String,
    folder: String,
) -> CmdResult<depesha_core::acl::FolderProps> {
    let worker = state.worker(&account_id)?;
    let out = worker.run(Work::FolderProps(folder.clone())).await?;
    let Output::Props(props) = out else {
        return Err(CmdError::new(
            "other",
            tr!(
                "folder properties could not be read",
                "не удалось прочитать свойства папки"
            ),
        ));
    };
    // The old refusal stays until an action succeeds; a check alone does not clear it.
    let props = depesha_core::acl::FolderProps {
        refused: state.store.folder_prop(&account_id, &folder)?.and_then(|p| p.refused),
        ..props
    };
    state.store.save_folder_props(&account_id, &props)?;
    crate::server::changed(&state, &account_id);
    Ok(props)
}

async fn flag_group(
    state: &AppState,
    worker: &worker::Worker,
    account_id: &str,
    folder: &str,
    validity: u32,
    uids: &[u32],
    change: FlagChange,
) -> depesha_core::Result<()> {
    // Local first so the list reacts at once; syncs keep it until the server answers.
    state.store.change_flags(account_id, folder, uids, change)?;
    state.emit(
        "mail-changed",
        serde_json::json!({ "account_id": account_id, "folder": folder }),
    );
    let done = worker
        .run(Work::SetFlag {
            folder: folder.to_owned(),
            validity,
            uids: uids.to_vec(),
            change,
        })
        .await;
    state.store.settle_flags(account_id, folder, uids);
    if done.is_ok() {
        // The action went through: whatever refusal was remembered here is over (#42).
        let _ = state.store.clear_refusal(account_id, folder);
    }
    done.map(|_| ())
}

/// The server renumbered the folder before the flag was set: the same letters are
/// found by Message-ID in the folder synced anew and flagged there. A flag set twice
/// does no harm; moves and deletes are not repeated by such a guess.
async fn reflag(
    state: &AppState,
    worker: &worker::Worker,
    account_id: &str,
    folder: &str,
    rows: &[MessageRow],
    change: FlagChange,
) -> depesha_core::Result<()> {
    worker.run(Work::SyncFolder(folder.to_owned())).await?;
    let mut found: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    let mut missing = false;
    for r in rows {
        let again = match &r.message_id {
            Some(mid) => match state.store.find_by_message_id(account_id, folder, mid)? {
                Some(again) => state.store.get_at(again.id)?,
                None => None,
            },
            None => None,
        };
        match again {
            Some((again, validity)) => found.entry(validity).or_default().push(again.uid),
            None => missing = true,
        }
    }
    for (validity, uids) in found {
        flag_group(state, worker, account_id, folder, validity, &uids, change).await?;
    }
    // Letters without a Message-ID, or gone: the user sees that not all were changed.
    if missing {
        return Err(Error::FolderChanged);
    }
    Ok(())
}

#[tauri::command]
pub async fn move_messages(state: St<'_>, ids: Vec<i64>, to: String) -> CmdResult<Vec<Moved>> {
    let mut done = Vec::new();
    for (key, rows) in group_rows(&state, &ids)? {
        if key.1 != to {
            done.push(move_group(&state, &key, &rows, &to).await?);
        }
    }
    Ok(done)
}

/// "Done": out of the inbox into the archive, which is created if missing.
#[tauri::command]
pub async fn archive(state: St<'_>, ids: Vec<i64>) -> CmdResult<Vec<Moved>> {
    let mut done = Vec::new();
    for (key, rows) in group_rows(&state, &ids)? {
        let archive = role_folder(&state, &key.0, FolderRole::Archive, pick("Archive", "Архив")).await?;
        if key.1 != archive {
            done.push(move_group(&state, &key, &rows, &archive).await?);
        }
    }
    Ok(done)
}

/// Spam: into the junk folder; the server's filters learn from it on most systems.
#[tauri::command]
pub async fn mark_spam(state: St<'_>, ids: Vec<i64>) -> CmdResult<Vec<Moved>> {
    let mut done = Vec::new();
    for (key, rows) in group_rows(&state, &ids)? {
        let junk = role_folder(&state, &key.0, FolderRole::Junk, pick("Junk", "Спам")).await?;
        if key.1 != junk {
            done.push(move_group(&state, &key, &rows, &junk).await?);
        }
    }
    Ok(done)
}

/// To the trash; from the trash (or without one) for good, which cannot be undone.
#[tauri::command]
pub async fn delete_messages(state: St<'_>, ids: Vec<i64>) -> CmdResult<Vec<Moved>> {
    let mut done = Vec::new();
    for (key, rows) in group_rows(&state, &ids)? {
        let (account_id, folder, validity) = &key;
        match state.store.folder_by_role(account_id, FolderRole::Trash)? {
            Some(trash) if trash != *folder => done.push(move_group(&state, &key, &rows, &trash).await?),
            _ => {
                let uids = rows.iter().map(|r| r.uid).collect();
                state
                    .worker(account_id)?
                    .run(Work::Delete {
                        folder: folder.clone(),
                        validity: *validity,
                        uids,
                    })
                    .await?;
            }
        }
    }
    Ok(done)
}

/// Snoozes mail until `until`: it waits in the server's Snoozed folder (visible in
/// other clients too) and comes back unread. Messages without Message-ID cannot be tracked.
#[tauri::command]
pub async fn snooze(state: St<'_>, ids: Vec<i64>, until: i64) -> CmdResult<Vec<Moved>> {
    let mut done = Vec::new();
    for (key, rows) in group_rows(&state, &ids)? {
        let (account_id, folder, _) = &key;
        let rows: Vec<MessageRow> = rows.into_iter().filter(|r| r.message_id.is_some()).collect();
        if rows.is_empty() {
            return Err(CmdError::new(
                "other",
                tr!(
                    "the message has no Message-ID and cannot be snoozed",
                    "у письма нет Message-ID, отложить его нельзя"
                ),
            ));
        }
        let snoozed = role_folder(&state, account_id, FolderRole::Snoozed, pick("Snoozed", "Отложенные")).await?;
        // Snoozing again from the Snoozed folder keeps the original destination.
        for r in &rows {
            let mid = r.message_id.clone().unwrap_or_default();
            let return_to = state
                .store
                .snooze_remove(account_id, &mid)?
                .map(|s| s.return_to)
                .unwrap_or_else(|| folder.clone());
            state.store.snooze_add(&Snooze {
                account_id: account_id.clone(),
                message_id: mid,
                folder: snoozed.clone(),
                return_to: if return_to == snoozed {
                    folder.clone()
                } else {
                    return_to
                },
                until,
                subject: r.subject.clone(),
            })?;
        }
        if *folder != snoozed {
            done.push(move_group(&state, &key, &rows, &snoozed).await?);
        }
    }
    state.scheduler_notify.notify_one();
    state.emit("counters-changed", serde_json::json!({}));
    Ok(done)
}

/// Puts moved messages back where they were and forgets their snooze times.
#[tauri::command]
pub async fn undo(state: St<'_>, moved: Vec<Moved>) -> CmdResult<()> {
    let mut back = 0;
    for m in moved {
        for mid in &m.message_ids {
            state.store.snooze_remove(&m.account_id, mid)?;
        }
        let out = state
            .worker(&m.account_id)?
            .run(Work::MoveByMessageId {
                from: m.to,
                message_ids: m.message_ids,
                to: m.from,
                unseen: false,
            })
            .await?;
        if let Output::Count(n) = out {
            back += n;
        }
    }
    state.emit("counters-changed", serde_json::json!({}));
    // Nothing found where the action put it: say so instead of "undone".
    if back == 0 {
        return Err(CmdError::new(
            "not-found",
            tr!(
                "the messages were not found where they were moved; they may have been moved again",
                "письма не нашлись там, куда их перенесли: возможно, их уже переместили снова"
            ),
        ));
    }
    Ok(())
}

/// The whole conversation of a message, oldest first.
#[tauri::command(async)]
pub fn thread(state: St<'_>, id: i64) -> CmdResult<Vec<MessageRow>> {
    let r = row(&state, id)?;
    Ok(state.store.thread(&r.account_id, &r.thread)?)
}

#[derive(Serialize)]
pub struct Counters {
    snoozed: u32,
    /// Letters waiting for an answer: the badge.
    followups: u32,
    /// Waits kept after they ended: the view stays in the sidebar for them.
    followups_closed: u32,
}

#[tauri::command(async)]
pub fn counters(state: St<'_>) -> CmdResult<Counters> {
    let followups = state.store.followups_count()?;
    Ok(Counters {
        snoozed: state.store.snoozed_count(state.settings().threads)?,
        followups: followups.active,
        followups_closed: followups.closed,
    })
}

/// No answer yet and not now: the reminder comes again `secs` from now. With `deadline`
/// ("Set a new date", "Wait for a reply again") the answer is expected by then too, and a
/// wait that ended is waiting again for an answer from now on.
#[tauri::command(async)]
pub fn followup_postpone(state: St<'_>, id: i64, secs: i64, deadline: Option<bool>) -> CmdResult<i64> {
    let r = row(&state, id)?;
    let now = chrono::Utc::now().timestamp();
    let due = now + secs.max(60);
    let deadline = deadline.unwrap_or(false);
    if let Some(mid) = &r.message_id {
        state.store.followup_postpone(&r.account_id, mid, due, deadline)?;
        if deadline {
            state.store.followup_reopen(&r.account_id, mid, due, now)?;
        }
    }
    state.emit("counters-changed", serde_json::json!({}));
    Ok(due)
}

/// Stops waiting for an answer: the wait is closed by hand and kept in the history.
#[tauri::command(async)]
pub fn followup_cancel(state: St<'_>, id: i64) -> CmdResult<()> {
    let r = row(&state, id)?;
    if let Some(mid) = &r.message_id {
        let to = crate::waiting::stop_to(&state, &r.account_id);
        state
            .store
            .followup_stop(&r.account_id, mid, chrono::Utc::now().timestamp(), to.as_deref())?;
    }
    // Letters waiting in the folder go back.
    state.scheduler_notify.notify_one();
    state.emit("counters-changed", serde_json::json!({}));
    Ok(())
}

/// "Keep in the inbox" of the toast after an answer, and "z": the letters come back, and
/// the wait goes unless it has a reminder.
#[tauri::command(async)]
pub fn followup_unpark(state: St<'_>, account_id: String, message_id: String) -> CmdResult<()> {
    state.store.followup_unpark(&account_id, &message_id)?;
    state.scheduler_notify.notify_one();
    state.emit("counters-changed", serde_json::json!({}));
    Ok(())
}

/// "Back to the inbox" over a letter waiting in the folder: the wait is closed and its
/// letters come back.
#[tauri::command(async)]
pub fn followup_return(state: St<'_>, id: i64) -> CmdResult<()> {
    let r = row(&state, id)?;
    if let Some(mid) = &r.message_id {
        state
            .store
            .followup_stop(&r.account_id, mid, chrono::Utc::now().timestamp(), None)?;
    }
    state.scheduler_notify.notify_one();
    state.emit("counters-changed", serde_json::json!({}));
    Ok(())
}

/// How Depesha would leave a list, for the user to confirm before anything goes out.
#[derive(Serialize)]
pub struct UnsubscribePlan {
    way: Way,
    /// The mailbox a request by mail leaves from.
    from: String,
    /// A request by mail goes to another organization than the letter's sender.
    foreign: bool,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Unsubscribed {
    /// The sender's server confirmed the one-click request.
    Done,
    /// The confirmed request went out by mail through the outbox.
    MailSent { to: String },
    /// One click did not work; a request by mail is possible but needs its own confirmation.
    Confirm { plan: UnsubscribePlan, reason: String },
}

fn no_unsubscribe() -> CmdError {
    CmdError::new(
        "not-found",
        tr!(
            "the sender gave no way to unsubscribe",
            "отправитель не указал, как отписаться"
        ),
    )
}

fn unsubscribe_ways(state: &AppState, id: i64) -> CmdResult<(MessageRow, Unsubscribe, Vec<Way>)> {
    let r = row(state, id)?;
    let u = state.store.unsubscribe_of(id)?.ok_or_else(no_unsubscribe)?;
    let ways = depesha_core::unsubscribe::ways(&u);
    if ways.is_empty() {
        return Err(depesha_core::unsubscribe::no_way(&u).into());
    }
    Ok((r, u, ways))
}

fn plan_of(state: &AppState, r: &MessageRow, way: Way) -> CmdResult<UnsubscribePlan> {
    let from = state.account(&r.account_id)?.email;
    let foreign = match (&way, &r.from) {
        (Way::Mail { to, .. }, Some(sender)) => depesha_core::unsubscribe::foreign(to, &sender.email),
        (Way::Mail { .. }, None) => true,
        _ => false,
    };
    Ok(UnsubscribePlan { way, from, foreign })
}

/// The way a list would be left: one click (RFC 8058) first, then a request by mail,
/// then the web page. Nothing is sent: the user sees this and confirms it.
#[tauri::command(async)]
pub fn unsubscribe_plan(state: St<'_>, id: i64) -> CmdResult<UnsubscribePlan> {
    let (r, _, mut ways) = unsubscribe_ways(&state, id)?;
    plan_of(&state, &r, ways.remove(0))
}

/// Leaves a mailing list the way the user confirmed (`one-click` or `mail`). When one
/// click fails and a letter is possible, the letter is offered for confirmation, not sent.
#[tauri::command]
pub async fn unsubscribe(state: St<'_>, id: i64, way: String) -> CmdResult<Unsubscribed> {
    let (r, u, ways) = unsubscribe_ways(&state, id)?;
    match way.as_str() {
        "one-click" => {
            let Some(url) = u
                .one_click
                .filter(|_| ways.iter().any(|w| matches!(w, Way::OneClick { .. })))
            else {
                return Err(no_unsubscribe());
            };
            match depesha_core::unsubscribe::one_click(&url).await {
                Ok(_) => Ok(Unsubscribed::Done),
                Err(e) => match depesha_core::unsubscribe::after_one_click(&ways) {
                    Some(mail) => {
                        tracing::info!("one-click unsubscribe failed, offering mail: {e}");
                        Ok(Unsubscribed::Confirm {
                            plan: plan_of(&state, &r, mail.clone())?,
                            reason: e.to_string(),
                        })
                    }
                    None => Err(e.into()),
                },
            }
        }
        "mail" => {
            let Some(Way::Mail { to, subject, text }) = ways.into_iter().find(|w| matches!(w, Way::Mail { .. })) else {
                return Err(no_unsubscribe());
            };
            let account = state.account(&r.account_id)?;
            let draft = Draft {
                from: Some(Addr {
                    name: Some(account.display_name.clone()).filter(|n| !n.is_empty()),
                    email: account.email.clone(),
                }),
                to: vec![Addr {
                    name: None,
                    email: to.clone(),
                }],
                subject,
                text,
                ..Default::default()
            };
            smtp::build(&draft)?;
            let now = chrono::Utc::now().timestamp();
            state
                .store
                .outbox_add(&account.id, &draft, now, now, 0, &FollowupPlan::default())?;
            state.outbox_notify.notify_one();
            state.emit("outbox-changed", serde_json::json!({}));
            Ok(Unsubscribed::MailSent { to })
        }
        _ => Err(CmdError::new("bad-request", format!("unknown unsubscribe way: {way}"))),
    }
}

/// The language the interface is shown in, resolved from the settings and the locale.
#[tauri::command]
pub fn language(state: St<'_>) -> depesha_core::lang::Lang {
    state.settings().lang()
}

#[tauri::command]
pub fn settings_get(state: St<'_>) -> Settings {
    state.settings()
}

#[tauri::command]
pub fn settings_set(state: St<'_>, settings: Settings) -> CmdResult<()> {
    let before = state.settings();
    check_save_folder(&state, &before.attachments_dir, &settings.attachments_dir)?;
    let offline_changed =
        before.offline != settings.offline || before.offline_attachments != settings.offline_attachments;
    state.save_settings(settings.clone())?;
    state.apply_language();
    crate::background::sync_autostart(&state.app, Some(&before), &settings);
    state.emit("settings-changed", serde_json::json!({}));
    // A wider offline window starts downloading at once.
    if offline_changed {
        for account in state.accounts() {
            if let Ok(w) = state.worker(&account.id) {
                w.kick(Work::Prefetch);
            }
        }
    }
    Ok(())
}

/// A folder attachments go to without asking is one the user picked, not one typed in
/// by whatever runs in the page: an unchanged or emptied setting needs no picking.
fn check_save_folder(state: &AppState, before: &str, after: &str) -> CmdResult<()> {
    let after = after.trim();
    if after.is_empty() || after == before.trim() {
        return Ok(());
    }
    state.paths.check(Use::SaveFolder, after).map(|_| ())
}

/// The settings of one built-in plugin; the rest of the settings stay as they are.
#[tauri::command]
pub fn plugin_settings_set(state: St<'_>, plugin: String, values: serde_json::Value) -> CmdResult<()> {
    let mut settings = state.settings();
    settings.plugin_settings.insert(plugin, values);
    state.save_settings(settings)?;
    state.emit("settings-changed", serde_json::json!({}));
    Ok(())
}

#[tauri::command]
pub async fn load_older(state: St<'_>, account_id: String, folder: String) -> CmdResult<usize> {
    let key = format!("older:{account_id}:{folder}");
    let name = state
        .store
        .folders(Some(&account_id))?
        .into_iter()
        .find(|f| f.folder.name == folder)
        .map(|f| f.folder.display_name)
        .unwrap_or_else(|| folder.clone());
    let label = tr!("Loading older mail: {name}", "Загрузка старых писем: {name}");
    state.task(&key, "older", Some(&account_id), label, 0, 0);
    match state.worker(&account_id)?.run(Work::LoadOlder { folder }).await {
        Ok(out) => {
            state.task_done(&key);
            Ok(match out {
                Output::Count(n) => n,
                _ => 0,
            })
        }
        Err(e) => {
            let e = CmdError::from(e);
            state.task_failed(&key, e.clone());
            Err(e)
        }
    }
}

#[tauri::command]
pub fn tasks_list(state: St<'_>) -> Vec<crate::tasks::Task> {
    state.tasks_list()
}

#[tauri::command]
pub fn task_dismiss(state: St<'_>, key: String) {
    state.task_dismiss(&key);
}

/// Per account: the last full sync and how much of the offline window is downloaded.
#[tauri::command(async)]
pub fn sync_overview(state: St<'_>) -> CmdResult<Vec<crate::tasks::AccountSync>> {
    let settings = state.settings();
    let since = settings.offline_since();
    state
        .accounts()
        .into_iter()
        .map(|a| {
            let (offline_done, offline_total) = match since {
                Some(since) => state
                    .store
                    .offline_progress(&a.id, since, settings.offline_attachments)?,
                None => (0, 0),
            };
            Ok(crate::tasks::AccountSync {
                last_sync: state.last_sync(&a.id),
                paused: state.prefetch_paused(&a.id),
                account_id: a.id,
                offline_done,
                offline_total,
            })
        })
        .collect()
}

/// Pauses or resumes the offline download of an account.
#[tauri::command]
pub fn offline_pause(state: St<'_>, account_id: String, paused: bool) -> CmdResult<()> {
    state.set_prefetch_paused(&account_id, paused);
    if paused {
        state.task_done(&format!("prefetch:{account_id}"));
    } else {
        state.worker(&account_id)?.kick(Work::Prefetch);
    }
    Ok(())
}

#[tauri::command]
pub async fn sync_now(state: St<'_>, account_id: Option<String>, folder: Option<String>) -> CmdResult<()> {
    let ids = match account_id {
        Some(id) => vec![id],
        None => state.accounts().into_iter().map(|a| a.id).collect(),
    };
    for id in ids {
        let work = match &folder {
            Some(f) => Work::SyncFolder(f.clone()),
            None => Work::SyncAll,
        };
        state.worker(&id)?.run(work).await?;
    }
    Ok(())
}

/// The "Server" and "Storage" sections of a mailbox's page, as the cache knows them.
#[tauri::command(async)]
pub fn server_info(state: St<'_>, account_id: String) -> CmdResult<crate::server::ServerView> {
    crate::server::view(&state, &account_id)
}

/// "Check again": a fresh login reads the server's capabilities and quota.
#[tauri::command]
pub async fn server_check(state: St<'_>, account_id: String) -> CmdResult<crate::server::ServerView> {
    let account = state.account(&account_id)?;
    crate::server::check(&state, &account).await?;
    crate::server::view(&state, &account_id)
}

/// Reads the quota again on the mailbox's connection, unless the mailbox is paused.
#[tauri::command]
pub async fn quota_refresh(state: St<'_>, account_id: String) -> CmdResult<()> {
    state.worker(&account_id)?.run_background(Work::Quota).await?;
    Ok(())
}

/// Every IMAP mailbox's room, for the sidebar.
#[tauri::command(async)]
pub fn quotas(state: St<'_>) -> CmdResult<Vec<crate::server::QuotaView>> {
    crate::server::quotas(&state)
}

/// Counts the size of every folder in the background (the tasks window shows it).
#[tauri::command]
pub async fn folder_sizes_count(state: St<'_>, account_id: String) -> CmdResult<()> {
    let account = state.account(&account_id)?;
    crate::server::count_sizes(state.inner().clone(), account)
}

#[tauri::command]
pub fn folder_sizes_stop(state: St<'_>, account_id: String) {
    crate::server::stop_count(&state, &account_id);
}

/// A full mailbox: a desktop notification when the window is out of sight.
#[tauri::command]
pub fn notify_full(state: St<'_>, title: String, body: String) {
    crate::server::notify_full(&state, &title, &body);
}

/// Pictures are looked for again after a week, missing ones after a day.
const AVATAR_TTL: i64 = 7 * 86_400;
const AVATAR_MISS_TTL: i64 = 86_400;

/// The picture of a sender as a `data:` URI: the colleague's photo from the
/// account's Exchange, otherwise, for mail that passed DMARC, the brand's BIMI logo.
#[tauri::command]
pub async fn avatar(
    state: St<'_>,
    account_id: String,
    email: String,
    authenticated: bool,
) -> CmdResult<Option<String>> {
    let email = email.trim().to_ascii_lowercase();
    let Some((_, domain)) = email.rsplit_once('@') else {
        return Ok(None);
    };
    let now = chrono::Utc::now().timestamp();
    let fresh = |c: &(Option<String>, i64)| now - c.1 < if c.0.is_some() { AVATAR_TTL } else { AVATAR_MISS_TTL };

    if state.account(&account_id)?.is_ews() {
        let key = format!("photo:{account_id}:{email}");
        let uri = match state.store.avatar(&key)?.filter(fresh) {
            Some((uri, _)) => uri,
            None => match state
                .worker(&account_id)?
                .run_background(Work::UserPhoto(email.clone()))
                .await
            {
                Ok(Output::Body(bytes)) => {
                    let uri = avatar::data_uri(&bytes);
                    state.store.set_avatar(&key, Some(&uri), now)?;
                    Some(uri)
                }
                Ok(_) => {
                    state.store.set_avatar(&key, None, now)?;
                    None
                }
                // Offline or a busy server: initials now, another try next time.
                Err(_) => None,
            },
        };
        if uri.is_some() {
            return Ok(uri);
        }
    }

    if !authenticated || !state.settings().sender_logos {
        return Ok(None);
    }
    let key = format!("bimi:{domain}");
    if let Some((uri, _)) = state.store.avatar(&key)?.filter(fresh) {
        return Ok(uri);
    }
    let uri = avatar::bimi_logo(domain).await;
    state.store.set_avatar(&key, uri.as_deref(), now)?;
    Ok(uri)
}

#[tauri::command(async)]
pub fn trust_sender(state: St<'_>, email: String) -> CmdResult<()> {
    Ok(state.store.trust_sender(&email)?)
}

#[tauri::command(async)]
pub fn addresses(state: St<'_>, prefix: String) -> CmdResult<Vec<Addr>> {
    Ok(state.store.known_addresses(&prefix, 8)?)
}

/// The address book (#66): every address of the correspondence with what was decided about
/// it, and every address added by hand. `query` keeps the ones matching name, address or note.
#[tauri::command(async)]
pub fn people(state: St<'_>, query: String) -> CmdResult<Vec<Person>> {
    Ok(state.store.people(&query)?)
}

/// Saves a person's record: their name, the format to write in, the form to show, a note
/// and whether completion hides the address (#66, #44).
#[tauri::command(async)]
pub fn person_save(state: St<'_>, person: Person) -> CmdResult<()> {
    Ok(state.store.save_person(&person)?)
}

/// Removes a person added by hand; one seen only in the correspondence cannot go (#66).
#[tauri::command(async)]
pub fn person_forget(state: St<'_>, email: String) -> CmdResult<bool> {
    Ok(state.store.forget_person(&email)?)
}

/// The decisions about the suggestions (#69).
#[tauri::command(async)]
pub fn hints(state: St<'_>) -> CmdResult<Vec<HintState>> {
    Ok(state.store.hints()?)
}

/// Writes one decision about a suggestion (#69).
#[tauri::command(async)]
pub fn hint_save(state: St<'_>, hint: HintState) -> CmdResult<()> {
    Ok(state.store.save_hint(&hint)?)
}

/// Forgets every decision about the suggestions (#69): the «ask them again» of the page.
#[tauri::command(async)]
pub fn hints_clear(state: St<'_>) -> CmdResult<()> {
    state.store.clear_hints()?;
    state.store.clear_all_hint_counts()?;
    Ok(())
}

/// The counters of the detectors of #69 (#69): what they have seen so far.
#[tauri::command(async)]
pub fn hint_counts(state: St<'_>) -> CmdResult<Vec<HintCount>> {
    Ok(state.store.hint_counts()?)
}

/// Counts one more happening for a detector (#69) and returns the new count.
#[tauri::command(async)]
pub fn count_hint(state: St<'_>, id: String, subject: String, now: i64) -> CmdResult<i64> {
    Ok(state.store.count_hint(&id, &subject, now)?)
}

/// Forgets a detector's count (#69): a rule was set or the hint was answered.
#[tauri::command(async)]
pub fn clear_hint_count(state: St<'_>, id: String, subject: String) -> CmdResult<()> {
    Ok(state.store.clear_hint_count(&id, &subject)?)
}

/// Saves an attachment where the user said in the save dialog (`pick_save_file`).
#[tauri::command]
pub async fn attachment_save(state: St<'_>, id: i64, index: u32, path: String) -> CmdResult<()> {
    let path = state.paths.check(Use::SaveFile, &path)?;
    let row = row(&state, id)?;
    let raw = raw_of(&state, &row).await?;
    let (_, bytes) = message::attachment(&raw, index)?;
    tokio::fs::write(&path, bytes).await?;
    mark_from_internet(&path).await;
    Ok(())
}

/// The folder attachments of this letter go to without asking: its mailbox's own, else
/// the one from the settings. Both were picked by the user (`check_save_folder`).
fn settings_folder(state: &AppState, row: &MessageRow) -> CmdResult<String> {
    let own = state.account(&row.account_id)?.attachments_dir;
    let dir = if own.trim().is_empty() {
        state.settings().attachments_dir
    } else {
        own
    };
    let dir = dir.trim().to_owned();
    if dir.is_empty() {
        return Err(CmdError::new(
            "save-folder",
            tr!(
                "no folder for attachments is chosen in Settings → Mail",
                "папка для вложений не выбрана в Настройках → «Почта»"
            ),
        ));
    }
    Ok(dir)
}

/// Saves an attachment into the folder from the settings, without asking where:
/// renamed on a name clash, the folder made again if it went away. Returns the path.
#[tauri::command]
pub async fn attachment_save_in(state: St<'_>, id: i64, index: u32) -> CmdResult<String> {
    let row = row(&state, id)?;
    let dir = settings_folder(&state, &row)?;
    let raw = raw_of(&state, &row).await?;
    let (info, bytes) = message::attachment(&raw, index)?;
    let folder = save_folder(&dir).await?;
    let path = free_path(&folder, &safe_name(&info.name));
    tokio::fs::write(&path, bytes).await.map_err(|e| save_error(&dir, e))?;
    mark_from_internet(&path).await;
    Ok(path.to_string_lossy().into_owned())
}

/// Saves every attachment into a folder, renaming on name clashes. Returns how many.
/// The folder is one just picked (`pick_folder`), or without one the folder from the settings.
#[tauri::command]
pub async fn attachments_save_all(state: St<'_>, id: i64, dir: Option<String>) -> CmdResult<usize> {
    let row = row(&state, id)?;
    let dir = match dir {
        Some(dir) => {
            state.paths.check(Use::SaveFolder, &dir)?;
            dir
        }
        None => settings_folder(&state, &row)?,
    };
    let raw = raw_of(&state, &row).await?;
    let view = message::parse_view(&raw, false)?;
    let folder = save_folder(&dir).await?;
    let mut saved = 0;
    for info in view
        .attachments
        .iter()
        .filter(|a| !(a.inline && a.content_id.is_some()))
    {
        let (_, bytes) = message::attachment(&raw, info.index)?;
        let path = free_path(&folder, &safe_name(&info.name));
        tokio::fs::write(&path, bytes).await.map_err(|e| save_error(&dir, e))?;
        mark_from_internet(&path).await;
        saved += 1;
    }
    Ok(saved)
}

async fn save_folder(dir: &str) -> CmdResult<PathBuf> {
    let folder = PathBuf::from(dir);
    tokio::fs::create_dir_all(&folder)
        .await
        .map_err(|e| save_error(dir, e))?;
    Ok(folder)
}

/// A folder that cannot be written to: what to do about it, not just the system's words.
fn save_error(dir: &str, e: std::io::Error) -> CmdError {
    CmdError::new(
        "save-folder",
        tr!(
            "could not save into “{dir}”: {e}. Choose another folder in Settings → Mail or use “Save as…”",
            "не удалось сохранить в «{dir}»: {e}. Выберите другую папку в Настройках → «Почта» или «Сохранить как…»"
        ),
    )
}

/// Opens a letter in a window of its own (double click in the list); a letter already
/// open in one brings that window forward instead of opening a second.
#[tauri::command]
pub async fn message_window(app: tauri::AppHandle, id: i64, title: String) -> CmdResult<()> {
    let label = format!("message-{id}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    let title = if title.trim().is_empty() {
        "Depesha".to_owned()
    } else {
        title
    };
    tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::App(format!("index.html?message={id}").into()),
    )
    .title(title)
    .inner_size(960.0, 760.0)
    .min_inner_size(560.0, 420.0)
    .decorations(false)
    .build()
    .map_err(|e| CmdError::new("window", e.to_string()))?;
    Ok(())
}

/// An attachment's content for the viewer, sent as binary: no base64 on the way.
#[tauri::command]
pub async fn attachment_bytes(state: St<'_>, id: i64, index: u32) -> CmdResult<tauri::ipc::Response> {
    let row = row(&state, id)?;
    let raw = raw_of(&state, &row).await?;
    let (_, bytes) = message::attachment(&raw, index)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// A letter attached to a letter (.eml), to read without saving it; its bytes come as the raw request body.
#[tauri::command]
pub fn letter_view(request: tauri::ipc::Request<'_>) -> CmdResult<MessageView> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(CmdError::new("bad-request", "expected the letter's bytes"));
    };
    Ok(message::parse_view(bytes, false)?)
}

/// An attached HTML or Markdown file, cleaned like a letter for the viewer. A big file
/// takes a while to render and clean: off the main thread, which draws the window.
#[tauri::command(async)]
pub fn document_html(text: String, markdown: bool) -> String {
    message::document_html(&text, markdown)
}

/// A letter in Markdown as the HTML it would go out as: the composer switching to the
/// visual editor takes it from here, so both agree. Off the main thread, as above.
#[tauri::command(async)]
pub fn markdown_html(text: String) -> String {
    message::markdown_html(&text)
}

/// Programs and what runs them: saved only, never opened from a letter.
const DANGEROUS: &[&str] = &[
    // Windows
    "exe",
    "msi",
    "msp",
    "mst",
    "bat",
    "cmd",
    "com",
    "scr",
    "pif",
    "vb",
    "vbs",
    "vbe",
    "js",
    "jse",
    "ws",
    "wsf",
    "wsh",
    "wsc",
    "sct",
    "ps1",
    "psm1",
    "psd1",
    "jar",
    "lnk",
    "url",
    "website",
    "scf",
    "inf",
    "reg",
    "hta",
    "cpl",
    "msc",
    "chm",
    "gadget",
    "application",
    "appref-ms",
    "msix",
    "msixbundle",
    "appx",
    "appxbundle",
    "appinstaller",
    "library-ms",
    "settingcontent-ms",
    "search-ms",
    "xll",
    "xlam",
    "iso",
    "img",
    "vhd",
    "vhdx",
    // Linux
    "desktop",
    "sh",
    "run",
    "appimage",
    "deb",
    "rpm",
    "flatpakref",
    // macOS
    "app",
    "command",
    "terminal",
    "pkg",
    "dmg",
    "workflow",
    "scpt",
];

/// Windows: a file from mail carries the "came from the internet" mark (Mark of the
/// Web), so Office opens it in Protected View and SmartScreen checks programs.
async fn mark_from_internet(path: &std::path::Path) {
    #[cfg(windows)]
    {
        let stream = format!("{}:Zone.Identifier", path.display());
        let _ = tokio::fs::write(stream, b"[ZoneTransfer]\r\nZoneId=3\r\n").await;
    }
    #[cfg(not(windows))]
    let _ = path;
}

/// Opens an attachment with the system application. Executables are only saved, never opened.
#[tauri::command]
pub async fn attachment_open(app: tauri::AppHandle, state: St<'_>, id: i64, index: u32) -> CmdResult<()> {
    let row = row(&state, id)?;
    let raw = raw_of(&state, &row).await?;
    let (info, bytes) = message::attachment(&raw, index)?;
    let name = safe_name(&info.name);
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    if DANGEROUS.contains(&ext.as_str()) {
        return Err(CmdError::new(
            "dangerous",
            tr!(
                "“{name}” is a program. Opening it from mail is dangerous; save it if you are sure",
                "«{name}» — исполняемый файл. Открывать его из письма опасно; сохраните его, если уверены"
            ),
        ));
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| CmdError::new("io", e.to_string()))?
        .join("attachments")
        .join(id.to_string());
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join(&name);
    tokio::fs::write(&path, bytes).await?;
    mark_from_internet(&path).await;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| {
            CmdError::new(
                "io",
                tr!("could not open the file: {e}", "не удалось открыть файл: {e}"),
            )
        })
}

/// A file name the sender chose, made safe on every system: no path, no control or
/// text-direction characters ("gpj.exe" shown as "exe.jpg"), no dots or spaces at
/// the end (Windows drops them, and "a.exe." would pass for a file without an
/// extension), no reserved Windows names, not too long.
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut cleaned = cleaned
        .trim_start_matches(|c: char| c == '.' || c.is_whitespace())
        .trim_end_matches(|c: char| c == '.' || c.is_whitespace())
        .to_owned();
    if cleaned.is_empty() {
        return "attachment".into();
    }
    let stem = cleaned
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        cleaned.insert(0, '_');
    }
    // 255 bytes is the limit of most file systems; the extension is kept.
    while cleaned.len() > 200 {
        let cut = match cleaned.rfind('.') {
            Some(dot) if cleaned.len() - dot <= 20 && dot > 0 => dot,
            _ => cleaned.len(),
        };
        let mut at = cut - 1;
        while !cleaned.is_char_boundary(at) {
            at -= 1;
        }
        cleaned.remove(at);
    }
    cleaned
}

fn free_path(dir: &std::path::Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_owned(), format!(".{e}")),
        None => (name.to_owned(), String::new()),
    };
    (1..)
        .map(|i| dir.join(format!("{stem} ({i}){ext}")))
        .find(|p| !p.exists())
        .expect("some free name")
}

/// Links from mail open in the system browser; only web and mail links.
#[tauri::command]
pub fn open_link(app: tauri::AppHandle, url: String) -> CmdResult<()> {
    let lower = url.trim().to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")) {
        return Err(CmdError::new(
            "dangerous",
            tr!("links of this kind are not opened", "такие ссылки не открываются"),
        ));
    }
    app.opener()
        .open_url(url.trim(), None::<&str>)
        .map_err(|e| CmdError::new("io", e.to_string()))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AttachmentSource {
    File { path: String },
    Message { id: i64, index: u32 },
}

#[derive(Debug, Deserialize)]
pub struct ComposeDraft {
    from: Option<Addr>,
    #[serde(default)]
    to: Vec<Addr>,
    #[serde(default)]
    cc: Vec<Addr>,
    #[serde(default)]
    bcc: Vec<Addr>,
    #[serde(default)]
    subject: String,
    #[serde(default)]
    text: String,
    /// The letter from the visual editor; only an HTML letter has it.
    #[serde(default)]
    html: Option<String>,
    /// The HTML of the signature a Markdown letter carries (#67).
    #[serde(default)]
    signature: Option<String>,
    #[serde(default)]
    format: BodyFormat,
    in_reply_to: Option<String>,
    #[serde(default)]
    references: Vec<String>,
    #[serde(default)]
    attachments: Vec<AttachmentSource>,
    /// Scheduled sending time: kept with a saved draft, the send takes `at` instead.
    #[serde(default)]
    send_at: Option<i64>,
    /// The letter this one answers or forwards.
    #[serde(default)]
    acts_on: Option<ActsOn>,
}

async fn resolve(state: &AppState, d: ComposeDraft) -> CmdResult<Draft> {
    let mut attachments = Vec::new();
    let mut total = 0u64;
    for a in d.attachments {
        let att = match a {
            AttachmentSource::File { path } => {
                state.paths.check(Use::Attach, &path)?;
                let data = tokio::fs::read(&path)
                    .await
                    .map_err(|e| CmdError::new("io", format!("{path}: {e}")))?;
                let name = PathBuf::from(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                OutgoingAttachment {
                    mime: mime_for(&name).into(),
                    name,
                    data,
                }
            }
            AttachmentSource::Message { id, index } => {
                let r = row(state, id)?;
                let raw = raw_of(state, &r).await?;
                let (info, data) = message::attachment(&raw, index)?;
                OutgoingAttachment {
                    name: info.name,
                    mime: info.mime,
                    data,
                }
            }
        };
        total += att.data.len() as u64;
        attachments.push(att);
    }
    // Pictures in the text travel inside the letter too: they count with the files.
    if d.format == BodyFormat::Html {
        total += d.html.as_ref().map_or(0, |h| h.len() as u64 * 3 / 4);
    }
    // A Markdown letter's signature travels inside it too, pictures and all.
    if d.format == BodyFormat::Markdown {
        total += d.signature.as_ref().map_or(0, |s| s.len() as u64 * 3 / 4);
    }
    if total > MAX_ATTACHMENTS {
        return Err(CmdError::new(
            "too-large",
            tr!(
                "attachments over 50 MB: mail servers will not accept them",
                "вложения больше 50 МБ — почтовые серверы такое не примут"
            ),
        ));
    }
    Ok(Draft {
        from: d.from,
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        subject: d.subject,
        text: d.text,
        // A letter switched to plain text or Markdown does not take its old HTML along.
        html: d.html.filter(|_| d.format == BodyFormat::Html),
        // Only a Markdown letter carries its signature's HTML apart: an HTML one has it
        // inside `html`, a plain one only its text.
        signature: d.signature.filter(|_| d.format == BodyFormat::Markdown),
        format: d.format,
        in_reply_to: d.in_reply_to,
        references: d.references,
        attachments,
        acts_on: d.acts_on,
    })
}

fn mime_for(name: &str) -> &'static str {
    match name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).as_deref() {
        Some("pdf") => "application/pdf",
        Some("txt" | "log") => "text/plain",
        Some("csv") => "text/csv",
        Some("htm" | "html") => "text/html",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("zip") => "application/zip",
        Some("7z") => "application/x-7z-compressed",
        Some("rar") => "application/vnd.rar",
        Some("doc") => "application/msword",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("xls") => "application/vnd.ms-excel",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("ppt") => "application/vnd.ms-powerpoint",
        Some("pptx") => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        Some("odt") => "application/vnd.oasis.opendocument.text",
        Some("ods") => "application/vnd.oasis.opendocument.spreadsheet",
        Some("eml") => "message/rfc822",
        Some("ics") => "text/calendar",
        Some("xml") => "application/xml",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

#[derive(Serialize)]
pub struct Queued {
    id: i64,
    /// When the message leaves: after the undo delay or at the scheduled time.
    at: i64,
}

/// Queues the message; the outbox task sends it at `at` (scheduled send) or after
/// the undo delay from the settings. `followup_secs` (or the older `followup_days`)
/// asks for a reminder when no answer comes that long after sending; `followup` says the
/// rest of that wait: a deadline, repeats, the awaited recipient, the choice's name.
/// `discard_draft` removes the server draft it came from.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn send(
    state: St<'_>,
    account_id: String,
    draft: ComposeDraft,
    discard_draft: Option<i64>,
    at: Option<i64>,
    followup_days: Option<u32>,
    followup_secs: Option<i64>,
    followup: Option<FollowupPlan>,
) -> CmdResult<Queued> {
    let account = state.account(&account_id)?;
    let draft = resolve(&state, draft).await?;
    smtp::build(&draft)?; // validate addresses now, not in the background
    let now = chrono::Utc::now().timestamp();
    let at = at.unwrap_or(now + i64::from(state.settings().undo_send_secs));
    let followup_secs = followup_secs
        .unwrap_or(i64::from(followup_days.unwrap_or(0)) * 86_400)
        .max(0);
    let mut followup = followup.unwrap_or_default();
    // Decided now, as the letter answered lies now: the outbox keeps the decision.
    followup.park = Some(crate::waiting::decide(&state, &account, &draft, followup.park)?);
    let id = state
        .store
        .outbox_add(&account.id, &draft, now, at, followup_secs, &followup)?;
    state.outbox_notify.notify_one();
    state.emit("outbox-changed", serde_json::json!({}));
    if let Some(d) = discard_draft {
        let _ = discard(&state, d).await;
    }
    Ok(Queued { id, at: at.max(now) })
}

async fn discard(state: &AppState, id: i64) -> CmdResult<()> {
    let (r, validity) = state.store.get_at(id)?.ok_or_else(gone)?;
    state
        .worker(&r.account_id)?
        .run(Work::Delete {
            folder: r.folder,
            validity,
            uids: vec![r.uid],
        })
        .await?;
    Ok(())
}

/// Deletes a saved draft for good: the user threw the composition away.
#[tauri::command]
pub async fn draft_discard(state: St<'_>, id: i64) -> CmdResult<()> {
    discard(&state, id).await
}

/// Saves the draft into the server's Drafts folder, replacing the previous version.
/// Returns the saved copy, for the next save to replace it.
#[tauri::command]
pub async fn draft_save(
    state: St<'_>,
    account_id: String,
    draft: ComposeDraft,
    replace: Option<i64>,
) -> CmdResult<Option<i64>> {
    let account = state.account(&account_id)?;
    // A mailbox without Drafts gets one, as it gets an Archive for "Done".
    let folder = role_folder(&state, &account.id, FolderRole::Drafts, pick("Drafts", "Черновики")).await?;
    let send_at = draft.send_at;
    let mut draft = resolve(&state, draft).await?;
    if draft.to.is_empty() && draft.cc.is_empty() && draft.bcc.is_empty() {
        // A draft may have no recipients yet; the builder insists on one.
        draft.to.push(draft.from.clone().unwrap_or(Addr {
            name: None,
            email: account.email.clone(),
        }));
    }
    let mut raw = smtp::build(&draft)?.formatted();
    if let Some(at) = send_at {
        // A header line on top is as good as any other place for it.
        raw.splice(0..0, format!("{}: {at}\r\n", message::SEND_AT_HEADER).into_bytes());
    }
    if draft.format != BodyFormat::Plain {
        // Markdown looks like plain text in the letter: the draft says how it was written.
        let header = format!("{}: {}\r\n", message::FORMAT_HEADER, draft.format.as_str());
        raw.splice(0..0, header.into_bytes());
    }
    let message_id = message::parse_summary(&raw).message_id;
    let worker = state.worker(&account.id)?;
    worker
        .run(Work::Append {
            folder: folder.clone(),
            raw,
            flags: "(\\Draft \\Seen)".into(),
            message_id: None,
        })
        .await?;
    if let Some(old) = replace {
        let _ = discard(&state, old).await;
    }
    // The append synced the folder: the copy is in the cache unless the server hides it.
    let saved = match message_id {
        Some(mid) => state
            .store
            .find_by_message_id(&account.id, &folder, &mid)?
            .map(|r| r.id),
        None => None,
    };
    Ok(saved)
}

#[tauri::command(async)]
pub fn outbox(state: St<'_>) -> CmdResult<Vec<OutboxItem>> {
    let mut items = state.store.outbox()?;
    for item in &mut items {
        // The GUI only needs names and sizes, not the bytes.
        for a in &mut item.draft.attachments {
            a.data = Vec::new();
        }
    }
    Ok(items)
}

#[tauri::command(async)]
pub fn outbox_retry(state: St<'_>, id: i64) -> CmdResult<()> {
    state.store.outbox_requeue(id, chrono::Utc::now().timestamp())?;
    state.outbox_notify.notify_one();
    state.emit("outbox-changed", serde_json::json!({}));
    Ok(())
}

#[derive(Serialize)]
pub struct ReturnedDraft {
    account_id: String,
    draft: Draft,
    /// Attachments as data URLs are not useful here; the GUI gets names and base64.
    attachments: Vec<(String, String, String)>,
}

/// Takes the message out of the outbox back into editing.
#[tauri::command(async)]
pub fn outbox_cancel(state: St<'_>, id: i64) -> CmdResult<Option<ReturnedDraft>> {
    let account_id = state
        .store
        .outbox()?
        .into_iter()
        .find(|i| i.id == id)
        .map(|i| i.account_id);
    let draft = state.store.outbox_remove(id)?;
    state.emit("outbox-changed", serde_json::json!({}));
    Ok(match (account_id, draft) {
        (Some(account_id), Some(mut draft)) => {
            let attachments = draft
                .attachments
                .drain(..)
                .map(|a| (a.name, a.mime, BASE64.encode(a.data)))
                .collect();
            Some(ReturnedDraft {
                account_id,
                draft,
                attachments,
            })
        }
        _ => None,
    })
}

/// Saves attachments handed back by `outbox_cancel` to temp files so the composer can reuse them.
#[tauri::command]
pub async fn temp_attachment(app: tauri::AppHandle, state: St<'_>, name: String, data: String) -> CmdResult<String> {
    let bytes = BASE64.decode(data).map_err(|e| CmdError::new("io", e.to_string()))?;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| CmdError::new("io", e.to_string()))?
        .join("compose")
        .join(chrono::Utc::now().timestamp_millis().to_string());
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join(safe_name(&name));
    tokio::fs::write(&path, bytes).await?;
    state.paths.allow(Use::Attach, path.clone());
    Ok(path.to_string_lossy().into_owned())
}

#[derive(Serialize)]
pub struct FileInfo {
    path: String,
    name: String,
    size: u64,
}

async fn info_of(path: PathBuf) -> CmdResult<FileInfo> {
    let meta = tokio::fs::metadata(&path).await?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(FileInfo {
        path: path.to_string_lossy().into_owned(),
        name,
        size: meta.len(),
    })
}

/// Pictures that go into the text of a letter: what every mail program shows.
const PICTURES: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

/// A picture file read for the text of a letter is at most this big; the composer
/// makes a large photo smaller before it goes in.
const MAX_PICTURE_FILE: u64 = 25 * 1024 * 1024;

/// A picture chosen to attach (picked or dropped on the window), as a `data:` URL for
/// the text of a letter. Other files and files nobody chose are refused.
#[tauri::command]
pub async fn inline_image(state: St<'_>, path: String) -> CmdResult<String> {
    let path = state.paths.check(Use::Attach, &path)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !PICTURES.contains(&ext.as_str()) {
        return Err(CmdError::new(
            "not-a-picture",
            tr!("“{name}” is not a picture", "«{name}» — не картинка"),
        ));
    }
    if tokio::fs::metadata(&path).await?.len() > MAX_PICTURE_FILE {
        return Err(CmdError::new(
            "too-large",
            tr!(
                "“{name}” is too large to go into the text",
                "«{name}» слишком большая, чтобы вставить её в текст"
            ),
        ));
    }
    let data = tokio::fs::read(&path).await?;
    Ok(format!("data:{};base64,{}", mime_for(&name), BASE64.encode(data)))
}

/// Name and size of a file chosen to attach (dropped on the window); nothing about others.
#[tauri::command]
pub async fn file_info(state: St<'_>, path: String) -> CmdResult<FileInfo> {
    info_of(state.paths.check(Use::Attach, &path)?).await
}

/// The system's file dialog, opened by the backend so that it knows what the user chose.
fn dialog(window: &tauri::Window, title: String) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    use tauri_plugin_dialog::DialogExt;
    let builder = window.dialog().file().set_title(title);
    // As the dialog plugin does: a parent window on Linux breaks GTK's dialog.
    #[cfg(any(windows, target_os = "macos"))]
    let builder = builder.set_parent(window);
    builder
}

/// Files to attach, picked in the open dialog. Empty when the dialog was closed.
#[tauri::command]
pub async fn pick_files(
    window: tauri::Window,
    state: St<'_>,
    title: String,
    images: Option<bool>,
) -> CmdResult<Vec<FileInfo>> {
    let mut builder = dialog(&window, title);
    if images.unwrap_or(false) {
        builder = builder.add_filter(pick("Pictures", "Картинки"), &PICTURES);
    }
    let picked = builder.blocking_pick_files().unwrap_or_default();
    let mut files = Vec::new();
    for path in picked.into_iter().filter_map(|p| p.into_path().ok()) {
        state.paths.allow(Use::Attach, path.clone());
        files.push(info_of(path).await?);
    }
    Ok(files)
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FolderUse {
    /// Attachments are saved into it.
    Save,
    /// A plugin is installed from it.
    Plugin,
}

/// A folder picked in the system dialog, starting at `current`; nothing when it was closed.
#[tauri::command]
pub async fn pick_folder(
    window: tauri::Window,
    state: St<'_>,
    to: FolderUse,
    title: String,
    current: Option<String>,
) -> CmdResult<Option<String>> {
    let mut builder = dialog(&window, title);
    if let Some(dir) = current.filter(|d| !d.trim().is_empty()) {
        builder = builder.set_directory(dir);
    }
    let Some(path) = builder.blocking_pick_folder().and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    let to = match to {
        FolderUse::Save => Use::SaveFolder,
        FolderUse::Plugin => Use::Plugin,
    };
    state.paths.allow(to, path.clone());
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Where to save one attachment, asked in the save dialog; nothing when it was closed.
#[tauri::command]
pub async fn pick_save_file(
    window: tauri::Window,
    state: St<'_>,
    title: String,
    name: String,
) -> CmdResult<Option<String>> {
    let picked = dialog(&window, title)
        .set_file_name(safe_name(&name))
        .blocking_save_file()
        .and_then(|p| p.into_path().ok());
    Ok(picked.map(|path| {
        state.paths.allow(Use::SaveFile, path.clone());
        path.to_string_lossy().into_owned()
    }))
}

#[tauri::command]
pub fn update_status(state: St<'_>) -> crate::updater::UpdateStatus {
    state.updates.status()
}

#[tauri::command]
pub async fn update_check(state: St<'_>) -> CmdResult<crate::updater::UpdateStatus> {
    Ok(crate::updater::check(&state, true).await)
}

#[tauri::command]
pub async fn update_install(state: St<'_>) -> CmdResult<crate::updater::UpdateStatus> {
    crate::updater::install(&state)
        .await
        .map_err(|e| CmdError::new("update", e))
}

#[tauri::command]
pub fn update_restart(state: St<'_>) {
    crate::updater::restart(&state)
}

#[tauri::command]
pub fn extensions(app: tauri::AppHandle, state: St<'_>) -> CmdResult<Vec<crate::extensions::Installed>> {
    crate::extensions::list(&app, &state.settings().disabled_extensions)
}

/// An extension folder as it would be installed, for the user to agree to; copies nothing.
#[tauri::command]
pub fn extension_inspect(app: tauri::AppHandle, state: St<'_>, path: String) -> CmdResult<crate::extensions::Preview> {
    crate::extensions::inspect(&app, &state.paths.check(Use::Plugin, &path)?)
}

/// Installs an extension whose permissions and hooks are exactly the agreed ones.
#[tauri::command]
pub fn extension_install(
    app: tauri::AppHandle,
    state: St<'_>,
    path: String,
    permissions: Vec<String>,
    hooks: Vec<String>,
) -> CmdResult<crate::extensions::Manifest> {
    let from = state.paths.check(Use::Plugin, &path)?;
    let grant = crate::extensions::Grant { permissions, hooks };
    let m = crate::extensions::install(&app, &from, grant)?;
    state.emit("extensions-changed", serde_json::json!({ "id": m.id }));
    Ok(m)
}

/// Approves the permissions of an installed extension that waits for it.
#[tauri::command]
pub fn extension_approve(
    app: tauri::AppHandle,
    state: St<'_>,
    id: String,
    permissions: Vec<String>,
    hooks: Vec<String>,
) -> CmdResult<()> {
    crate::extensions::approve(&app, &id, crate::extensions::Grant { permissions, hooks })?;
    state.emit("extensions-changed", serde_json::json!({ "id": id }));
    Ok(())
}

#[tauri::command]
pub fn extension_remove(app: tauri::AppHandle, state: St<'_>, id: String) -> CmdResult<()> {
    crate::extensions::remove(&app, &id)?;
    let mut settings = state.settings();
    settings.disabled_extensions.retain(|d| d != &id);
    state.save_settings(settings)?;
    state.emit("extensions-changed", serde_json::json!({ "id": id }));
    Ok(())
}

#[tauri::command]
pub fn extension_storage_get(app: tauri::AppHandle, id: String, key: String) -> CmdResult<serde_json::Value> {
    crate::extensions::storage_get(&app, &id, &key)
}

#[tauri::command]
pub fn extension_storage_set(
    app: tauri::AppHandle,
    id: String,
    key: String,
    value: serde_json::Value,
) -> CmdResult<()> {
    crate::extensions::storage_set(&app, &id, &key, value)
}

/// Cached rows by id, for extensions that look at new mail.
#[tauri::command(async)]
pub fn messages_by_id(state: St<'_>, ids: Vec<i64>) -> CmdResult<Vec<MessageRow>> {
    let mut out = Vec::new();
    for id in ids {
        if let Some(r) = state.store.get(id)? {
            out.push(r);
        }
    }
    Ok(out)
}

/// Whether the system shows tray icons: the background settings warn when it does not.
#[tauri::command]
pub fn background_status(state: St<'_>) -> serde_json::Value {
    let tray = match state.tray.presence() {
        crate::background::Tray::Checking => "checking",
        crate::background::Tray::Present => "present",
        crate::background::Tray::Absent => "absent",
    };
    serde_json::json!({ "tray": tray })
}

/// Hides the main window; the app works on in the background.
#[tauri::command]
pub fn window_hide(app: tauri::AppHandle) {
    crate::background::hide_main(&app);
}

/// Quits for real; letters due soon make the window ask first, unless `force`.
#[tauri::command]
pub fn app_quit(app: tauri::AppHandle, force: bool) {
    crate::background::quit(&app, force);
}

/// Letters held back since the last call because they missed their time.
#[tauri::command]
pub fn outbox_missed(state: St<'_>) -> Vec<i64> {
    crate::background::take_missed(&state)
}

#[cfg(test)]
mod tests {
    use super::{DANGEROUS, free_path, safe_name, search_folders};
    use depesha_core::imap::{Folder, FolderRole};
    use depesha_core::query::SearchQuery;
    use depesha_core::store::FolderInfo;

    fn folder(account: &str, name: &str, role: Option<FolderRole>, delimiter: Option<&str>) -> FolderInfo {
        FolderInfo {
            account_id: account.to_owned(),
            folder: Folder {
                name: name.to_owned(),
                display_name: name.to_owned(),
                delimiter: delimiter.map(str::to_owned),
                role,
                selectable: true,
                hidden: false,
            },
            total: 0,
            unread: 0,
        }
    }

    #[test]
    fn a_server_search_goes_into_the_named_folder_or_the_three_roles() {
        let cache = vec![
            folder("a", "INBOX", Some(FolderRole::Inbox), Some("/")),
            folder("a", "Отправленные", Some(FolderRole::Sent), Some("/")),
            folder("a", "Архив", Some(FolderRole::Archive), Some("/")),
            folder("a", "Работа", None, Some("/")),
            folder("a", "Работа/2026", None, Some("/")),
            folder("a", "Личное", None, Some("/")),
        ];
        // No folder named: the inbox, sent and archive, in that order.
        assert_eq!(
            search_folders(&SearchQuery::parse("больше:25М"), &cache),
            ["INBOX", "Отправленные", "Архив"]
        );
        // A folder by its name, without its subfolders.
        assert_eq!(search_folders(&SearchQuery::parse("in:Работа"), &cache), ["Работа"]);
        // `in:Работа/*` takes the folders inside it too: by name, not by display name.
        assert_eq!(
            search_folders(&SearchQuery::parse("в:Работа/*"), &cache),
            ["Работа", "Работа/2026"]
        );
        // A role word finds the role's folder.
        assert_eq!(search_folders(&SearchQuery::parse("in:архив"), &cache), ["Архив"]);
        // A folder the cache does not have: nothing to search.
        assert!(search_folders(&SearchQuery::parse("in:Нет такой"), &cache).is_empty());
    }

    #[test]
    fn attachment_names_cannot_hide_a_program() {
        let ext = |n: &str| {
            safe_name(n)
                .rsplit_once('.')
                .map(|(_, e)| e.to_ascii_lowercase())
                .unwrap_or_default()
        };
        for name in [
            "invoice.exe.",
            "invoice.exe. .",
            "invoice.exe  ",
            "..\\invoice.exe",
            "invoice.\u{202e}gpj.exe",
        ] {
            assert!(
                DANGEROUS.contains(&ext(name).as_str()),
                "{name:?} → {:?}",
                safe_name(name)
            );
        }
        assert_eq!(safe_name("../../.bashrc"), "_.._.bashrc");
        assert_eq!(safe_name("CON.txt"), "_CON.txt");
        assert_eq!(safe_name("com1"), "_com1");
        assert_eq!(safe_name("console.txt"), "console.txt");
        assert_eq!(safe_name("отчёт\u{0007}.pdf"), "отчёт.pdf");
        assert_eq!(safe_name(". . ."), "attachment");
        let long = format!("{}.pdf", "я".repeat(300));
        let short = safe_name(&long);
        assert!(short.len() <= 200 && short.ends_with(".pdf"), "{short}");
    }

    #[test]
    fn a_saved_file_never_replaces_another() {
        let dir = std::env::temp_dir().join(format!("depesha-free-path-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(free_path(&dir, "счёт.pdf"), dir.join("счёт.pdf"));
        std::fs::write(dir.join("счёт.pdf"), b"1").unwrap();
        assert_eq!(free_path(&dir, "счёт.pdf"), dir.join("счёт (1).pdf"));
        std::fs::write(dir.join("счёт (1).pdf"), b"2").unwrap();
        assert_eq!(free_path(&dir, "счёт.pdf"), dir.join("счёт (2).pdf"));
        std::fs::write(dir.join("README"), b"3").unwrap();
        assert_eq!(free_path(&dir, "README"), dir.join("README (1)"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
