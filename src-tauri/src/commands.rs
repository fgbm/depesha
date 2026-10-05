use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use depesha_core::account::{Account, AuthMethod, Credentials, OAuthProvider, ServerConfig};
use depesha_core::autodetect::{self, Detection};
use depesha_core::ews::{self, EwsDetection};
use depesha_core::imap::{FlagChange, FolderRole};
use depesha_core::message::{self, Addr, MessageView};
use depesha_core::smtp::{self, Draft, OutgoingAttachment};
use depesha_core::store::{FolderInfo, ListQuery, MessageRow, OutboxItem, Snooze, SortKey};
use depesha_core::{avatar, mail, oauth};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::config::Settings;
use crate::error::{CmdError, CmdResult};
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
    state.remove_account(&id)?;
    state.store.forget_account(&id)?;
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
    let grant = oauth::sign_in(
        provider,
        &client,
        login_hint.as_deref(),
        open,
        state.oauth_cancel.notified(),
    )
    .await?;
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

#[tauri::command]
pub fn folders(state: St<'_>, account_id: Option<String>) -> CmdResult<Vec<FolderInfo>> {
    Ok(state.store.folders(account_id.as_deref())?)
}

#[tauri::command]
pub fn messages(state: St<'_>, query: ListQuery) -> CmdResult<Vec<MessageRow>> {
    Ok(state.store.list(&query)?)
}

