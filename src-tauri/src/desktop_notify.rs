//! Desktop notifications that open what they tell about (#63). tauri-plugin-notification
//! drops the handle on the desktop, so a click never came back; here it does: on Linux
//! over D-Bus (notify-rust), on Windows through the toast's activation (WinRT).
//!
//! New mail is told once per check of all mailboxes: one letter by its sender and
//! subject, several by a summary (#4/#63 decisions, frames 10A and 11В). A notification
//! still on screen is replaced, not joined by another one.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use depesha_core::lang::pick;
use depesha_core::store::MessageRow;
use depesha_core::tr;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::state::AppState;

/// A new letter a notification may tell about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Letter {
    pub id: i64,
    pub account_id: String,
    pub folder: String,
    pub message_id: Option<String>,
    /// The sender's name, else the address.
    pub from: String,
    pub from_email: String,
    pub subject: String,
    pub bulk: bool,
}

impl Letter {
    pub fn new(row: &MessageRow) -> Self {
        let from = row.from.as_ref();
        Letter {
            id: row.id,
            account_id: row.account_id.clone(),
            folder: row.folder.clone(),
            message_id: row.message_id.clone(),
            from: from
                .map(|a| {
                    a.name
                        .clone()
                        .filter(|n| !n.trim().is_empty())
                        .unwrap_or_else(|| a.email.clone())
                })
                .unwrap_or_default(),
            from_email: from.map(|a| a.email.clone()).unwrap_or_default(),
            subject: row.subject.clone(),
            bulk: row.bulk,
        }
    }
}

/// Where a click on a notification leads in the main window.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Target {
    /// The mailbox; none for a summary of several: all inboxes.
    pub account_id: Option<String>,
    pub folder: Option<String>,
    /// The letter; none for a summary: the folder opens with nothing selected.
    pub id: Option<i64>,
    /// The new letters a summary tells about: the list tints them while it is open.
    pub ids: Vec<i64>,
    /// To find the letter moved since, or to say which one is gone.
    pub message_id: Option<String>,
    pub subject: String,
    pub from_email: String,
    /// The Outbox: a letter that missed its time waits there, no single letter to open.
    pub outbox: bool,
}

/// A letter of a notification that is no longer where it was, nor anywhere else known.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Gone {
    pub subject: String,
    pub from: String,
}

/// What the main window hears on a click: `notification-open`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Open {
    pub account_id: Option<String>,
    pub folder: Option<String>,
    pub id: Option<i64>,
    pub ids: Vec<i64>,
    /// The Outbox opens instead of a letter (one that missed its time).
    pub outbox: bool,
    pub gone: Option<Gone>,
}

/// Whether two Message-IDs name the same letter; the cache may keep the angle brackets
/// or not, and a letter without one matches anything.
fn same_message(a: Option<&str>, b: Option<&str>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.trim_matches(['<', '>']) == b.trim_matches(['<', '>']),
        _ => true,
    }
}

/// The target as the cache has it now: the letter where it is, found again by its
/// Message-ID after a move, or gone. `in_place` answers a cached letter's folder and
/// Message-ID; `find` a letter by account and Message-ID anywhere; `find_in` the copy in
/// one folder.
pub fn resolve(
    target: &Target,
    in_place: impl Fn(i64) -> Option<(String, Option<String>)>,
    find: impl Fn(&str, &str) -> Option<(i64, String)>,
    find_in: impl Fn(&str, &str, &str) -> Option<(i64, String)>,
) -> Open {
    let mut open = Open {
        account_id: target.account_id.clone(),
        folder: target.folder.clone(),
        id: target.id,
        ids: target.ids.clone(),
        outbox: target.outbox,
        gone: None,
    };
    let Some(id) = target.id else {
        return open;
    };
    // The id is the letter the notification was about only when the Message-ID matches:
    // an id freed by a deletion and taken by a new letter must not open that letter.
    if let Some((folder, message_id)) = in_place(id)
        && same_message(message_id.as_deref(), target.message_id.as_deref())
    {
        open.folder = Some(folder);
        return open;
    }
    let moved = match (&target.account_id, &target.message_id) {
        // The copy in the folder the notification named is the one to open.
        (Some(account), Some(message_id)) => target
            .folder
            .as_ref()
            .and_then(|folder| find_in(account, folder, message_id))
            .or_else(|| find(account, message_id)),
        _ => None,
    };
    match moved {
        Some((id, folder)) => {
            open.id = Some(id);
            open.ids = vec![id];
            open.folder = Some(folder);
        }
        None => {
            open.id = None;
            open.ids = Vec::new();
            open.gone = Some(Gone {
                subject: target.subject.clone(),
                from: target.from_email.clone(),
            });
        }
    }
    open
}

