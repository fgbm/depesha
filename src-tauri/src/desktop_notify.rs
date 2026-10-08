//! Desktop notifications that open what they tell about (#63). tauri-plugin-notification
//! drops the handle on the desktop, so a click never came back; here it does: on Linux
//! over D-Bus (notify-rust), on Windows through the toast's own XML, whose `launch` is a
//! `depesha://` URL (`activationType="protocol"`). Windows opens that URL in a new
//! process: single-instance hands it to the running app (deep-link), and with Depesha
//! closed it starts it, so a toast left in the Notification Centre still works.
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
            from: plain(
                &from
                    .map(|a| {
                        a.name
                            .clone()
                            .filter(|n| !n.trim().is_empty())
                            .unwrap_or_else(|| a.email.clone())
                    })
                    .unwrap_or_default(),
            ),
            from_email: from.map(|a| a.email.clone()).unwrap_or_default(),
            subject: plain(&row.subject),
            bulk: row.bulk,
        }
    }
}

/// The text of a letter as a notification carries it: line breaks and other control
/// characters become spaces, so a subject or a sender's name cannot forge a second line
/// (the line breaks the body itself adds on purpose stay out of this).
fn plain(text: &str) -> String {
    text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
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

/// Whether two Message-IDs name the same letter; the cache may keep the angle brackets or
/// not. A Message-ID missing on either side is not a match: a letter that has none cannot be
/// told from another.
fn same_message(a: Option<&str>, b: Option<&str>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.trim_matches(['<', '>']) == b.trim_matches(['<', '>']),
        _ => false,
    }
}

/// The target as the cache has it now: the letter where it is, found again by its
/// Message-ID after a move, or gone. `in_place` answers a cached letter's mailbox, folder and
/// Message-ID; `find` a letter by account and Message-ID anywhere; `find_in` the copy in one
/// folder.
pub fn resolve(
    target: &Target,
    in_place: impl Fn(i64) -> Option<(String, String, Option<String>)>,
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
        // A summary: keep only letters of the mailbox the notification named (of any when it
        // named none). A number that is not there, or belongs to another mailbox, does not
        // tint a row.
        open.ids.retain(|&id| match (&target.account_id, in_place(id)) {
            (Some(account), Some((row_account, _, _))) => row_account == *account,
            (None, Some(_)) => true,
            _ => false,
        });
        return open;
    };
    // The id is the letter the notification was about only when it is still in the same
    // mailbox and the Message-ID matches: an id freed by a deletion and taken by a new
    // letter must not open that letter.
    if let Some((account, folder, message_id)) = in_place(id)
        && target.account_id.as_deref() == Some(account.as_str())
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
    let open = resolve_target(&state, &target);
    state.emit_main("notification-open", serde_json::to_value(open).unwrap_or_default());
}

/// The target as the cache has it now (see [`resolve`]).
fn resolve_target(state: &AppState, target: &Target) -> Open {
    let store = &state.store;
    resolve(
        target,
        |id| store.get(id).ok().flatten().map(|r| (r.account_id, r.folder, r.message_id)),
        |account, mid| {
            let id = store.find_any_by_message_id(account, mid).ok().flatten()?;
            Some((id, store.get(id).ok().flatten()?.folder))
        },
        |account, folder, mid| store.find_by_message_id_any(account, mid, Some(folder)).ok().flatten(),
    )
}

/// A `depesha://` URL at runtime (a toast click from a second process): the window comes
/// forward and the main window turns to what the URL names. Only a link the app itself
/// signed does that: this is an entry from outside, anyone can open a `depesha://` link, and
/// any other one only brings the window forward.
pub fn open_url(app: &AppHandle, url: &str) {
    match parse_signed_url(url) {
        None => {}
        Some(Route::Window) => crate::background::show_main(app),
        Some(Route::Target(target)) => clicked(app, Some(target)),
    }
}

/// A `depesha://` URL the app was started with (a toast click while it was closed),
/// resolved against the cache; `None` when it only brings the window or is unknown. The
/// main window asks for it once it listens, so the event is not lost to the page loading.
pub fn open_from_url(state: &AppState, url: &str) -> Option<Open> {
    match parse_signed_url(url)? {
        Route::Window => None,
        Route::Target(target) => Some(resolve_target(state, &target)),
    }
}