#[tauri::command]
pub fn search(
    state: St<'_>,
    text: String,
    account_id: Option<String>,
    sort: Option<Vec<SortKey>>,
) -> CmdResult<Vec<MessageRow>> {
    Ok(state
        .store
        .search(&text, account_id.as_deref(), 300, &sort.unwrap_or_default())?)
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

async fn search_servers(state: &AppState, text: &str, account_id: Option<String>) -> CmdResult<Vec<MessageRow>> {
    let accounts = match account_id {
        Some(id) => vec![state.account(&id)?],
        None => state.accounts(),
    };
    let mut rows = Vec::new();
    let mut last_err = None;
    for account in accounts {
        let worker = state.worker(&account.id)?;
        for role in [FolderRole::Inbox, FolderRole::Sent, FolderRole::Archive] {
            let Some(folder) = state.store.folder_by_role(&account.id, role)? else {
                continue;
            };
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
    state.store.get(id)?.ok_or_else(|| {
        CmdError::new(
            "not-found",
            tr!("the message was deleted or moved", "письмо уже удалено или перемещено"),
        )
    })
}

#[tauri::command]
pub async fn message_open(state: St<'_>, id: i64, allow_remote: bool) -> CmdResult<OpenedMessage> {
    let row = row(&state, id)?;
    let raw = raw_of(&state, &row).await?;
    let sender = row.from.as_ref().map(|a| a.email.clone()).unwrap_or_default();
    let trusted_sender = !sender.is_empty() && state.store.is_trusted_sender(&sender)?;
    let view = message::parse_view(&raw, allow_remote || trusted_sender)?;
    Ok(OpenedMessage {
        row,
        view,
        trusted_sender,
    })
}

/// Groups message ids by (account, folder) for server operations.
fn group(state: &AppState, ids: &[i64]) -> CmdResult<BTreeMap<(String, String), Vec<u32>>> {
    Ok(group_rows(state, ids)?
        .into_iter()
        .map(|(k, rows)| (k, rows.iter().map(|r| r.uid).collect()))
        .collect())
}

fn group_rows(state: &AppState, ids: &[i64]) -> CmdResult<BTreeMap<(String, String), Vec<MessageRow>>> {
    let mut groups: BTreeMap<(String, String), Vec<MessageRow>> = BTreeMap::new();
    for id in ids {
        if let Some(r) = state.store.get(*id)? {
            groups
                .entry((r.account_id.clone(), r.folder.clone()))
                .or_default()
                .push(r);
        }
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

async fn move_group(state: &AppState, account_id: &str, from: &str, rows: &[MessageRow], to: &str) -> CmdResult<Moved> {
    state
        .worker(account_id)?
        .run(Work::Move {
            from: from.to_owned(),
            uids: rows.iter().map(|r| r.uid).collect(),
            to: to.to_owned(),
        })
        .await?;
    Ok(Moved {
        account_id: account_id.to_owned(),
        from: from.to_owned(),
        to: to.to_owned(),
        message_ids: rows.iter().filter_map(|r| r.message_id.clone()).collect(),
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
    for ((account_id, folder), uids) in group(&state, &ids)? {
        let worker = state.worker(&account_id)?;
        // Local first so the list reacts at once; syncs keep it until the server answers.
        state.store.change_flags(&account_id, &folder, &uids, change)?;
        state.emit(
            "mail-changed",
            serde_json::json!({ "account_id": account_id, "folder": folder }),
        );
        let done = worker
            .run(Work::SetFlag {
                folder: folder.clone(),
                uids: uids.clone(),
                change,
            })
            .await;
        state.store.settle_flags(&account_id, &folder, &uids);
        if done.is_err() {
            // Refused or not sent: the list shows the server's state again.
            worker.kick(Work::SyncFolder(folder));
        }
        done?;
    }
    Ok(())
}

#[tauri::command]
pub async fn move_messages(state: St<'_>, ids: Vec<i64>, to: String) -> CmdResult<Vec<Moved>> {
    let mut done = Vec::new();
    for ((account_id, folder), rows) in group_rows(&state, &ids)? {
        if folder != to {
            done.push(move_group(&state, &account_id, &folder, &rows, &to).await?);
        }
    }
    Ok(done)
}

/// "Done": out of the inbox into the archive, which is created if missing.
#[tauri::command]
pub async fn archive(state: St<'_>, ids: Vec<i64>) -> CmdResult<Vec<Moved>> {
    let mut done = Vec::new();
    for ((account_id, folder), rows) in group_rows(&state, &ids)? {
        let archive = role_folder(&state, &account_id, FolderRole::Archive, pick("Archive", "Архив")).await?;
        if folder != archive {
            done.push(move_group(&state, &account_id, &folder, &rows, &archive).await?);
        }
    }
    Ok(done)
}

/// Spam: into the junk folder; the server's filters learn from it on most systems.
#[tauri::command]
pub async fn mark_spam(state: St<'_>, ids: Vec<i64>) -> CmdResult<Vec<Moved>> {
    let mut done = Vec::new();
    for ((account_id, folder), rows) in group_rows(&state, &ids)? {
        let junk = role_folder(&state, &account_id, FolderRole::Junk, pick("Junk", "Спам")).await?;
        if folder != junk {
            done.push(move_group(&state, &account_id, &folder, &rows, &junk).await?);
        }
    }
    Ok(done)
}

/// To the trash; from the trash (or without one) for good, which cannot be undone.
#[tauri::command]
pub async fn delete_messages(state: St<'_>, ids: Vec<i64>) -> CmdResult<Vec<Moved>> {
    let mut done = Vec::new();
    for ((account_id, folder), rows) in group_rows(&state, &ids)? {
        match state.store.folder_by_role(&account_id, FolderRole::Trash)? {
            Some(trash) if trash != folder => done.push(move_group(&state, &account_id, &folder, &rows, &trash).await?),
            _ => {
                let uids = rows.iter().map(|r| r.uid).collect();
                state.worker(&account_id)?.run(Work::Delete { folder, uids }).await?;
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
    for ((account_id, folder), rows) in group_rows(&state, &ids)? {
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
        let snoozed = role_folder(&state, &account_id, FolderRole::Snoozed, pick("Snoozed", "Отложенные")).await?;
        // Snoozing again from the Snoozed folder keeps the original destination.
        for r in &rows {
            let mid = r.message_id.clone().unwrap_or_default();
            let return_to = state
                .store
                .snooze_remove(&account_id, &mid)?
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
        if folder != snoozed {
            done.push(move_group(&state, &account_id, &folder, &rows, &snoozed).await?);
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
#[tauri::command]
pub fn thread(state: St<'_>, id: i64) -> CmdResult<Vec<MessageRow>> {
    let r = row(&state, id)?;
    Ok(state.store.thread(&r.account_id, &r.thread)?)
}

#[derive(Serialize)]
pub struct Counters {
    snoozed: u32,
    followups: u32,
}

#[tauri::command]
pub fn counters(state: St<'_>) -> CmdResult<Counters> {
    Ok(Counters {
        snoozed: state.store.snoozed_count(state.settings().threads)?,
        followups: state.store.followups_count()?,
    })
}

/// No answer yet and not now: the reminder comes again `secs` from now.
#[tauri::command]
pub fn followup_postpone(state: St<'_>, id: i64, secs: i64) -> CmdResult<i64> {
    let r = row(&state, id)?;
    let due = chrono::Utc::now().timestamp() + secs.max(60);
    if let Some(mid) = &r.message_id {
        state.store.followup_postpone(&r.account_id, mid, due)?;
    }
    state.emit("counters-changed", serde_json::json!({}));
    Ok(due)
}

#[tauri::command]
pub fn followup_cancel(state: St<'_>, id: i64) -> CmdResult<()> {
    let r = row(&state, id)?;
    if let Some(mid) = &r.message_id {
        state.store.followup_remove(&r.account_id, mid)?;
    }
    state.emit("counters-changed", serde_json::json!({}));
    Ok(())
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Unsubscribed {
    /// The sender's server confirmed the one-click request.
    Done,
    /// A request went out by mail through the outbox.
    MailSent { to: String },
    /// Only a web page is offered; the user decides whether to open it.
    Link { url: String },
}

/// Leaves a mailing list the way its sender offers: one click (RFC 8058) first,
/// then a request by mail, then the web page.
#[tauri::command]
pub async fn unsubscribe(state: St<'_>, id: i64) -> CmdResult<Unsubscribed> {
    let r = row(&state, id)?;
    let Some(u) = state.store.unsubscribe_of(id)? else {
        return Err(CmdError::new(
            "not-found",
            tr!(
                "the sender gave no way to unsubscribe",
                "отправитель не указал, как отписаться"
            ),
        ));
    };
    if let Some(url) = &u.one_click {
        match depesha_core::unsubscribe::one_click(url).await {
            Ok(_) => return Ok(Unsubscribed::Done),
            Err(e) if u.mailto.is_none() => return Err(e.into()),
            Err(e) => tracing::info!("one-click unsubscribe failed, trying mail: {e}"),
        }
    }
    if let Some((to, subject, text)) = u.mailto.as_deref().and_then(depesha_core::unsubscribe::mailto) {
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
        state.store.outbox_add(&account.id, &draft, now, now, 0)?;
        state.outbox_notify.notify_one();
        state.emit("outbox-changed", serde_json::json!({}));
        return Ok(Unsubscribed::MailSent { to });
    }
    match u.http {
        Some(url) => Ok(Unsubscribed::Link { url }),
        None => Err(CmdError::new(
            "not-found",
            tr!(
                "the sender gave no way to unsubscribe",
                "отправитель не указал, как отписаться"
            ),
        )),
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
    let offline_changed =
        before.offline != settings.offline || before.offline_attachments != settings.offline_attachments;
    state.save_settings(settings)?;
    state.apply_language();
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
#[tauri::command]
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
            None => match state.worker(&account_id)?.run(Work::UserPhoto(email.clone())).await {
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

#[tauri::command]
pub fn trust_sender(state: St<'_>, email: String) -> CmdResult<()> {
    Ok(state.store.trust_sender(&email)?)
}

#[tauri::command]
pub fn addresses(state: St<'_>, prefix: String) -> CmdResult<Vec<Addr>> {
    Ok(state.store.known_addresses(&prefix, 8)?)
}

#[tauri::command]
pub async fn attachment_save(state: St<'_>, id: i64, index: u32, path: String) -> CmdResult<()> {
    let row = row(&state, id)?;
    let raw = raw_of(&state, &row).await?;
    let (_, bytes) = message::attachment(&raw, index)?;
    tokio::fs::write(&path, bytes).await?;
    mark_from_internet(std::path::Path::new(&path)).await;
    Ok(())
}

/// Saves an attachment into the folder from the settings, without asking where:
/// renamed on a name clash, the folder made again if it went away. Returns the path.
#[tauri::command]
pub async fn attachment_save_in(state: St<'_>, id: i64, index: u32, dir: String) -> CmdResult<String> {
    let row = row(&state, id)?;
    let raw = raw_of(&state, &row).await?;
    let (info, bytes) = message::attachment(&raw, index)?;
    let folder = save_folder(&dir).await?;
    let path = free_path(&folder, &safe_name(&info.name));
    tokio::fs::write(&path, bytes).await.map_err(|e| save_error(&dir, e))?;
    mark_from_internet(&path).await;
    Ok(path.to_string_lossy().into_owned())
}

/// Saves every attachment into a folder, renaming on name clashes. Returns how many.
#[tauri::command]
pub async fn attachments_save_all(state: St<'_>, id: i64, dir: String) -> CmdResult<usize> {
    let row = row(&state, id)?;
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

/// An attached HTML or Markdown file, cleaned like a letter for the viewer.
#[tauri::command]
pub fn document_html(text: String, markdown: bool) -> String {
    message::document_html(&text, markdown)
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
    in_reply_to: Option<String>,
    #[serde(default)]
    references: Vec<String>,
    #[serde(default)]
    attachments: Vec<AttachmentSource>,
    /// Scheduled sending time: kept with a saved draft, the send takes `at` instead.
    #[serde(default)]
    send_at: Option<i64>,
}

async fn resolve(state: &AppState, d: ComposeDraft) -> CmdResult<Draft> {
    let mut attachments = Vec::new();
    let mut total = 0u64;
    for a in d.attachments {
        let att = match a {
            AttachmentSource::File { path } => {
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
        html: None,
        in_reply_to: d.in_reply_to,
        references: d.references,
        attachments,
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
/// asks for a reminder when no answer comes that long after sending.
/// `discard_draft` removes the server draft it came from.
#[tauri::command]
pub async fn send(
    state: St<'_>,
    account_id: String,
    draft: ComposeDraft,
    discard_draft: Option<i64>,
    at: Option<i64>,
    followup_days: Option<u32>,
    followup_secs: Option<i64>,
) -> CmdResult<Queued> {
    let account = state.account(&account_id)?;
    let draft = resolve(&state, draft).await?;
    smtp::build(&draft)?; // validate addresses now, not in the background
    let now = chrono::Utc::now().timestamp();
    let at = at.unwrap_or(now + i64::from(state.settings().undo_send_secs));
    let followup = followup_secs
        .unwrap_or(i64::from(followup_days.unwrap_or(0)) * 86_400)
        .max(0);
    let id = state.store.outbox_add(&account.id, &draft, now, at, followup)?;
    state.outbox_notify.notify_one();
    state.emit("outbox-changed", serde_json::json!({}));
    if let Some(d) = discard_draft {
        let _ = discard(&state, d).await;
    }
    Ok(Queued { id, at: at.max(now) })
}

async fn discard(state: &AppState, id: i64) -> CmdResult<()> {
    let r = row(state, id)?;
    state
        .worker(&r.account_id)?
        .run(Work::Delete {
            folder: r.folder,
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

#[tauri::command]
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

#[tauri::command]
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
#[tauri::command]
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
pub async fn temp_attachment(app: tauri::AppHandle, name: String, data: String) -> CmdResult<String> {
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
    Ok(path.to_string_lossy().into_owned())
}

#[derive(Serialize)]
pub struct FileInfo {
    name: String,
    size: u64,
}

#[tauri::command]
pub async fn file_info(path: String) -> CmdResult<FileInfo> {
    let meta = tokio::fs::metadata(&path).await?;
    let name = PathBuf::from(&path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(FileInfo { name, size: meta.len() })
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

#[tauri::command]
pub fn extension_install(app: tauri::AppHandle, state: St<'_>, path: String) -> CmdResult<crate::extensions::Manifest> {
    let m = crate::extensions::install(&app, std::path::Path::new(&path))?;
    state.emit("extensions-changed", serde_json::json!({ "id": m.id }));
    Ok(m)
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
#[tauri::command]
pub fn messages_by_id(state: St<'_>, ids: Vec<i64>) -> CmdResult<Vec<MessageRow>> {
    let mut out = Vec::new();
    for id in ids {
        if let Some(r) = state.store.get(id)? {
            out.push(r);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{DANGEROUS, free_path, safe_name};

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