/// What a notification tells about: letters from people, or, when only newsletters
/// came, those (`true`: bulk, shown only with «notify about all»).
pub fn worth(letters: Vec<Letter>) -> (Vec<Letter>, bool) {
    let (people, bulk): (Vec<_>, Vec<_>) = letters.into_iter().partition(|l| !l.bulk);
    if people.is_empty() && !bulk.is_empty() {
        (bulk, true)
    } else {
        (people, false)
    }
}

/// A notification ready to show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shown {
    /// The mailbox it is about, or `*` for several: a fresh one replaces the one with its key.
    pub key: String,
    pub title: String,
    pub body: String,
    pub target: Target,
}

/// The key of a summary over several mailboxes.
pub const ALL: &str = "*";

/// Words new letters: one by its sender and subject; several of one mailbox by their
/// senders; several of more mailboxes by mailbox. The mailbox is named when there are
/// more of them (`mailboxes`), `label` gives its name.
pub fn word(letters: &[Letter], bulk: bool, label: &dyn Fn(&str) -> String, mailboxes: usize) -> Option<Shown> {
    let first = letters.first()?;
    let accounts = distinct(letters.iter().map(|l| l.account_id.as_str()));
    let ids: Vec<i64> = letters.iter().map(|l| l.id).collect();
    let named = |text: String, account: &str| {
        if mailboxes > 1 {
            format!("{text}\n{}", label(account))
        } else {
            text
        }
    };
    if let [one] = letters {
        let title = if one.from.is_empty() {
            pick("(no sender)", "(без отправителя)").to_owned()
        } else {
            one.from.clone()
        };
        let subject = if one.subject.is_empty() {
            pick("(no subject)", "(без темы)").to_owned()
        } else {
            one.subject.clone()
        };
        return Some(Shown {
            key: one.account_id.clone(),
            title,
            body: named(subject, &one.account_id),
            target: Target {
                account_id: Some(one.account_id.clone()),
                folder: Some(one.folder.clone()),
                id: Some(one.id),
                ids,
                message_id: one.message_id.clone(),
                subject: one.subject.clone(),
                from_email: one.from_email.clone(),
                outbox: false,
            },
        });
    }
    let title = if bulk {
        newsletters(letters.len())
    } else {
        new_messages(letters.len())
    };
    if let [account] = accounts.as_slice() {
        let senders = distinct(letters.iter().map(|l| l.from.as_str()).filter(|f| !f.is_empty()));
        let mut body = senders.iter().take(SENDERS).copied().collect::<Vec<_>>().join(", ");
        if senders.len() > SENDERS {
            let more = senders.len() - SENDERS;
            body = tr!("{body} and {more} more", "{body} и ещё {more}");
        }
        return Some(Shown {
            key: (*account).to_owned(),
            title,
            body: named(body, account),
            target: Target {
                account_id: Some((*account).to_owned()),
                folder: Some(first.folder.clone()),
                ids,
                ..Target::default()
            },
        });
    }
    let body = accounts
        .iter()
        .map(|a| {
            format!(
                "{} — {}",
                label(a),
                letters.iter().filter(|l| l.account_id == *a).count()
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    Some(Shown {
        key: ALL.to_owned(),
        title,
        body,
        target: Target {
            ids,
            ..Target::default()
        },
    })
}

/// A summary of one mailbox names this many senders.
const SENDERS: usize = 3;

/// Each value once, in the order they come.
fn distinct<'a>(values: impl Iterator<Item = &'a str>) -> Vec<&'a str> {
    let mut out: Vec<&str> = Vec::new();
    for v in values {
        if !out.contains(&v) {
            out.push(v);
        }
    }
    out
}

/// The Russian word for a count: one, a few, many.
fn ru_form<'a>(n: usize, one: &'a str, few: &'a str, many: &'a str) -> &'a str {
    match (n % 10, n % 100) {
        (1, r) if r != 11 => one,
        (2..=4, r) if !(12..=14).contains(&r) => few,
        _ => many,
    }
}