/// The route a `depesha://` URL asks for once its signature is checked. An unknown URL is
/// `None`; a known one without a signature of the app, or with a bad one, reads as
/// [`Route::Window`]: it only brings the window forward, never names mail.
fn parse_signed_url(url: &str) -> Option<Route> {
    let route = parse_url(url)?;
    let signed = url::Url::parse(url)
        .ok()
        .and_then(|u| query(&u, "sig"))
        .is_some_and(|sig| crate::install_secret::verify(signed_text(&route).as_bytes(), &sig));
    Some(if signed { route } else { Route::Window })
}

/// The bytes a link's signature covers: the path and parameters of its route in a canonical
/// form, computed the same way by the link the app makes and by the check of one that
/// arrives, so the two cannot drift over an encoding. The mailbox is the decoded one and the
/// letters are their numbers.
fn signed_text(route: &Route) -> String {
    match route {
        Route::Window => "open".to_owned(),
        Route::Target(t) if t.outbox => "outbox".to_owned(),
        Route::Target(t) => match (&t.account_id, t.id) {
            (Some(account), Some(id)) => {
                let mut text = format!("message\n{account}\n{id}");
                if let Some(mid) = &t.message_id {
                    text.push('\n');
                    text.push_str(mid);
                }
                text
            }
            _ => {
                let mut text = match &t.account_id {
                    Some(account) => format!("inbox\n{account}"),
                    None => "inbox".to_owned(),
                };
                if !t.ids.is_empty() {
                    let ids: Vec<String> = t.ids.iter().map(|id| id.to_string()).collect();
                    text.push('\n');
                    text.push_str(&ids.join(","));
                }
                text
            }
        },
    }
}

/// The `depesha://` URL of a link body, with the signature of its route. Without a secret the
/// signature is empty and the URL goes out unsigned (it will only bring the window forward).
#[cfg_attr(not(windows), allow(dead_code))]
fn signed_url(core: &str, route: &Route) -> String {
    let sig = crate::install_secret::sign(signed_text(route).as_bytes());
    if sig.is_empty() {
        return format!("depesha://{core}");
    }
    let sep = if core.contains('?') { '&' } else { '?' };
    format!("depesha://{core}{sep}sig={sig}")
}

/// How long a `depesha://` URL may be. Windows caps a toast's `launch` at 512, but a link
/// opened by hand can be anything, so there is a limit of our own.
const URL_MAX: usize = 2048;
/// The longest mailbox id a URL may carry (an address plus a timestamp, well under this).
const ACCOUNT_MAX: usize = 320;
/// The longest Message-ID a URL may carry (RFC 5322 puts a line at 998).
const MESSAGE_ID_MAX: usize = 998;
/// The most new letters a summary URL names.
const IDS_MAX: usize = 50;

/// What a `depesha://` URL asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Just bring the main window forward (a notification without a letter of its own).
    Window,
    /// Turn the main window to this.
    Target(Target),
}

/// Reads a `depesha://` URL. Strict on purpose: this is an entry from outside, so only the
/// known paths are read, an id must be a positive number, and a Message-ID comes from its
/// own parameter with a length limit. Anything else — a foreign scheme, an unknown path, a
/// malformed value, too long a URL — is `None`.
///
/// * `depesha://message/<account>/<id>?mid=<message-id>` — one letter; the `mid` is required,
///   and one that does not decode refuses the URL (the id alone names a reused row);
/// * `depesha://inbox/<account>?ids=<id,id,…>` — one mailbox's summary;
/// * `depesha://inbox?ids=<id,id,…>` — all inboxes;
/// * `depesha://outbox` — the Outbox;
/// * `depesha://open` — the window, nothing else.
pub fn parse_url(url: &str) -> Option<Route> {
    if url.len() > URL_MAX {
        return None;
    }
    let u = url::Url::parse(url).ok()?;
    if u.scheme() != "depesha" {
        return None;
    }
    let path = u.path().trim_start_matches('/');
    let mut parts = path.split('/').filter(|p| !p.is_empty());
    match u.host_str()? {
        "open" => parts.next().is_none().then_some(Route::Window),
        "outbox" => parts.next().is_none().then_some(Route::Target(Target {
            outbox: true,
            ..Target::default()
        })),
        "message" => {
            let account_id = account(parts.next()?)?;
            let id: i64 = parts.next()?.parse().ok()?;
            if id <= 0 || parts.next().is_some() {
                return None;
            }
            // The Message-ID tells the letter apart from a row that took its id since; it is
            // not optional, and one that does not decode refuses the whole URL.
            let message_id = query(&u, "mid")?;
            if message_id.is_empty() || message_id.len() > MESSAGE_ID_MAX {
                return None;
            }
            Some(Route::Target(Target {
                account_id: Some(account_id),
                folder: Some("INBOX".into()),
                id: Some(id),
                ids: vec![id],
                message_id: Some(message_id),
                subject: String::new(),
                from_email: String::new(),
                outbox: false,
            }))
        }
        "inbox" => {
            let account_id = match parts.next() {
                Some(part) => Some(account(part)?),
                None => None,
            };
            if parts.next().is_some() {
                return None;
            }
            Some(Route::Target(Target {
                account_id: account_id.clone(),
                folder: account_id.map(|_| "INBOX".to_owned()),
                id: None,
                ids: ids(&u)?,
                message_id: None,
                subject: String::new(),
                from_email: String::new(),
                outbox: false,
            }))
        }
        _ => None,
    }
}

