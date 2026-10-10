//! «Clear» for Trash, Junk and Drafts (#74): the glue of the rules of `depesha_core::clear`
//! with the app. Here are the tasks window («N of M» with «Stop», the summary of a run that
//! failed), the events that tell the windows, the sync after a run and the local copies of
//! the drafts on disk. The rules of what is wiped and what stays are in the core.

use crate::lang::pick;
use crate::tr;
use depesha_core::Result;
use depesha_core::account::Account;
use depesha_core::clear::{self, Emptied, Emptying, Forgot};
use depesha_core::domain::FolderRole;
use depesha_core::mail::{self, Conn};
use serde::Serialize;
use serde_json::json;

use crate::error::CmdError;
use crate::state::AppState;
use crate::worker::{Output, Work, sync_one};

/// One emptying, as the mailbox's queue gets it.
#[derive(Debug, Clone)]
pub struct Request {
    pub job: clear::Request<mail::Bound>,
    /// The task's name in the tasks window.
    pub label: String,
    pub key: String,
}

/// What the dialog is told of the folder: how many letters it holds and the bound that
/// counted them, which the run is then asked for.
#[derive(Serialize)]
pub struct FolderCount {
    pub total: usize,
    pub bound: u64,
}

/// The task key: the tasks window retries by it, so it names the folder.
pub fn task_key(account_id: &str, folder: &str) -> String {
    format!("empty:{account_id}:{folder}")
}

pub fn label(role: FolderRole) -> String {
    match role {
        FolderRole::Trash => pick("Clearing Trash", "Очистка корзины").to_owned(),
        FolderRole::Junk => pick("Clearing Spam", "Очистка спама").to_owned(),
        _ => pick("Clearing Drafts", "Очистка черновиков").to_owned(),
    }
}

/// What the tasks window says about a run that failed: how far it got, how much is left, why.
pub fn summary(how: &Emptying, done: usize, total: usize, error: &str) -> String {
    let left = total.saturating_sub(done);
    match how {
        Emptying::Erase => tr!(
            "Erased {done} of {total}, {left} left. {error}",
            "Стёрто {done} из {total}, осталось {left}. {error}"
        ),
        Emptying::ToFolder(_) => tr!(
            "Moved {done} of {total}, {left} left. {error}",
            "Перенесено {done} из {total}, осталось {left}. {error}"
        ),
    }
}

/// Runs in the mailbox's queue (`Work::EmptyFolder`).
pub async fn perform(state: &AppState, account: &Account, conn: &mut Conn, req: &Request) -> Result<Output> {
    let id = account.id.as_str();
    let key = req.key.as_str();
    state.task_stop_clear(key);
    state.task(key, "empty", Some(id), req.label.clone(), 0, 0);
    let folder = req.job.folder.as_str();
    let mut progress = |done: usize, total: usize| {
        state.task(key, "empty", Some(id), req.label.clone(), done as u64, total as u64);
        !state.task_stop_requested(key)
    };
    let mut cache_forgot = |forgot: Forgot| match forgot {
        Forgot::Done => {
            state.emit("mail-changed", json!({ "account_id": id, "folder": folder }));
            state.emit("counters-changed", json!({}));
        }
        Forgot::NotRead(e) => tracing::warn!(account = %id, "cache of {folder} not read: {e}"),
        Forgot::NotCleared(e) => tracing::warn!(account = %id, "cache of {folder} not cleared: {e}"),
    };
    let done = mail::clear_folder(
        conn,
        &state.store,
        &state.clearing,
        id,
        &req.job,
        &mut progress,
        &mut cache_forgot,
    )
    .await;
    state.task_stop_clear(key);
    // The cache follows the server whatever came of the run.
    let mut synced = vec![&req.job.folder];
    if let Emptying::ToFolder(to) = &req.job.how {
        synced.push(to);
    }
    for folder in synced {
        if let Err(e) = sync_one(state, account, conn, folder, false).await {
            tracing::warn!(account = %id, "sync of {folder} after clearing failed: {e}");
        }
    }
    match done.result {
        Ok(run) => {
            state.task_done(key);
            Ok(Output::Emptied(run, done.kept_ids))
        }
        Err(e) => {
            let mut shown = CmdError::from(e.clone());
            shown.message = summary(&req.job.how, done.last.0, done.last.1, &crate::localize::error_now(&e));
            state.task_failed(key, shown);
            Err(e)
        }
    }
}