pub fn new_messages(n: usize) -> String {
    let ru = ru_form(n, "новое письмо", "новых письма", "новых писем");
    tr!("{n} new messages", "{n} {ru}")
}

fn newsletters(n: usize) -> String {
    let ru = ru_form(n, "рассылка", "рассылки", "рассылок");
    tr!("{n} newsletters", "{n} {ru}")
}

/// A new-mail notification on screen and the letters it tells about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Live {
    pub key: String,
    pub letters: Vec<Letter>,
}

/// How fresh letters join the notifications on screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merge {
    pub key: String,
    /// Fresh first, then the ones still on screen.
    pub letters: Vec<Letter>,
    /// The notification it replaces.
    pub replaces: Option<usize>,
    /// Notifications the summary takes over: they go.
    pub absorbs: Vec<usize>,
}

/// One mailbox's letters join its notification; letters of several mailboxes, or
/// anything while a summary of all is on screen, make that summary.
pub fn merge(live: &[Live], fresh: Vec<Letter>) -> Merge {
    let accounts = distinct(fresh.iter().map(|l| l.account_id.as_str()));
    let all = live.iter().position(|l| l.key == ALL);
    let (key, replaces, absorbs, old): (String, Option<usize>, Vec<usize>, Vec<&Letter>) =
        match (all, accounts.as_slice()) {
            (None, [account]) => {
                let own = live.iter().position(|l| l.key == *account);
                let old = own.map(|i| live[i].letters.iter().collect()).unwrap_or_default();
                ((*account).to_owned(), own, Vec::new(), old)
            }
            _ => {
                let replaces = all.or(if live.is_empty() { None } else { Some(0) });
                let absorbs = (0..live.len()).filter(|i| Some(*i) != replaces).collect();
                (
                    ALL.to_owned(),
                    replaces,
                    absorbs,
                    live.iter().flat_map(|l| &l.letters).collect(),
                )
            }
        };
    let mut letters: Vec<Letter> = Vec::new();
    for l in fresh.iter().chain(old) {
        if !letters.iter().any(|x| x.id == l.id) {
            letters.push(l.clone());
        }
    }
    Merge {
        key,
        letters,
        replaces,
        absorbs,
    }
}

/// New mail of all mailboxes arriving this close together is told once.
const BATCH: Duration = Duration::from_millis(1500);

/// A notification on screen: its id with the notification server, what it is about.
/// Kept on Linux only: elsewhere a notification is not replaced or closed by the app.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
struct Note {
    id: u32,
    /// For new mail: the mailbox or `*`, and its letters; none for other notifications.
    mail: Option<Live>,
    target: Option<Target>,
    #[cfg(target_os = "linux")]
    handle: Option<notify_rust::NotificationHandle>,
}