/// A mailbox id from a URL path segment, percent-decoded, non-empty and within its limit.
fn account(part: &str) -> Option<String> {
    let account = dec(part)?;
    (!account.is_empty() && account.len() <= ACCOUNT_MAX).then_some(account)
}

/// The `ids` parameter of a summary URL: comma-separated letter numbers, at most
/// [`IDS_MAX`]. Absent reads as none; a non-number refuses the whole URL.
fn ids(u: &url::Url) -> Option<Vec<i64>> {
    let Some(raw) = query(u, "ids") else {
        return Some(Vec::new());
    };
    let mut found = Vec::new();
    for part in raw.split(',').filter(|p| !p.is_empty()) {
        if found.len() >= IDS_MAX {
            break;
        }
        let id: i64 = part.parse().ok()?;
        if id > 0 {
            found.push(id);
        }
    }
    Some(found)
}

/// The first value of a query parameter, percent-decoded.
fn query(u: &url::Url, key: &str) -> Option<String> {
    for pair in u.query()?.split('&') {
        if let Some((k, v)) = pair.split_once('=')
            && k == key
        {
            return dec(v);
        }
    }
    None
}

/// Percent-encodes a value for a `depesha://` URL (everything outside the unreserved set).
#[cfg_attr(not(windows), allow(dead_code))]
fn enc(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0xf) as usize] as char);
        }
    }
    out
}