/// The role of a folder that «Clear» is offered for; anything else is refused.
pub fn role_of(state: &AppState, account_id: &str, folder: &str) -> std::result::Result<FolderRole, CmdError> {
    clear::clearable_role(&state.store, account_id, folder).ok_or_else(|| {
        CmdError::new(
            depesha_core::ErrorKind::Other,
            tr!(
                "only Trash, Spam and Drafts can be cleared",
                "очистить можно только Корзину, Спам и Черновики"
            ),
        )
    })
}

/// Empties the folder. `trash` is where Drafts go; `keep_ids` are the cache ids of the
/// drafts that windows have open, which stay with the ones the backend knows are open
/// (`Clearing::open_ids`). `bound` is what the dialog counted (`FolderCount`).
pub async fn run(
    state: &AppState,
    account_id: &str,
    folder: &str,
    role: FolderRole,
    trash: Option<String>,
    keep_ids: Vec<i64>,
    bound: u64,
) -> std::result::Result<Emptied, CmdError> {
    require_online(state, account_id)?;
    let drafts = role == FolderRole::Drafts;
    let Some(how) = Emptying::of(role, trash) else {
        return Err(CmdError::new(
            depesha_core::ErrorKind::Other,
            tr!(
                "there is no Trash to move the drafts to",
                "нет Корзины, куда убрать черновики"
            ),
        ));
    };
    let held = state.bounds.bound(bound, account_id, folder).ok_or_else(|| {
        CmdError::new(
            depesha_core::ErrorKind::Other,
            tr!(
                "the list to clear is out of date, clear the folder again",
                "список для очистки устарел, очистите папку заново"
            ),
        )
    })?;
    state.bounds.confirm(bound);
    let mut copies = Vec::new();
    if drafts {
        // The windows' record is read after the copies on disk (`leaving_copies`), so what shifts
        // in between errs on the safe side: a draft opened since is spared (its id is in the
        // record), a copy written since is not in `copies` and so is never dropped, and a window
        // that closed leaves its draft on the server, whose copy then follows it as it is meant to.
        copies = crate::drafts::read_all(&crate::drafts::dir(&state.app)?).await?;
    }
    let (keep_ids, leaving) = clear::leaving_copies(
        &state.store,
        &state.clearing,
        &copies,
        account_id,
        folder,
        &keep_ids,
        &held,
    );
    let request = Request {
        job: clear::Request {
            folder: folder.to_owned(),
            how,
            bound: held,
            keep_ids,
            drafts,
        },
        label: label(role),
        key: task_key(account_id, folder),
    };
    let (run, kept_ids) = match state.worker(account_id)?.run(Work::EmptyFolder(request)).await? {
        Output::Emptied(run, kept) => (run, kept),
        _ => (Emptied::default(), Vec::new()),
    };
    // Only a finished run takes the copies with it: after a stop the drafts left in the folder
    // keep theirs.
    if !run.stopped {
        state.bounds.release(bound);
    }
    if drafts && !run.stopped {
        // A draft opened while the run waited stayed in the folder, and so does its copy.
        crate::drafts::drop_all(
            &state.app,
            &clear::copies_to_drop(leaving, &copies, &kept_ids, &state.clearing.open_ids()),
        )
        .await?;
    }
    Ok(run)
}

/// How many drafts of the mailbox's Drafts folder windows have open: the number the dialog
/// says will stay.
pub fn open_drafts(state: &AppState, account_id: &str) -> usize {
    clear::open_in_drafts(&state.store, &state.clearing, account_id)
}

/// A run that began is refused while the mailbox is not online: the queue would hold an
/// irreversible action for as long as the network is down.
pub fn require_online(state: &AppState, account_id: &str) -> std::result::Result<(), CmdError> {
    if state.status(account_id).is_some_and(|s| s.state == "online") {
        return Ok(());
    }
    Err(CmdError::new(
        depesha_core::ErrorKind::Network,
        tr!("no connection to the server", "нет соединения с сервером"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_run_says_how_far_it_got_and_what_is_left() {
        crate::lang::pin(crate::lang::Lang::Ru);
        assert_eq!(
            summary(&Emptying::Erase, 1200, 2100, "превышено время ожидания"),
            "Стёрто 1200 из 2100, осталось 900. превышено время ожидания"
        );
        assert_eq!(
            summary(&Emptying::ToFolder("Trash".into()), 3, 4, "x"),
            "Перенесено 3 из 4, осталось 1. x"
        );
    }
}
