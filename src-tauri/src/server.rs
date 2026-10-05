//! The account's server as the settings show it: what a login found, kept in the cache
//! as the worker logs in, so the settings work without a network; a check on request.

use depesha_core::account::Account;
use depesha_core::imap;
use depesha_core::mail::Conn;
use depesha_core::store::{ServerCaps, ServerInfo};
use serde::Serialize;
use serde_json::json;

use crate::error::CmdResult;
use crate::state::AppState;

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// The windows read the server's state again.
fn changed(state: &AppState, account_id: &str) {
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

/// "Check again": a fresh login, and ENABLE as the syncing session does it.
pub async fn check(state: &AppState, account: &Account) -> depesha_core::Result<()> {
    let Conn::Imap(mut conn) = state.connect(account).await? else {
        return Ok(());
    };
    keep_login(state, &account.id, &conn);
    imap::enable_qresync(&mut conn).await?;
    if let Some(enabled) = conn.enabled.take() {
        state.store.save_server_enable(&account.id, &enabled, now())?;
    }
    let _ = conn.session.logout().await;
    changed(state, &account.id);
    Ok(())
}

/// The "Server" section of a mailbox's page.
#[derive(Serialize)]
pub struct ServerView {
    #[serde(flatten)]
    info: ServerInfo,
    /// How often INBOX is checked on a server without IDLE.
    poll_secs: u64,
}

pub fn view(state: &AppState, account_id: &str) -> CmdResult<ServerView> {
    Ok(ServerView {
        info: state.store.server_info(account_id)?,
        poll_secs: crate::worker::POLL_WITHOUT_IDLE.as_secs(),
    })
}