/// The notifications of the app: new mail waiting to be told, the ones on screen.
#[derive(Default)]
pub struct Notifier {
    pending: Mutex<Vec<Letter>>,
    batching: AtomicBool,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    notes: Mutex<Vec<Note>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Tests and e2e runs share the user's notification daemon: they keep quiet.
fn quiet(title: &str) -> bool {
    if std::env::var_os("DEPESHA_NO_NOTIFICATIONS").is_some() {
        tracing::debug!("notification suppressed: {title}");
        return true;
    }
    false
}

impl Notifier {
    /// New letters in an inbox: told together with what other mailboxes bring meanwhile.
    pub fn arrived(&self, app: &AppHandle, letters: Vec<Letter>) {
        if letters.is_empty() {
            return;
        }
        lock(&self.pending).extend(letters);
        if self.batching.swap(true, Ordering::AcqRel) {
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(BATCH).await;
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                state.notifier.batching.store(false, Ordering::Release);
                state.notifier.flush(&state);
            }
        });
    }

    fn flush(&self, state: &AppState) {
        let fresh = std::mem::take(&mut *lock(&self.pending));
        let (fresh, bulk) = worth(fresh);
        if fresh.is_empty() || !state.settings().may_notify(bulk) {
            return;
        }
        // The window in front shows the new mail itself.
        if crate::background::main_in_front(&state.app) || quiet("new mail") {
            return;
        }
        let accounts = state.accounts();
        let label = |id: &str| {
            accounts
                .iter()
                .find(|a| a.id == id)
                .map(|a| {
                    if a.label.trim().is_empty() {
                        a.email.clone()
                    } else {
                        a.label.trim().to_owned()
                    }
                })
                .unwrap_or_default()
        };
        let mut notes = lock(&self.notes);
        // Letters read meanwhile drop out of the notifications still on screen.
        let unread = |id: i64| state.store.get(id).ok().flatten().is_some_and(|r| !r.flags.seen);
        let live: Vec<(usize, Live)> = notes
            .iter()
            .enumerate()
            .filter_map(|(i, n)| {
                let mut l = n.mail.clone()?;
                l.letters.retain(|x| unread(x.id));
                Some((i, l))
            })
            .collect();
        let lives: Vec<Live> = live.iter().map(|(_, l)| l.clone()).collect();
        let m = merge(&lives, fresh);
        let bulk = m.letters.iter().all(|l| l.bulk);
        let Some(shown) = word(&m.letters, bulk, &label, accounts.len()) else {
            return;
        };
        let replaces = m.replaces.map(|i| live[i].0);
        let absorbs: Vec<usize> = m.absorbs.iter().map(|&i| live[i].0).collect();
        let mail = Live {
            key: m.key,
            letters: m.letters,
        };
        show(
            &state.app,
            &mut notes,
            &shown.title,
            &shown.body,
            Some(shown.target),
            Some(mail),
            replaces,
            &absorbs,
        );
    }

    /// Any other notification: a click shows the window, and opens `target` when there is one.
    pub fn notify(&self, app: &AppHandle, title: &str, body: &str, target: Option<Target>) {
        if crate::background::main_in_front(app) || quiet(title) {
            return;
        }
        let mut notes = lock(&self.notes);
        show(app, &mut notes, title, body, target, None, None, &[]);
    }

    /// The app quits: its notifications go with it, a click on them could do nothing.
    pub fn clear(&self, app: &AppHandle) {
        #[cfg(target_os = "linux")]
        for note in lock(&self.notes).drain(..) {
            if let Some(h) = note.handle {
                h.close();
            }
        }
        #[cfg(windows)]
        windows_toast::clear(app);
        let _ = app;
    }
}

/// A click on a notification: the window comes forward and turns to what it was about.
fn clicked(app: &AppHandle, target: Option<Target>) {
    crate::background::show_main(app);
    let (Some(target), Some(state)) = (target, app.try_state::<Arc<AppState>>()) else {
        return;
    };
    let store = &state.store;
    let open = resolve(
        &target,
        |id| store.get(id).ok().flatten().map(|r| r.folder),
        |account, mid| {
            let id = store.find_any_by_message_id(account, mid).ok().flatten()?;
            Some((id, store.get(id).ok().flatten()?.folder))
        },
    );
    state.emit_main("notification-open", serde_json::to_value(open).unwrap_or_default());
}

