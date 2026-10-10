//! The account's server as the settings show it: what a login found and the quota,
//! kept in the cache as the worker logs in and syncs, so the settings work without a
//! network; a check on request; the folder sizes counted at the user's request as a
//! background task in the tasks window.

use depesha_core::{best_effort, unheard};
use std::sync::Arc;

use crate::tr;
use depesha_core::account::Account;
use depesha_core::mail::Conn;
use depesha_core::store::{FolderSizes, QuotaSeen, ServerCaps, ServerInfo};
use depesha_core::{Error, ews, imap, quota};
use serde::Serialize;
use serde_json::json;

use crate::error::{CmdError, CmdResult};
use crate::state::AppState;

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn sizes_task(account_id: &str) -> String {
    format!("sizes:{account_id}")
}

/// The windows read the server's state again.
pub(crate) fn changed(state: &AppState, account_id: &str) {
    state.emit("server-changed", json!({ "account_id": account_id }));
}

/// Keeps the capabilities a login found.
pub fn keep_login(state: &AppState, account_id: &str, conn: &imap::Conn) {
    let caps = ServerCaps {
        greeting: conn.greeting.clone().unwrap_or_default(),
        capabilities: conn.capabilities.clone(),
        detected: now(),
    };
    match state.store.save_server_caps(account_id, &caps) {
        Ok(true) => changed(state, account_id),
        Ok(false) => {}
        Err(e) => tracing::warn!(account = %account_id, "capabilities not kept: {e}"),
    }
}

/// Reads the quota again on this connection: a full sync's, not every IDLE wakeup's.
pub async fn refresh_quota(state: &AppState, account_id: &str, conn: &mut imap::Conn) -> depesha_core::Result<()> {
    let quota = quota::quota(conn).await?;
    state.store.save_quota(account_id, quota.as_ref(), now())?;
    // The time of the reading changed, if nothing else did.
    changed(state, account_id);
    Ok(())
}

/// The occupied space of an Exchange mailbox: EWS has no store object, so no limit is
/// read ([MS-OXCSTOR]) — the space is summed over every folder. Kept as the mailbox's
/// quota with `limit` 0, which the frontend reads as "no server limit". The quota is
/// written even when it is zero: "counted nothing" must not look like "not counted".
pub async fn refresh_ews_quota(state: &AppState, account_id: &str, s: &mut ews::Session) -> depesha_core::Result<()> {
    let (bytes, folders) = ews::mailbox_bytes(s).await?;
    if bytes == 0 && folders > 0 {
        // Folders walked but none reported `PR_MESSAGE_SIZE_EXTENDED`: the account would
        // otherwise show a truthful zero with no sign the property was never there.
        tracing::warn!(
            account = %account_id,
            folders,
            "Exchange reported no folder size: the occupied space reads as zero"
        );
    }
    state
        .store
        .save_quota(account_id, Some(&quota::ews_quota(bytes)), now())?;
    changed(state, account_id);
    Ok(())
}

/// "Check again": a fresh login, ENABLE as the syncing session does it, and the quota.
pub async fn check(state: &AppState, account: &Account) -> depesha_core::Result<()> {
    let Conn::Imap(mut conn) = state.connect(account).await? else {
        return Ok(());
    };
    keep_login(state, &account.id, &conn);
    imap::enable_qresync(&mut conn).await?;
    if let Some(enabled) = conn.enabled.take() {
        state.store.save_server_enable(&account.id, &enabled, now())?;
    }
    // What the login found is the check; a quota the server is stuck on does not undo it.
    if let Err(e) = refresh_quota(state, &account.id, &mut conn).await {
        tracing::warn!(account = %account.id, "quota not read: {e}");
        changed(state, &account.id);
        return Ok(());
    }
    best_effort("log out", conn.session.logout().await);
    changed(state, &account.id);
    Ok(())
}

/// The "Server" and "Storage" sections of a mailbox's page.
#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ServerView {
    #[serde(flatten)]
    info: ServerInfo,
    /// The account's mail kept whole on this computer: not on the server, not in the quota.
    cache_bytes: u64,
    /// How often INBOX is checked on a server without IDLE.
    poll_secs: u64,
    /// A folder size count under way: folders done and all of them.
    counting: Option<(u64, u64)>,
    /// The namespaces the server named (RFC 2342); empty when unknown.
    namespaces: depesha_core::acl::Namespace,
    /// Every folder's props the cache has, for the "Folders" subsection.
    folders: Vec<depesha_core::acl::FolderProps>,
}

pub fn view(state: &AppState, account_id: &str) -> CmdResult<ServerView> {
    Ok(ServerView {
        info: state.store.server_info(account_id)?,
        cache_bytes: state.store.cache_bytes(account_id)?,
        poll_secs: crate::worker::POLL_WITHOUT_IDLE.as_secs(),
        counting: state.task_progress(&sizes_task(account_id)),
        namespaces: state
            .store
            .namespaces(account_id)?
            .map(|(ns, _)| ns)
            .unwrap_or_default(),
        folders: state.store.folder_props(account_id)?,
    })
}