/// Percent-decodes a URL component (`+` stays `+`: this is not a form). `None` on a broken
/// escape or invalid UTF-8.
fn dec(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hi = hex(*bytes.get(i + 1)?)?;
            let lo = hex(*bytes.get(i + 2)?)?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `&`, `<`, `>` as entities: what a server drawing markup reads as text, not as tags.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

/// The text as the notification server reads it: escaped only where it draws markup,
/// so a server that shows the body as plain text keeps the characters as written.
#[cfg(target_os = "linux")]
fn escaped(text: &str) -> String {
    if marks_up() { entities(text) } else { text.to_owned() }
}

/// Whether the notification server draws markup in the body (checked once).
#[cfg(target_os = "linux")]
fn marks_up() -> bool {
    use std::sync::OnceLock;
    static CAPS: OnceLock<bool> = OnceLock::new();
    *CAPS.get_or_init(|| {
        notify_rust::get_capabilities()
            .map(|caps| caps.iter().any(|c| c == "body-markup" || c == "body-hyperlinks"))
            .unwrap_or(false)
    })
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
    // A server that draws markup (body-markup, body-hyperlinks) would turn `<a href>` in a
    // subject into a link, or a `<img>` into a picture, inside Depesha's own notification:
    // there the text goes out with its `&`, `<`, `>` as entities.
    let (title, body) = (escaped(title), escaped(body));
    let mut n = notify_rust::Notification::new();
    n.appname(pick("Depesha", "Депеша"))
        .summary(&title)
        .body(&body)
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
    use super::{IDS_MAX, Target, enc};
    use tauri::AppHandle;
    use tauri_winrt_notification::Toast;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
    use windows::core::HSTRING;

    /// Windows refuses a toast whose `launch` is over 512 characters, so a summary's
    /// letters go in only while they fit.
    const LAUNCH_MAX: usize = 500;
    /// What a signed URL adds around its body: `depesha://`, `&sig=`, and the 43 characters
    /// of the URL-safe base64 of a 32-byte HMAC tag (reserved so the id list cannot push the
    /// signature over the limit).
    const SIGNED_OVERHEAD: usize = "depesha://".len() + "&sig=".len() + 43;

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

    /// The `depesha://` URL a click opens: a letter by its id and Message-ID, a summary by
    /// its mailbox (or all inboxes) and the new letters, the Outbox by name, anything else
    /// just brings the window. The URL carries the signature of the route, so only a link the
    /// app made opens mail. Windows opens it as a new process; single-instance hands it to the
    /// running app, and with the app closed it starts Depesha.
    pub(super) fn launch_url(target: Option<&Target>) -> String {
        let Some(t) = target else {
            return super::signed_url("open", &super::Route::Window);
        };
        if t.outbox {
            return super::signed_url("outbox", &super::Route::Target(t.clone()));
        }
        if let (Some(account), Some(id)) = (&t.account_id, t.id) {
            let mut body = format!("message/{}/{}", enc(account), id);
            if let Some(mid) = t.message_id.as_deref() {
                body.push_str("?mid=");
                body.push_str(&enc(mid));
            }
            return super::signed_url(&body, &super::Route::Target(t.clone()));
        }
        let mut body = match &t.account_id {
            Some(account) => format!("inbox/{}", enc(account)),
            None => "inbox".to_owned(),
        };
        let mut listed = String::new();
        for id in t.ids.iter().take(IDS_MAX) {
            let next = if listed.is_empty() {
                id.to_string()
            } else {
                format!("{listed},{id}")
            };
            if SIGNED_OVERHEAD + body.len() + "?ids=".len() + next.len() > LAUNCH_MAX {
                break;
            }
            listed = next;
        }
        if !listed.is_empty() {
            body.push_str("?ids=");
            body.push_str(&listed);
        }
        super::signed_url(&body, &super::Route::Target(t.clone()))
    }

    /// The toast XML, built through the DOM so the sender and the subject go in as text
    /// (`SetInnerText`) and never as markup: a subject cannot forge a tag or an attribute.
    pub(super) fn xml(title: &str, body: &str, launch: &str) -> windows::core::Result<XmlDocument> {
        let doc = XmlDocument::new()?;
        let toast = doc.CreateElement(&HSTRING::from("toast"))?;
        toast.SetAttribute(&HSTRING::from("launch"), &HSTRING::from(launch))?;
        toast.SetAttribute(&HSTRING::from("activationType"), &HSTRING::from("protocol"))?;
        doc.AppendChild(&toast)?;
        let visual = doc.CreateElement(&HSTRING::from("visual"))?;
        toast.AppendChild(&visual)?;
        let binding = doc.CreateElement(&HSTRING::from("binding"))?;
        binding.SetAttribute(&HSTRING::from("template"), &HSTRING::from("ToastGeneric"))?;
        visual.AppendChild(&binding)?;
        let mut lines = body.lines();
        let mut texts = vec![title, lines.next().unwrap_or_default()];
        if let Some(more) = lines.next() {
            texts.push(more);
        }
        for text in texts {
            let element = doc.CreateElement(&HSTRING::from("text"))?;
            element.SetInnerText(&HSTRING::from(text))?;
            binding.AppendChild(&element)?;
        }
        Ok(doc)
    }

    pub fn show(app: &AppHandle, title: &str, body: &str, target: Option<Target>) {
        let launch = launch_url(target.as_ref());
        let doc = match xml(title, body, &launch) {
            Ok(doc) => doc,
            Err(e) => {
                tracing::debug!("notification failed: {e}");
                return;
            }
        };
        let shown = ToastNotification::CreateToastNotification(&doc).and_then(|toast| {
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id(app)))?.Show(&toast)
        });
        if let Err(e) = shown {
            tracing::debug!("notification failed: {e}");
        }
    }

    /// Toasts left in the notification centre after the app quit would open nothing.
    pub fn clear(app: &AppHandle) {
        let id = HSTRING::from(app_id(app));
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
            |id| (id == 7).then(|| ("a".into(), "INBOX".into(), Some("<7@example.com>".into()))),
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
            |_, _, _| None,
        );
        assert_eq!(
            (open.id, open.folder.as_deref(), open.gone.clone()),
            (Some(42), Some("Archive"), None)
        );
        assert_eq!(open.ids, vec![42]);
        // Gone: the inbox opens and says so.
        let open = resolve(&target(Some(7)), |_| None, |_, _| None, |_, _, _| None);
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
    fn a_reused_id_does_not_open_another_letter() {
        // The id now belongs to a different letter (the old one was deleted, its rowid
        // taken): the Message-ID says so, and the letter is found by it instead.
        let open = resolve(
            &target(Some(7)),
            |_| Some(("a".into(), "INBOX".into(), Some("<other@example.com>".into()))),
            |acc, mid| (acc == "a" && mid == "<7@example.com>").then(|| (99, "Archive".into())),
            |_, _, _| None,
        );
        assert_eq!((open.id, open.folder.as_deref()), (Some(99), Some("Archive")));
        // Found nowhere: the letter is told as gone, not opened as the id's new owner.
        let open = resolve(
            &target(Some(7)),
            |_| Some(("a".into(), "INBOX".into(), Some("<other@example.com>".into()))),
            |_, _| None,
            |_, _, _| None,
        );
        assert_eq!(open.id, None);
        assert!(open.gone.is_some());
    }

    #[test]
    fn an_id_in_another_mailbox_does_not_open_a_letter() {
        // The row with this id now belongs to another mailbox (the rowids are per cache, not
        // per mailbox): the mailbox says it is not the letter the notification was about.
        let open = resolve(
            &target(Some(7)),
            |_| Some(("b".into(), "INBOX".into(), Some("<7@example.com>".into()))),
            |_, _| None,
            |_, _, _| None,
        );
        assert_eq!(open.id, None);
        assert!(open.gone.is_some());
    }

    #[test]
    fn a_click_prefers_the_copy_in_the_named_folder() {
        // The letter was in Sent when the notification was made; a copy sits in Inbox too.
        let mut t = target(Some(7));
        t.folder = Some("Sent".into());
        let open = resolve(
            &t,
            |_| None,
            |_, _| Some((1, "INBOX".into())),
            |_, folder, _| (folder == "Sent").then(|| (2, "Sent".into())),
        );
        assert_eq!((open.id, open.folder.as_deref()), (Some(2), Some("Sent")));
        // The named folder has no copy: any one will do.
        let open = resolve(&t, |_| None, |_, _| Some((1, "INBOX".into())), |_, _, _| None);
        assert_eq!((open.id, open.folder.as_deref()), (Some(1), Some("INBOX")));
    }

    #[test]
    fn a_summary_opens_its_folder_as_is() {
        let summary = Target {
            ids: vec![1, 2, 3],
            ..target(None)
        };
        let open = resolve(
            &summary,
            |id| (1..=3).contains(&id).then(|| ("a".into(), "INBOX".into(), None)),
            |_, _| panic!("no letter to look up"),
            |_, _, _| panic!("no letter to look up"),
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
    fn a_summary_tints_only_letters_of_its_mailbox() {
        // A number that is gone, or belongs to another mailbox, is dropped: the list tints
        // only the letters the summary was really about.
        let summary = Target {
            ids: vec![1, 2, 3],
            ..target(None)
        };
        let open = resolve(
            &summary,
            |id| match id {
                1 => Some(("a".into(), "INBOX".into(), None)),
                2 => Some(("b".into(), "INBOX".into(), None)),
                _ => None,
            },
            |_, _| panic!("no letter to look up"),
            |_, _, _| panic!("no letter to look up"),
        );
        assert_eq!(open.ids, vec![1]);
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

    #[test]
    fn a_depesha_url_names_what_to_open() {
        assert_eq!(parse_url("depesha://open"), Some(Route::Window));
        assert_eq!(
            parse_url("depesha://outbox"),
            Some(Route::Target(Target {
                outbox: true,
                ..Target::default()
            }))
        );
        // A letter: its mailbox, its id and its Message-ID (percent-encoded in the URL).
        assert_eq!(
            parse_url("depesha://message/a/7?mid=%3C7%40x%3E"),
            Some(Route::Target(Target {
                account_id: Some("a".into()),
                folder: Some("INBOX".into()),
                id: Some(7),
                ids: vec![7],
                message_id: Some("<7@x>".into()),
                ..Target::default()
            }))
        );
        // Nothing selected: the folder opens with the new letters named.
        assert_eq!(
            parse_url("depesha://inbox?ids=1,2,3"),
            Some(Route::Target(Target {
                ids: vec![1, 2, 3],
                ..Target::default()
            }))
        );
        // One mailbox, its id read back with `@` and `-` intact.
        assert_eq!(
            parse_url("depesha://inbox/a%40x-1"),
            Some(Route::Target(Target {
                account_id: Some("a@x-1".into()),
                folder: Some("INBOX".into()),
                ..Target::default()
            }))
        );
        // No `ids` reads as none, not as an error.
        assert_eq!(
            parse_url("depesha://inbox/a"),
            Some(Route::Target(Target {
                account_id: Some("a".into()),
                folder: Some("INBOX".into()),
                ..Target::default()
            }))
        );
        // A letter without a Message-ID is refused: the id alone names a row that a new
        // letter may have taken since.
        assert_eq!(parse_url("depesha://message/a/7"), None);
    }

    #[test]
    fn garbage_urls_are_refused() {
        for url in [
            "",
            "depesha://",
            "depesha://:",
            "https://message/a/7",
            "depesha://other",
            "depesha://message",
            "depesha://message/a",
            "depesha://message//7",
            "depesha://message/a/seven",
            "depesha://message/a/0",
            "depesha://message/a/-1",
            "depesha://message/a/7/extra",
            "depesha://message/a/7",
            "depesha://message/a/7?mid=",
            "depesha://message/a/7?mid=%zz",
            "depesha://inbox/a/extra",
            "depesha://inbox?ids=1,x",
            "depesha://open/extra",
            "depesha://outbox/extra",
            "not a url",
        ] {
            assert_eq!(parse_url(url), None, "{url}");
        }
    }

    #[test]
    fn an_outside_url_cannot_walk_the_cache() {
        // A traversal stays data: the mailbox is only ever looked up by its exact value.
        assert_eq!(
            parse_url("depesha://message/..%2F..%2Fetc/7?mid=%3C7%40x%3E"),
            Some(Route::Target(Target {
                account_id: Some("../../etc".into()),
                folder: Some("INBOX".into()),
                id: Some(7),
                ids: vec![7],
                message_id: Some("<7@x>".into()),
                ..Target::default()
            }))
        );
        // A markup payload in the Message-ID is a value, not a tag.
        assert_eq!(
            parse_url("depesha://message/a/7?mid=%3Cscript%3E%22"),
            Some(Route::Target(Target {
                account_id: Some("a".into()),
                folder: Some("INBOX".into()),
                id: Some(7),
                ids: vec![7],
                message_id: Some("<script>\"".into()),
                ..Target::default()
            }))
        );
        // A broken escape in the Message-ID refuses the whole URL, not reads as none.
        assert_eq!(parse_url("depesha://message/a/7?mid=%zz"), None);
        assert_eq!(parse_url("depesha://inbox/a%zz"), None);
    }

    #[test]
    fn an_overlong_url_is_refused() {
        assert_eq!(
            parse_url(&format!("depesha://inbox/{}", "a".repeat(ACCOUNT_MAX + 1))),
            None
        );
        assert_eq!(
            parse_url(&format!("depesha://message/a/7?mid={}", "a".repeat(MESSAGE_ID_MAX + 1))),
            None
        );
        assert_eq!(parse_url(&format!("depesha://inbox/{}", "a".repeat(URL_MAX))), None);
        // Just within the limits is fine, and a summary keeps at most IDS_MAX letters.
        assert!(parse_url(&format!("depesha://inbox/{}", "a".repeat(ACCOUNT_MAX))).is_some());
        let many: Vec<String> = (1..=(IDS_MAX as i64 + 10)).map(|id| id.to_string()).collect();
        let route = parse_url(&format!("depesha://inbox?ids={}", many.join(","))).unwrap();
        assert_eq!(
            route,
            Route::Target(Target {
                ids: (1..=IDS_MAX as i64).collect(),
                ..Target::default()
            })
        );
    }

    /// Only a link the app itself signed names mail: a `depesha://` link from anywhere else
    /// — no signature, a forged one — only brings the window forward.
    #[test]
    fn only_a_link_the_app_signed_names_mail() {
        crate::install_secret::init_with([9u8; 32]);
        let one = Target {
            account_id: Some("a".into()),
            folder: Some("INBOX".into()),
            id: Some(7),
            ids: vec![7],
            message_id: Some("<7@x>".into()),
            ..Target::default()
        };
        let url = signed_url("message/a/7?mid=%3C7%40x%3E", &Route::Target(one.clone()));
        assert!(url.contains("sig="), "{url}");
        assert_eq!(parse_signed_url(&url), Some(Route::Target(one.clone())));
        // Without a signature, and with a wrong one, only the window comes forward.
        assert_eq!(
            parse_signed_url("depesha://message/a/7?mid=%3C7%40x%3E"),
            Some(Route::Window)
        );
        assert_eq!(
            parse_signed_url("depesha://message/a/7?mid=%3C7%40x%3E&sig=AAAA"),
            Some(Route::Window)
        );
        // The signature covers the route: another id does not pass under it.
        assert_eq!(
            parse_signed_url(&url.replace("a/7", "a/8")),
            Some(Route::Window)
        );
        assert_eq!(
            parse_signed_url("depesha://message/a/8?mid=%3C7%40x%3E&sig=AAAA"),
            Some(Route::Window)
        );
        // An unknown URL is not even a window.
        assert_eq!(parse_signed_url("depesha://other"), None);
    }

    /// The `depesha://` URLs a toast opens; only Windows shows the toasts, so the test is
    /// there too. Every URL carries the signature of its route, and reads back to it.
    #[cfg(windows)]
    #[test]
    fn a_toast_opens_its_letter_or_its_summary() {
        crate::install_secret::init_with([1u8; 32]);
        let url = super::windows_toast::launch_url(None);
        assert!(url.starts_with("depesha://open"), "{url}");
        assert_eq!(parse_signed_url(&url), Some(Route::Window));
        let outbox = Target {
            outbox: true,
            ..Target::default()
        };
        let url = super::windows_toast::launch_url(Some(&outbox));
        assert!(url.starts_with("depesha://outbox"), "{url}");
        assert_eq!(parse_signed_url(&url), Some(Route::Target(outbox.clone())));
        let one = Target {
            account_id: Some("a@x-1".into()),
            folder: Some("INBOX".into()),
            id: Some(7),
            ids: vec![7],
            message_id: Some("<7@x>".into()),
            ..Target::default()
        };
        let url = super::windows_toast::launch_url(Some(&one));
        assert!(url.starts_with("depesha://message/a%40x-1/7?mid=%3C7%40x%3E"), "{url}");
        assert_eq!(parse_signed_url(&url), Some(Route::Target(one.clone())));
        let summary = Target {
            account_id: Some("a".into()),
            folder: Some("INBOX".into()),
            ids: vec![3, 5],
            ..Target::default()
        };
        let url = super::windows_toast::launch_url(Some(&summary));
        assert!(url.starts_with("depesha://inbox/a?ids=3,5"), "{url}");
        assert_eq!(parse_signed_url(&url), Some(Route::Target(summary.clone())));
        let all = Target {
            ids: vec![3, 5],
            ..Target::default()
        };
        let url = super::windows_toast::launch_url(Some(&all));
        assert!(url.starts_with("depesha://inbox?ids=3,5"), "{url}");
        assert_eq!(parse_signed_url(&url), Some(Route::Target(all.clone())));
    }

    /// The toast XML carries the launch and holds a subject as text, never as markup.
    #[cfg(windows)]
    #[test]
    fn the_toast_xml_escapes_the_text() {
        let doc = super::windows_toast::xml("Иван <b>", "Счёт & <a href=\"x\">", "depesha://message/a/7").unwrap();
        let xml = doc.GetXml().unwrap().to_string();
        assert!(xml.contains("activationType=\"protocol\""), "{xml}");
        assert!(xml.contains("launch=\"depesha://message/a/7\""), "{xml}");
        assert!(xml.contains("Иван &lt;b&gt;"), "{xml}");
        assert!(xml.contains("Счёт &amp; &lt;a href=\"x\"&gt;"), "{xml}");
        assert!(!xml.contains("<b>"), "{xml}");
    }
}