#[cfg(target_os = "linux")]
#[allow(clippy::too_many_arguments)]
fn show(
    app: &AppHandle,
    notes: &mut Vec<Note>,
    title: &str,
    body: &str,
    target: Option<Target>,
    mail: Option<Live>,
    replaces: Option<usize>,
    absorbs: &[usize],
) {
    let mut n = notify_rust::Notification::new();
    n.appname(pick("Depesha", "Депеша"))
        .summary(title)
        .body(body)
        .auto_icon()
        // The click on the notification itself; servers draw no button for `default`.
        .action("default", pick("Open", "Открыть"))
        .hint(notify_rust::Hint::DesktopEntry(app.package_info().name.clone()));
    let old = replaces.map(|i| notes[i].id);
    if let Some(id) = old {
        n.id(id);
    }
    let handle = match n.show() {
        Ok(h) => h,
        Err(e) => {
            tracing::debug!("notification failed: {e}");
            return;
        }
    };
    let id = handle.id();
    let note = Note {
        id,
        mail,
        target,
        handle: Some(handle),
    };
    // Replaced in place: the listener of that id hears the click on the new content.
    if old != Some(id) {
        let app = app.clone();
        std::thread::spawn(move || {
            let _ = notify_rust::handle_action(id, |response| {
                let Some(state) = app.try_state::<Arc<AppState>>() else {
                    return;
                };
                let note = {
                    let mut notes = lock(&state.notifier.notes);
                    notes.iter().position(|n| n.id == id).map(|i| notes.remove(i))
                };
                if let notify_rust::ActionResponse::Custom("default") = response {
                    clicked(&app, note.and_then(|n| n.target));
                }
            });
        });
    }
    match replaces {
        Some(i) => notes[i] = note,
        None => notes.push(note),
    }
    // Taken over by a summary: they go from the screen.
    let mut gone: Vec<usize> = absorbs.to_vec();
    gone.sort_unstable_by(|a, b| b.cmp(a));
    for i in gone {
        let note = notes.remove(i);
        if let Some(h) = note.handle {
            h.close();
        }
    }
}