/// Every mailbox's room, for the sidebar: the server's quota, or (Exchange) the
/// occupied space, or the sum of the folder sizes the user had counted.
#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct QuotaView {
    account_id: String,
    quota: Option<QuotaSeen>,
    /// The folders counted, in bytes; `partial` when some could not be.
    estimate: Option<Estimate>,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Estimate {
    bytes: u64,
    partial: bool,
    counted: i64,
}

pub fn quotas(state: &AppState) -> CmdResult<Vec<QuotaView>> {
    state
        .accounts()
        .into_iter()
        .map(|a| {
            // Exchange folders are not counted by request (no STATUS=SIZE): no estimate.
            let estimate = state.store.folder_sizes(&a.id)?.map(|s| Estimate {
                bytes: s.folders.iter().filter_map(|f| f.bytes).sum(),
                partial: s.folders.iter().any(|f| f.error.is_some()),
                counted: s.counted,
            });
            Ok(QuotaView {
                quota: state.store.quota(&a.id)?,
                account_id: a.id,
                estimate,
            })
        })
        .collect()
}

/// Starts counting the size of every folder, unless a count of this mailbox is under
/// way. It runs on a connection of its own (`quota::folder_sizes`), so syncing and the
/// user's actions do not wait for it.
pub fn count_sizes(state: Arc<AppState>, account: Account) -> CmdResult<()> {
    if account.is_ews() {
        return Err(CmdError::new(
            depesha_core::ErrorKind::Input,
            tr!(
                "Exchange mailboxes are not counted yet",
                "размер папок Exchange пока не считается"
            ),
        ));
    }
    let id = account.id.clone();
    let key = sizes_task(&id);
    // The "counting" state is claimed before anything is spawned or announced, so a second
    // "Count" finds it and returns at once, and a stop arriving in the meantime is not lost.
    let Some(generation) = state.begin_count(&id) else {
        return Ok(());
    };
    let folders: Vec<String> = match state.store.folders(Some(&id)) {
        Ok(list) => list
            .into_iter()
            .filter(|f| f.folder.selectable && !f.folder.hidden)
            .map(|f| f.folder.name)
            .collect(),
        Err(e) => {
            state.abandon_count(&id, generation);
            return Err(e.into());
        }
    };
    let total = folders.len() as u64;
    let name = if account.label.is_empty() {
        account.email.clone()
    } else {
        account.label.clone()
    };
    let label = tr!("Folder sizes: {name}", "Размер папок: {name}");
    state.while_count(&id, Some(generation), || {
        state.task(&key, crate::tasks::TaskKind::Sizes, Some(&id), label.clone(), 0, total)
    });
    changed(&state, &id);

    let id_kept = id.clone();
    let task_state = state.clone();
    // The count starts once its handle is kept (or the stop came first: then it does not).
    let (go, ready) = tokio::sync::oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        let state = task_state;
        best_effort("the start signal", ready.await);
        let result = async {
            let Conn::Imap(mut conn) = state.connect(&account).await? else {
                return Err(Error::NotFound);
            };
            let (method, sizes) = quota::folder_sizes(&mut conn, &folders, |done| {
                // A stopped count says nothing more: its task is gone from the list.
                state.while_count(&id, Some(generation), || {
                    state.task(
                        &key,
                        crate::tasks::TaskKind::Sizes,
                        Some(&id),
                        label.clone(),
                        done as u64,
                        total,
                    )
                });
            })
            .await?;
            // The connection was read past the IMAP library: it is not used again.
            drop(conn);
            state.store.save_folder_sizes(
                &id,
                &FolderSizes {
                    counted: now(),
                    method,
                    folders: sizes,
                },
            )
        }
        .await;
        if let Err(e) = &result {
            tracing::warn!(account = %id, "folder sizes not counted: {e}");
        }
        // After a stop the task is not this count's to end: a new one may have its key.
        state.end_count(&id, generation, || match result {
            Ok(()) => state.task_done(&key),
            Err(e) => state.task_failed(&key, CmdError::from(e)),
        });
        changed(&state, &id);
    });
    if state.keep_count(&id_kept, generation, handle.abort_handle()) {
        unheard(go.send(()));
    } else {
        // A stop arrived between the claim and the spawn: the count must not run. Its task
        // is gone already: the stop took it away, or it was never announced (above).
        handle.abort();
    }
    Ok(())
}

/// Stops a count under way; what was counted before stays.
pub fn stop_count(state: &AppState, account_id: &str) {
    state.stop_count(account_id, || state.task_done(&sizes_task(account_id)));
    changed(state, account_id);
}

/// A full mailbox while the window is out of sight: a desktop notification, as the
/// in-app warning would go unseen. The window decides when the mailbox became full.
pub fn notify_full(state: &AppState, title: &str, body: &str) {
    use tauri::Manager;
    let hidden = state
        .app
        .get_webview_window("main")
        .is_none_or(|w| !w.is_visible().unwrap_or(true) || w.is_minimized().unwrap_or(false));
    if hidden {
        state.notify(title, body, false);
    }
}
