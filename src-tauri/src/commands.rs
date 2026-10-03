use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use depesha_core::account::{Account, Credentials};
use depesha_core::autodetect::{self, Detection};
use depesha_core::imap::{self, FlagChange, FolderRole};
use depesha_core::message::{self, Addr, MessageView};
use depesha_core::smtp::{self, Draft, OutgoingAttachment};
use depesha_core::store::{FolderInfo, ListQuery, MessageRow, OutboxItem, Snooze};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::config::Settings;
use crate::error::{CmdError, CmdResult};
use crate::secrets;
use crate::state::{AccountStatus, AppState};
use crate::worker::{self, Output, Work};

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

/// Logs in to IMAP and SMTP with the given settings; nothing is saved.
#[tauri::command]
pub async fn account_check(account: Account, password: Option<String>) -> CmdResult<()> {
    let password = match password.filter(|p| !p.is_empty()) {
        Some(p) => p,
        None => secrets::get(&account.id)
            .await?
            .ok_or_else(|| CmdError::new("auth", "введите пароль"))?,
    };
    let creds = Credentials::new(account.username.clone(), password);
    let mut conn = imap::connect(&account.imap, &creds)
        .await
        .map_err(|e| prefix("IMAP", e))?;
    let _ = conn.session.logout().await;
    smtp::check(&account.smtp, &creds)
        .await
        .map_err(|e| prefix("SMTP", e))?;
    Ok(())
}

fn prefix(proto: &str, e: depesha_core::Error) -> CmdError {
    let mut err = CmdError::from(e);
    err.message = format!("{proto}: {}", err.message);
    err
}

#[tauri::command]
pub async fn account_save(state: St<'_>, mut account: Account, password: Option<String>) -> CmdResult<Account> {
    if account.id.is_empty() {
        account.id = format!(
            "{}-{}",
            account.email.to_lowercase(),
            chrono::Utc::now().timestamp_millis()
        );
        account.save_sent_copy = !account.imap.host.ends_with("gmail.com");
    }
    if account.display_name.trim().is_empty() {
        account.display_name = account.email.clone();
    }
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        secrets::set(&account.id, p).await?;
    }
    state.save_account(account.clone())?;
    let worker = worker::spawn(state.inner().clone(), account.clone());
    state.set_worker(&account.id, Some(worker));
    Ok(account)
}

#[tauri::command]
pub async fn account_remove(state: St<'_>, id: String) -> CmdResult<()> {
    state.set_worker(&id, None);
    state.remove_account(&id)?;
    state.store.forget_account(&id)?;
    secrets::delete(&id).await?;
    Ok(())
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
pub fn search(state: St<'_>, text: String, account_id: Option<String>) -> CmdResult<Vec<MessageRow>> {
    Ok(state.store.search(&text, account_id.as_deref(), 300)?)
}

/// Searches on the servers: inbox, sent and archive of every account (or one account).
/// Finds mail older than the local cache window. Errors of single folders are skipped.
#[tauri::command]
pub async fn server_search(state: St<'_>, text: String, account_id: Option<String>) -> CmdResult<Vec<MessageRow>> {
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
                    text: text.clone(),
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
        _ => Err(CmdError::new("other", "сервер не вернул письмо")),
    }
}

fn row(state: &AppState, id: i64) -> CmdResult<MessageRow> {
    state
        .store
        .get(id)?
        .ok_or_else(|| CmdError::new("not-found", "письмо уже удалено или перемещено"))
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

/// The folder with this role, created under `name` when the server has none.
async fn role_folder(state: &AppState, account_id: &str, role: FolderRole, name: &str) -> CmdResult<String> {
    if let Some(f) = state.store.folder_by_role(account_id, role)? {
        return Ok(f);
    }
    state
        .worker(account_id)?
        .run(Work::CreateFolder(name.to_owned()))
        .await?;
    state
        .store
        .folder_by_role(account_id, role)?
        .ok_or_else(|| CmdError::new("not-found", format!("не удалось создать папку «{name}» на сервере")))
}

#[tauri::command]
pub async fn set_flag(state: St<'_>, ids: Vec<i64>, change: FlagChange) -> CmdResult<()> {
    for ((account_id, folder), uids) in group(&state, &ids)? {
        // Local first so the list reacts at once; the next sync fixes it if the server refuses.
        let flags: Vec<_> = uids
            .iter()
            .filter_map(|uid| state.store.find_by_uid(&account_id, &folder, *uid).ok().flatten())
            .map(|r| {
                let mut f = r.flags;
                match change {
                    FlagChange::Seen(v) => f.seen = v,
                    FlagChange::Flagged(v) => f.flagged = v,
                    FlagChange::Answered(v) => f.answered = v,
                }
                (r.uid, f)
            })
            .collect();
        state.store.update_flags(&account_id, &folder, &flags)?;
        state.emit(
            "mail-changed",
            serde_json::json!({ "account_id": account_id, "folder": folder }),
        );
        state
            .worker(&account_id)?
            .run(Work::SetFlag { folder, uids, change })
            .await?;
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
        let archive = role_folder(&state, &account_id, FolderRole::Archive, "Архив").await?;
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
        let junk = role_folder(&state, &account_id, FolderRole::Junk, "Спам").await?;
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
            return Err(CmdError::new("other", "у письма нет Message-ID, отложить его нельзя"));
        }
        let snoozed = role_folder(&state, &account_id, FolderRole::Snoozed, "Отложенные").await?;
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
    for m in moved {
        for mid in &m.message_ids {
            state.store.snooze_remove(&m.account_id, mid)?;
        }
        state
            .worker(&m.account_id)?
            .run(Work::MoveByMessageId {
                from: m.to,
                message_ids: m.message_ids,
                to: m.from,
                unseen: false,
            })
            .await?;
    }
    state.emit("counters-changed", serde_json::json!({}));
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
        snoozed: state.store.snoozed_count()?,
        followups: state.store.followups_count()?,
    })
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
        return Err(CmdError::new("not-found", "отправитель не указал, как отписаться"));
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
        None => Err(CmdError::new("not-found", "отправитель не указал, как отписаться")),
    }
}