#[cfg(windows)]
#[allow(clippy::too_many_arguments)]
fn show(
    app: &AppHandle,
    _notes: &mut Vec<Note>,
    title: &str,
    body: &str,
    target: Option<Target>,
    _mail: Option<Live>,
    _replaces: Option<usize>,
    _absorbs: &[usize],
) {
    windows_toast::show(app, title, body, target);
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn show(
    _app: &AppHandle,
    _notes: &mut Vec<Note>,
    title: &str,
    body: &str,
    _target: Option<Target>,
    _mail: Option<Live>,
    _replaces: Option<usize>,
    _absorbs: &[usize],
) {
    // macOS is not supported: a plain notification, without a click back.
    if let Err(e) = notify_rust::Notification::new().summary(title).body(body).show() {
        tracing::debug!("notification failed: {e}");
    }
}

#[cfg(windows)]
mod windows_toast {
    use super::{Target, clicked};
    use tauri::AppHandle;
    use tauri_winrt_notification::Toast;

    /// The AppUserModelID of the installed app is its identifier (the installer's shortcut
    /// carries it); a build run from `target/` has none, and borrows PowerShell's.
    fn app_id(app: &AppHandle) -> String {
        let dev = tauri::utils::platform::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|d| d.to_path_buf()))
            .is_some_and(|dir| dir.ends_with("target\\debug") || dir.ends_with("target\\release"));
        if dev {
            Toast::POWERSHELL_APP_ID.to_owned()
        } else {
            app.config().identifier.clone()
        }
    }

    pub fn show(app: &AppHandle, title: &str, body: &str, target: Option<Target>) {
        let mut lines = body.lines();
        let mut toast = Toast::new(&app_id(app))
            .title(title)
            .text1(lines.next().unwrap_or_default());
        if let Some(more) = lines.next() {
            toast = toast.text2(more);
        }
        let handle = app.clone();
        let shown = toast
            .on_activated(move |_| {
                clicked(&handle, target.clone());
                Ok(())
            })
            .show();
        if let Err(e) = shown {
            tracing::debug!("notification failed: {e}");
        }
    }

    /// Toasts left in the notification centre after the app quit would open nothing.
    pub fn clear(app: &AppHandle) {
        use windows::UI::Notifications::ToastNotificationManager;
        let id = windows::core::HSTRING::from(app_id(app));
        if let Err(e) = ToastNotificationManager::History().and_then(|h| h.ClearWithId(&id)) {
            tracing::debug!("notifications not cleared: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use depesha_core::lang::{self, Lang};

    fn letter(id: i64, account: &str, from: &str, subject: &str) -> Letter {
        Letter {
            id,
            account_id: account.into(),
            folder: "INBOX".into(),
            message_id: Some(format!("<{id}@example.com>")),
            from: from.into(),
            from_email: format!("{id}@example.com"),
            subject: subject.into(),
            bulk: false,
        }
    }

    fn label(id: &str) -> String {
        match id {
            "a" => "Работа".into(),
            "b" => "Личное".into(),
            other => other.into(),
        }
    }

    #[test]
    fn a_letter_is_its_sender_and_subject() {
        lang::pin(Lang::Ru);
        let one = [letter(7, "a", "Иван Петров", "Счёт за октябрь")];
        let shown = word(&one, false, &label, 1).unwrap();
        assert_eq!(shown.title, "Иван Петров");
        assert_eq!(shown.body, "Счёт за октябрь");
        assert_eq!(shown.key, "a");
        assert_eq!(
            shown.target,
            Target {
                account_id: Some("a".into()),
                folder: Some("INBOX".into()),
                id: Some(7),
                ids: vec![7],
                message_id: Some("<7@example.com>".into()),
                subject: "Счёт за октябрь".into(),
                from_email: "7@example.com".into(),
                outbox: false,
            }
        );
        // With more mailboxes the notification names its one; never the text of the letter.
        assert_eq!(word(&one, false, &label, 2).unwrap().body, "Счёт за октябрь\nРабота");
        let bare = [letter(8, "a", "Иван Петров", "")];
        assert_eq!(word(&bare, false, &label, 1).unwrap().body, "(без темы)");
    }

    #[test]
    fn letters_of_one_mailbox_are_their_senders() {
        lang::pin(Lang::Ru);
        let three = [
            letter(1, "a", "Иван Петров", "Счёт"),
            letter(2, "a", "Мария Соколова", "Re: Бюджет"),
            letter(3, "a", "Иван Петров", "Ещё счёт"),
            letter(4, "a", "Бухгалтерия", "Акт"),
        ];
        let shown = word(&three, false, &label, 2).unwrap();
        assert_eq!(shown.title, "4 новых письма");
        assert_eq!(shown.body, "Иван Петров, Мария Соколова, Бухгалтерия\nРабота");
        assert_eq!(shown.key, "a");
        assert_eq!(shown.target.account_id.as_deref(), Some("a"));
        assert_eq!(shown.target.folder.as_deref(), Some("INBOX"));
        assert_eq!(shown.target.id, None);
        assert_eq!(shown.target.ids, vec![1, 2, 3, 4]);

        let many: Vec<Letter> = (1..=5)
            .map(|i| letter(i, "a", &format!("Отправитель {i}"), "т"))
            .collect();
        let shown = word(&many, false, &label, 1).unwrap();
        assert_eq!(shown.title, "5 новых писем");
        assert_eq!(shown.body, "Отправитель 1, Отправитель 2, Отправитель 3 и ещё 2");
    }

    #[test]
    fn letters_of_several_mailboxes_are_one_summary_for_all() {
        lang::pin(Lang::Ru);
        let five = [
            letter(1, "a", "Иван", "1"),
            letter(2, "b", "Мария", "2"),
            letter(3, "a", "Пётр", "3"),
            letter(4, "a", "Олег", "4"),
            letter(5, "b", "Анна", "5"),
        ];
        let shown = word(&five, false, &label, 2).unwrap();
        assert_eq!(shown.title, "5 новых писем");
        assert_eq!(shown.body, "Работа — 3, Личное — 2");
        assert_eq!(shown.key, ALL);
        assert_eq!(shown.target.account_id, None);
        assert_eq!(shown.target.folder, None);
        assert_eq!(shown.target.id, None);
        assert_eq!(shown.target.ids, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn newsletters_are_counted_as_such_and_in_english_too() {
        lang::pin(Lang::Ru);
        let bulk: Vec<Letter> = (1..=2)
            .map(|i| Letter {
                bulk: true,
                ..letter(i, "a", "Рассылка", "н")
            })
            .collect();
        assert_eq!(word(&bulk, true, &label, 1).unwrap().title, "2 рассылки");
        lang::pin(Lang::En);
        let two = [letter(1, "a", "Ivan", "x"), letter(2, "a", "Maria", "y")];
        assert_eq!(word(&two, false, &label, 1).unwrap().title, "2 new messages");
        assert_eq!(
            word(&[letter(1, "a", "Ivan", "")], false, &label, 1).unwrap().body,
            "(no subject)"
        );
        assert!(word(&[], false, &label, 1).is_none());
    }

    #[test]
    fn people_first_newsletters_only_alone() {
        let news = Letter {
            bulk: true,
            ..letter(1, "a", "Рассылка", "н")
        };
        let person = letter(2, "a", "Иван", "п");
        assert_eq!(worth(vec![news.clone(), person.clone()]), (vec![person], false));
        assert_eq!(worth(vec![news.clone()]), (vec![news], true));
        assert_eq!(worth(vec![]), (vec![], false));
    }

    fn live(key: &str, ids: &[i64]) -> Live {
        Live {
            key: key.into(),
            letters: ids
                .iter()
                .map(|&i| letter(i, if key == ALL { "a" } else { key }, "x", "y"))
                .collect(),
        }
    }

    fn ids(m: &Merge) -> Vec<i64> {
        m.letters.iter().map(|l| l.id).collect()
    }

    #[test]
    fn a_mailbox_keeps_one_notification() {
        let m = merge(&[], vec![letter(1, "a", "x", "y")]);
        assert_eq!(
            (m.key.as_str(), m.replaces, m.absorbs.clone(), ids(&m)),
            ("a", None, vec![], vec![1])
        );
        // Still on screen: replaced by one about both letters, not joined by a second one.
        let m = merge(&[live("a", &[1])], vec![letter(2, "a", "x", "y")]);
        assert_eq!((m.key.as_str(), m.replaces, ids(&m)), ("a", Some(0), vec![2, 1]));
        // Another mailbox's letter has its own.
        let m = merge(&[live("a", &[1])], vec![letter(2, "b", "x", "y")]);
        assert_eq!(
            (m.key.as_str(), m.replaces, m.absorbs.clone(), ids(&m)),
            ("b", None, vec![], vec![2])
        );
        // The same letter twice is told once.
        let m = merge(&[live("a", &[1])], vec![letter(1, "a", "x", "y")]);
        assert_eq!(ids(&m), vec![1]);
    }

    #[test]
    fn several_mailboxes_make_one_summary_that_takes_the_rest_over() {
        let m = merge(
            &[live("a", &[1]), live("b", &[2])],
            vec![letter(3, "a", "x", "y"), letter(4, "c", "x", "y")],
        );
        assert_eq!(m.key, ALL);
        assert_eq!(m.replaces, Some(0));
        assert_eq!(m.absorbs, vec![1]);
        assert_eq!(ids(&m), vec![3, 4, 1, 2]);
        // While the summary is on screen, everything joins it.
        let m = merge(&[live(ALL, &[1, 2])], vec![letter(5, "b", "x", "y")]);
        assert_eq!((m.key.as_str(), m.replaces, ids(&m)), (ALL, Some(0), vec![5, 1, 2]));
    }

    fn target(id: Option<i64>) -> Target {
        Target {
            account_id: Some("a".into()),
            folder: Some("INBOX".into()),
            id,
            ids: id.into_iter().collect(),
            message_id: Some("<7@example.com>".into()),
            subject: "Счёт за октябрь".into(),
            from_email: "ivan.petrov@example.com".into(),
            outbox: false,
        }
    }

    #[test]
    fn a_click_finds_the_letter_where_it_is_now() {
        // In place, the Message-ID matching.
        let open = resolve(
            &target(Some(7)),
            |id| (id == 7).then(|| ("INBOX".into(), Some("<7@example.com>".into()))),
            |_, _| None,
            |_, _, _| None,
        );
        assert_eq!(
            (open.id, open.folder.as_deref(), open.gone.clone()),
            (Some(7), Some("INBOX"), None)
        );
        // Moved, and the cache knows where: opened there without a word.
        let open = resolve(
            &target(Some(7)),
            |_| None,
            |acc, mid| (acc == "a" && mid == "<7@example.com>").then(|| (42, "Archive".into())),
        );
        assert_eq!(
            (open.id, open.folder.as_deref(), open.gone.clone()),
            (Some(42), Some("Archive"), None)
        );
        assert_eq!(open.ids, vec![42]);
        // Gone: the inbox opens and says so.
        let open = resolve(&target(Some(7)), |_| None, |_, _| None);
        assert_eq!((open.id, open.folder.as_deref()), (None, Some("INBOX")));
        assert_eq!(
            open.gone,
            Some(Gone {
                subject: "Счёт за октябрь".into(),
                from: "ivan.petrov@example.com".into()
            })
        );
        assert!(open.ids.is_empty());
    }

    #[test]
    fn a_summary_opens_its_folder_as_is() {
        let summary = Target {
            ids: vec![1, 2, 3],
            ..target(None)
        };
        let open = resolve(
            &summary,
            |_| panic!("no letter to look up"),
            |_, _| panic!("no letter to look up"),
        );
        assert_eq!(
            open,
            Open {
                account_id: Some("a".into()),
                folder: Some("INBOX".into()),
                id: None,
                ids: vec![1, 2, 3],
                outbox: false,
                gone: None
            }
        );
    }

    #[test]
    fn an_outbox_notification_opens_the_outbox() {
        let t = Target {
            account_id: None,
            folder: None,
            id: None,
            message_id: None,
            outbox: true,
            ..Target::default()
        };
        let open = resolve(
            &t,
            |_| panic!("no letter to look up"),
            |_, _| panic!("no letter to look up"),
            |_, _, _| panic!("no letter to look up"),
        );
        assert!(open.outbox);
        assert_eq!(open.id, None);
    }

    #[test]
    fn markup_in_a_notification_is_neutralized() {
        // A subject carrying markup (a phishing link) goes out as text on a server that draws it.
        assert_eq!(
            entities("Счёт <a href=\"https://phish\">открыть</a> & <b>"),
            "Счёт &lt;a href=\"https://phish\"&gt;открыть&lt;/a&gt; &amp; &lt;b&gt;"
        );
        // A subject or a name with a line break cannot forge another line of the body.
        assert_eq!(plain("Счёт\nBcc: evil@x"), "Счёт Bcc: evil@x");
        assert_eq!(plain("Иван\r\nПётр\tконец"), "Иван  Пётр конец");
    }
}