#[tauri::command]
pub fn settings_get(state: St<'_>) -> Settings {
    state.settings()
}

#[tauri::command]
pub fn settings_set(state: St<'_>, settings: Settings) -> CmdResult<()> {
    state.save_settings(settings)?;
    state.emit("settings-changed", serde_json::json!({}));
    Ok(())
}

#[tauri::command]
pub async fn load_older(state: St<'_>, account_id: String, folder: String) -> CmdResult<usize> {
    match state.worker(&account_id)?.run(Work::LoadOlder { folder }).await? {
        Output::Count(n) => Ok(n),
        _ => Ok(0),
    }
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
    tokio::fs::write(path, bytes).await?;
    Ok(())
}

/// Saves every attachment into a folder, renaming on name clashes. Returns how many.
#[tauri::command]
pub async fn attachments_save_all(state: St<'_>, id: i64, dir: String) -> CmdResult<usize> {
    let row = row(&state, id)?;
    let raw = raw_of(&state, &row).await?;
    let view = message::parse_view(&raw, false)?;
    let mut saved = 0;
    for info in view
        .attachments
        .iter()
        .filter(|a| !(a.inline && a.content_id.is_some()))
    {
        let (_, bytes) = message::attachment(&raw, info.index)?;
        let path = free_path(&PathBuf::from(&dir), &safe_name(&info.name));
        tokio::fs::write(path, bytes).await?;
        saved += 1;
    }
    Ok(saved)
}

const DANGEROUS: &[&str] = &[
    "exe", "msi", "bat", "cmd", "com", "scr", "pif", "vbs", "vbe", "js", "jse", "wsf", "wsh", "ps1", "jar", "lnk",
    "desktop", "sh", "run", "appimage", "deb", "rpm", "reg", "hta", "cpl", "msc",
];

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
            format!("«{name}» — исполняемый файл. Открывать его из письма опасно; сохраните его, если уверены"),
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
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| CmdError::new("io", format!("не удалось открыть файл: {e}")))
}

fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '\0' | '<' | '>' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_owned();
    if cleaned.is_empty() {
        "attachment".into()
    } else {
        cleaned
    }
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
        return Err(CmdError::new("dangerous", "такие ссылки не открываются"));
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
            "вложения больше 50 МБ — почтовые серверы такое не примут",
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
/// the undo delay from the settings. `followup_days` asks for a reminder when no
/// answer comes. `discard_draft` removes the server draft it came from.
#[tauri::command]
pub async fn send(
    state: St<'_>,
    account_id: String,
    draft: ComposeDraft,
    discard_draft: Option<i64>,
    at: Option<i64>,
    followup_days: Option<u32>,
) -> CmdResult<Queued> {
    let account = state.account(&account_id)?;
    let draft = resolve(&state, draft).await?;
    smtp::build(&draft)?; // validate addresses now, not in the background
    let now = chrono::Utc::now().timestamp();
    let at = at.unwrap_or(now + i64::from(state.settings().undo_send_secs));
    let followup = i64::from(followup_days.unwrap_or(0)) * 86_400;
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

/// Saves the draft into the server's Drafts folder, replacing the previous version.
#[tauri::command]
pub async fn draft_save(state: St<'_>, account_id: String, draft: ComposeDraft, replace: Option<i64>) -> CmdResult<()> {
    let account = state.account(&account_id)?;
    let Some(folder) = state.store.folder_by_role(&account.id, FolderRole::Drafts)? else {
        return Err(CmdError::new("not-found", "на сервере нет папки «Черновики»"));
    };
    let mut draft = resolve(&state, draft).await?;
    if draft.to.is_empty() && draft.cc.is_empty() && draft.bcc.is_empty() {
        // A draft may have no recipients yet; the builder insists on one.
        draft.to.push(draft.from.clone().unwrap_or(Addr {
            name: None,
            email: account.email.clone(),
        }));
    }
    let raw = smtp::build(&draft)?.formatted();
    let worker = state.worker(&account.id)?;
    worker
        .run(Work::Append {
            folder,
            raw,
            flags: "(\\Draft \\Seen)".into(),
            message_id: None,
        })
        .await?;
    if let Some(old) = replace {
        let _ = discard(&state, old).await;
    }
    Ok(())
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
