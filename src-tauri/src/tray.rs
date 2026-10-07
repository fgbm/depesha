//! The tray icon (#4): the number of unread letters drawn on it, a short menu, and a
//! click that brings the window or hides it. On Linux the icon goes through
//! StatusNotifierItem (ksni): a left click arrives as activation, the menu is on the right.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use depesha_core::imap::FolderRole;
use depesha_core::lang::pick;
use depesha_core::store::FolderInfo;
use depesha_core::tr;
use tauri::image::Image;
use tauri::menu::{IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::background::{self, Tray, TrayProbe};
use crate::state::AppState;
use crate::worker::Work;

/// Unread letters in the inboxes of every mailbox, newsletters included (#4, frame 6A).
pub fn inbox_unread(folders: &[FolderInfo]) -> u32 {
    folders
        .iter()
        .filter(|f| f.folder.role == Some(FolderRole::Inbox))
        .map(|f| f.unread)
        .sum()
}

/// What the icon shows: nothing, a digit, or `9+`.
pub fn badge_text(unread: u32) -> Option<String> {
    match unread {
        0 => None,
        1..=9 => Some(unread.to_string()),
        _ => Some("9+".into()),
    }
}

/// The icon with the number in a white circle at its lower right corner. `rgba` is a
/// square `size`×`size` picture; with nothing to count it comes back as it is.
pub fn badge_icon(rgba: &[u8], size: u32, unread: u32) -> Vec<u8> {
    let mut out = rgba.to_vec();
    let Some(text) = badge_text(unread) else {
        return out;
    };
    let glyphs: Vec<&[u8; 7]> = text.chars().filter_map(glyph).collect();
    let s = size as f32;
    // The circle: its centre at the lower right, a third of the icon across.
    let (cx, cy, r) = (s * 0.69, s * 0.69, s * 0.31);
    let ring = (s * 0.045).max(1.0);
    // The figure fits inside the circle: 7 rows high, 5 columns a glyph, 1 between.
    let cols = (glyphs.len() * 6 - 1) as f32;
    let cell = (r * 1.05 / 7.0).min(r * 1.45 / cols);
    let (tx, ty) = (cx - cols * cell / 2.0, cy - 3.5 * cell);
    let ink = |x: f32, y: f32| -> bool {
        let (gx, gy) = (((x - tx) / cell).floor(), ((y - ty) / cell).floor());
        if !(0.0..cols).contains(&gx) || !(0.0..7.0).contains(&gy) {
            return false;
        }
        let (gx, gy) = (gx as usize, gy as usize);
        gx % 6 < 5 && glyphs[gx / 6][gy] & (0b10000 >> (gx % 6)) != 0
    };
    const N: usize = 4;
    for py in 0..size {
        for px in 0..size {
            // Four by four samples a pixel: smooth edges for the circle and the figure.
            let (mut disc, mut white) = (0u32, 0u32);
            for sy in 0..N {
                for sx in 0..N {
                    let x = px as f32 + (sx as f32 + 0.5) / N as f32;
                    let y = py as f32 + (sy as f32 + 0.5) / N as f32;
                    let d = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
                    if d <= r {
                        disc += 1;
                        // The ring and the figure are dark, the rest of the disc white.
                        if d <= r - ring && !ink(x, y) {
                            white += 1;
                        }
                    }
                }
            }
            if disc == 0 {
                continue;
            }
            let total = (N * N) as f32;
            let cover = disc as f32 / total;
            let light = white as f32 / disc as f32;
            let i = ((py * size + px) * 4) as usize;
            // The badge over the icon: «over» compositing of a partly covering disc.
            let under_a = out[i + 3] as f32 / 255.0;
            let a = cover + under_a * (1.0 - cover);
            for c in 0..3 {
                let badge = light * 255.0 + (1.0 - light) * DARK[c];
                let v = (badge * cover + out[i + c] as f32 * under_a * (1.0 - cover)) / a;
                out[i + c] = v.round().clamp(0.0, 255.0) as u8;
            }
            out[i + 3] = (a * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
    out
}

/// The figure and the ring of the badge: near black, as the text of the light theme.
const DARK: [f32; 3] = [28.0, 28.0, 30.0];

/// Digits and the plus, 5×7, a row a byte, the leftmost column the highest bit.
fn glyph(c: char) -> Option<&'static [u8; 7]> {
    const DIGITS: [[u8; 7]; 10] = [
        [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
        [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
        [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
        [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
        [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
        [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
        [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
        [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
        [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
        [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
    ];
    const PLUS: [u8; 7] = [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000];
    match c {
        '+' => Some(&PLUS),
        d => d.to_digit(10).map(|d| &DIGITS[d as usize]),
    }
}

/// A mailbox that needs the user (a password refused, a certificate): the menu starts with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub account_id: String,
    pub label: String,
    /// The server refused the sign-in; otherwise it refused something else.
    pub auth: bool,
}

/// What the menu says.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MenuState {
    pub unread: u32,
    /// When mail was last checked, as the clock shows it.
    pub checked: Option<String>,
    pub problems: Vec<Problem>,
    /// Notifications are off until this time, as the clock shows it.
    pub dnd_until: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    Item { id: String, label: String, enabled: bool },
    Separator,
    Submenu { label: String, items: Vec<Entry> },
}

/// The short menu (frame 7A): open, the unread ones or the state, write, check, do not
/// disturb, quit; mailboxes that need the user come first (frame 8).
pub fn menu(s: &MenuState) -> Vec<Entry> {
    let item = |id: &str, label: String| Entry::Item {
        id: id.to_owned(),
        label,
        enabled: true,
    };
    let note = |label: String| Entry::Item {
        id: String::new(),
        label,
        enabled: false,
    };
    let trouble = |p: &Problem| {
        let what = if p.auth {
            pick("could not sign in", "не удалось войти")
        } else {
            pick("the server refused", "сервер отказал")
        };
        format!("{}: {what}", p.label)
    };
    let mut out = Vec::new();
    match s.problems.as_slice() {
        [] => {}
        [one] => {
            out.push(note(trouble(one)));
            out.push(item(
                &format!("account:{}", one.account_id),
                pick("Open the mailbox settings…", "Открыть настройки ящика…").to_owned(),
            ));
            out.push(Entry::Separator);
        }
        many => {
            for p in many.iter().take(PROBLEMS) {
                out.push(item(&format!("account:{}", p.account_id), trouble(p)));
            }
            if many.len() > PROBLEMS {
                let n = many.len() - PROBLEMS;
                let ru = ru_form(n as u32, "ящик с ошибкой", "ящика с ошибками", "ящиков с ошибками");
                out.push(note(tr!("{n} more mailboxes with errors", "Ещё {n} {ru}")));
            }
            out.push(Entry::Separator);
        }
    }
    out.push(item("open", pick("Open Depesha", "Открыть Депешу").to_owned()));
    if s.unread > 0 {
        let n = s.unread;
        let ru = ru_form(n, "непрочитанное", "непрочитанных", "непрочитанных");
        out.push(item("unread", tr!("Show {n} unread", "Показать {n} {ru}")));
    } else {
        let none = pick("No unread mail", "Непрочитанных нет");
        out.push(note(match &s.checked {
            Some(at) => tr!("{none} · checked at {at}", "{none} · проверено в {at}"),
            None => none.to_owned(),
        }));
    }
    out.push(Entry::Separator);
    out.push(item("compose", pick("Write", "Написать").to_owned()));
    out.push(item("check", pick("Check mail", "Проверить почту").to_owned()));
    match &s.dnd_until {
        Some(until) if until.is_empty() => out.push(item(
            "dnd:off",
            pick("Turn notifications on", "Включить уведомления").to_owned(),
        )),
        Some(until) => out.push(item(
            "dnd:off",
            tr!(
                "Turn notifications on (off until {until})",
                "Включить уведомления (выключены до {until})"
            ),
        )),
        None => out.push(Entry::Submenu {
            label: pick("Do not disturb", "Не беспокоить").to_owned(),
            items: vec![
                item("dnd:hour", pick("For an hour", "На час").to_owned()),
                item("dnd:morning", pick("Until morning", "До утра").to_owned()),
                item("dnd:forever", pick("Until I turn it off", "Пока не включу").to_owned()),
            ],
        }),
    }
    out.push(Entry::Separator);
    out.push(item("quit", pick("Quit", "Выйти").to_owned()));
    out
}

/// Mailboxes in trouble named one by one; the rest are counted.
const PROBLEMS: usize = 3;

/// The Russian word for a count: one, a few, many.
fn ru_form<'a>(n: u32, one: &'a str, few: &'a str, many: &'a str) -> &'a str {
    match (n % 10, n % 100) {
        (1, r) if r != 11 => one,
        (2..=4, r) if !(12..=14).contains(&r) => few,
        _ => many,
    }
}

/// The hint over the icon (Windows).
pub fn tooltip(unread: u32) -> String {
    let name = pick("Depesha", "Депеша");
    if unread == 0 {
        return name.to_owned();
    }
    let ru = ru_form(unread, "непрочитанное", "непрочитанных", "непрочитанных");
    tr!("{name} — {unread} unread", "{name} — {unread} {ru}")
}

/// What the icon shows now: its menu, the number on it, its hint.
type Drawn = (Vec<Entry>, Option<String>, String);

/// The tray icon of the running app: whether the system has a tray, the icon, and what
/// it shows now (redrawn only when that changes).
pub struct TrayCtl {
    presence: Mutex<Tray>,
    icon: Mutex<Option<TrayIcon>>,
    shown: Mutex<Option<Drawn>>,
    /// When mail was last checked, Unix time.
    checked: Mutex<Option<i64>>,
    refreshing: AtomicBool,
}

impl Default for TrayCtl {
    fn default() -> Self {
        TrayCtl {
            presence: Mutex::new(Tray::Checking),
            icon: Mutex::new(None),
            shown: Mutex::new(None),
            checked: Mutex::new(None),
            refreshing: AtomicBool::new(false),
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Changes reach the icon at most this often: syncs come in bursts.
const REFRESH_AFTER: Duration = Duration::from_millis(700);

impl TrayCtl {
    pub fn presence(&self) -> Tray {
        *lock(&self.presence)
    }

    /// A folder was synced: the menu says when mail was checked.
    pub fn checked(&self) {
        *lock(&self.checked) = Some(chrono::Utc::now().timestamp());
    }
}

/// The icon as the panels draw it: larger where it is scaled down, small on Windows.
fn base_icon() -> Option<(Vec<u8>, u32)> {
    #[cfg(windows)]
    let (bytes, size) = (&include_bytes!("../icons/32x32.png")[..], 32);
    #[cfg(not(windows))]
    let (bytes, size) = (&include_bytes!("../icons/64x64.png")[..], 64);
    let image = Image::from_bytes(bytes).ok()?;
    (image.width() == size && image.height() == size).then(|| (image.rgba().to_vec(), size))
}

/// Puts the icon in the tray; a system without one (GNOME without AppIndicator, a panel
/// not up yet at login) fails, and it is tried again for a minute.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut probe = TrayProbe::default();
        loop {
            match build(&app) {
                Ok(()) => return,
                Err(e) => match probe.failed() {
                    Some(wait) => {
                        tracing::debug!("no tray yet: {e}");
                        tokio::time::sleep(wait).await;
                    }
                    None => {
                        tracing::info!("no tray: {e}");
                        set_presence(&app, Tray::Absent);
                        return;
                    }
                },
            }
        }
    });
}

/// Closing the window where the tray was missing: an extension may have come since.
pub fn recheck(app: &AppHandle) -> Tray {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return Tray::Absent;
    };
    if state.tray.presence() == Tray::Absent && build(app).is_ok() {
        return Tray::Present;
    }
    state.tray.presence()
}

fn set_presence(app: &AppHandle, presence: Tray) {
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        *lock(&state.tray.presence) = presence;
        state.emit("background-changed", serde_json::json!({}));
    }
}

fn build(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<Arc<AppState>>();
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip(tooltip(0))
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu)
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                background::tray_click(tray.app_handle());
            }
        });
    if let Some((rgba, size)) = base_icon() {
        builder = builder.icon(Image::new_owned(rgba, size, size));
    } else if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let icon = builder.build(app)?;
    *lock(&state.tray.icon) = Some(icon);
    *lock(&state.tray.shown) = None;
    set_presence(app, Tray::Present);
    refresh(app);
    Ok(())
}

/// Something the icon shows may have changed: it is redrawn a moment later, once.
pub fn refresh_soon(state: &AppState) {
    if state.tray.refreshing.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = state.app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(REFRESH_AFTER).await;
        if let Some(state) = app.try_state::<Arc<AppState>>() {
            state.tray.refreshing.store(false, Ordering::Release);
        }
        refresh(&app);
    });
}

/// Draws the number, the hint and the menu as they are now; shows or hides the icon.
pub fn refresh(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    let settings = state.settings();
    let unread = state.store.folders(None).map(|f| inbox_unread(&f)).unwrap_or(0);
    let count = if settings.tray_count { unread } else { 0 };
    if let Some(w) = app.get_webview_window("main") {
        // Docks that count (Ubuntu Dock, KDE) show it too; Windows has no such badge.
        let _ = w.set_badge_count((count > 0).then_some(count as i64));
    }
    let Some(icon) = lock(&state.tray.icon).clone() else {
        return;
    };
    let window_shown = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    let _ = icon.set_visible(settings.tray_always || !window_shown);

    let now = chrono::Utc::now().timestamp();
    let clock = |t: i64| {
        chrono::DateTime::from_timestamp(t, 0).map(|t| t.with_timezone(&chrono::Local).format("%H:%M").to_string())
    };
    let problems = state
        .accounts()
        .into_iter()
        .filter_map(|a| {
            let status = state.status(&a.id)?;
            (status.state == "paused").then(|| Problem {
                label: if a.label.trim().is_empty() {
                    a.email.clone()
                } else {
                    a.label.trim().to_owned()
                },
                auth: status.error.as_ref().is_none_or(|e| e.kind == "auth"),
                account_id: a.id,
            })
        })
        .collect();
    let model = menu(&MenuState {
        unread,
        checked: lock(&state.tray.checked).and_then(clock),
        problems,
        dnd_until: (settings.dnd_until > now)
            .then(|| dnd_label(settings.dnd_until))
            .flatten(),
    });
    let hint = tooltip(unread);
    let badge = badge_text(count);
    let mut shown = lock(&state.tray.shown);
    let before = shown.take();
    let (old_menu, old_badge, old_hint) = match before {
        Some((m, b, h)) => (Some(m), Some(b), Some(h)),
        None => (None, None, None),
    };
    if old_menu.as_ref() != Some(&model) {
        match build_menu(app, &model) {
            Ok(m) => {
                let _ = icon.set_menu(Some(m));
            }
            Err(e) => tracing::warn!("tray menu: {e}"),
        }
    }
    if old_badge.as_ref() != Some(&badge)
        && let Some((rgba, size)) = base_icon()
    {
        let _ = icon.set_icon(Some(Image::new_owned(badge_icon(&rgba, size, count), size, size)));
    }
    if old_hint.as_ref() != Some(&hint) {
        let _ = icon.set_tooltip(Some(&hint));
    }
    *shown = Some((model, badge, hint));
}

/// «Until 09:00»: a stretch that ends on another day names the day too; «until I turn it
/// off» (the year 2100) is empty.
fn dnd_label(until: i64) -> Option<String> {
    let at = chrono::DateTime::from_timestamp(until, 0)?.with_timezone(&chrono::Local);
    let now = chrono::Local::now();
    if at.date_naive() == now.date_naive() {
        Some(at.format("%H:%M").to_string())
    } else if (at.date_naive() - now.date_naive()).num_days() < 7 {
        Some(at.format("%d.%m %H:%M").to_string())
    } else {
        // Until turned on again: nothing to say about when.
        Some(String::new())
    }
}

fn build_menu(app: &AppHandle, entries: &[Entry]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for e in entries {
        menu.append(&*menu_item(app, e)?)?;
    }
    Ok(menu)
}

fn menu_item(app: &AppHandle, e: &Entry) -> tauri::Result<Box<dyn IsMenuItem<tauri::Wry>>> {
    Ok(match e {
        Entry::Item { id, label, enabled } => {
            Box::new(MenuItem::with_id(app, id.as_str(), label, *enabled, None::<&str>)?)
        }
        Entry::Separator => Box::new(PredefinedMenuItem::separator(app)?),
        Entry::Submenu { label, items } => {
            let sub = Submenu::new(app, label, true)?;
            for i in items {
                sub.append(&*menu_item(app, i)?)?;
            }
            Box::new(sub)
        }
    })
}

fn on_menu(app: &AppHandle, e: MenuEvent) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    let id = e.id.as_ref();
    let errand = |action: &str, account_id: Option<&str>| {
        background::show_main(app);
        state.emit_main(
            "tray-action",
            serde_json::json!({ "action": action, "account_id": account_id }),
        );
    };
    match id {
        "open" => background::show_main(app),
        "unread" => errand("unread", None),
        "compose" => errand("compose", None),
        "check" => {
            for account in state.accounts() {
                if let Ok(w) = state.worker(&account.id) {
                    w.kick(Work::SyncAll);
                }
            }
        }
        "quit" => background::quit(app, false),
        _ if id.starts_with("dnd:") => set_dnd(&state, &id[4..]),
        _ => {
            if let Some(account) = id.strip_prefix("account:") {
                errand("account", Some(account));
            }
        }
    }
}

/// «Do not disturb» from the menu: the same stretches as the bell in the sidebar.
fn set_dnd(state: &AppState, how: &str) {
    let now = chrono::Local::now();
    let until = match how {
        "hour" => now.timestamp() + 3600,
        "morning" => {
            let day = if now.time() >= chrono::NaiveTime::from_hms_opt(9, 0, 0).unwrap_or_default() {
                now.date_naive() + chrono::Days::new(1)
            } else {
                now.date_naive()
            };
            day.and_hms_opt(9, 0, 0)
                .and_then(|t| t.and_local_timezone(chrono::Local).earliest())
                .map_or(now.timestamp() + 12 * 3600, |t| t.timestamp())
        }
        "forever" => 4_102_444_800,
        _ => 0,
    };
    let mut settings = state.settings();
    settings.dnd_until = until;
    if let Err(e) = state.save_settings(settings) {
        tracing::warn!("do not disturb: {}", e.message);
        return;
    }
    state.emit("settings-changed", serde_json::json!({}));
}

#[cfg(test)]
mod tests {
    use super::*;
    use depesha_core::imap::Folder;
    use depesha_core::lang::{self, Lang};

    fn item(id: &str, label: &str) -> Entry {
        Entry::Item {
            id: id.into(),
            label: label.into(),
            enabled: true,
        }
    }

    fn note(label: &str) -> Entry {
        Entry::Item {
            id: String::new(),
            label: label.into(),
            enabled: false,
        }
    }

    fn rest() -> Vec<Entry> {
        vec![
            Entry::Separator,
            item("compose", "Написать"),
            item("check", "Проверить почту"),
            Entry::Submenu {
                label: "Не беспокоить".into(),
                items: vec![
                    item("dnd:hour", "На час"),
                    item("dnd:morning", "До утра"),
                    item("dnd:forever", "Пока не включу"),
                ],
            },
            Entry::Separator,
            item("quit", "Выйти"),
        ]
    }

    #[test]
    fn the_menu_says_the_state_when_all_is_read() {
        lang::pin(Lang::Ru);
        let s = MenuState {
            checked: Some("14:30".into()),
            ..Default::default()
        };
        let mut want = vec![
            item("open", "Открыть Депешу"),
            note("Непрочитанных нет · проверено в 14:30"),
        ];
        want.extend(rest());
        assert_eq!(menu(&s), want);
        let s = MenuState::default();
        assert_eq!(menu(&s)[1], note("Непрочитанных нет"));
    }

    #[test]
    fn unread_letters_replace_the_state_with_a_way_to_them() {
        lang::pin(Lang::Ru);
        for (n, label) in [
            (1, "Показать 1 непрочитанное"),
            (3, "Показать 3 непрочитанных"),
            (5, "Показать 5 непрочитанных"),
            (21, "Показать 21 непрочитанное"),
        ] {
            let s = MenuState {
                unread: n,
                checked: Some("14:30".into()),
                ..Default::default()
            };
            let mut want = vec![item("open", "Открыть Депешу"), item("unread", label)];
            want.extend(rest());
            assert_eq!(menu(&s), want);
        }
        lang::pin(Lang::En);
        let s = MenuState {
            unread: 2,
            ..Default::default()
        };
        assert_eq!(menu(&s)[1], item("unread", "Show 2 unread"));
    }

    #[test]
    fn do_not_disturb_turns_into_a_way_back() {
        lang::pin(Lang::Ru);
        let s = MenuState {
            dnd_until: Some("09:00".into()),
            ..Default::default()
        };
        assert!(menu(&s).contains(&item("dnd:off", "Включить уведомления (выключены до 09:00)")));
        assert!(!menu(&s).iter().any(|e| matches!(e, Entry::Submenu { .. })));
        let s = MenuState {
            dnd_until: Some(String::new()),
            ..Default::default()
        };
        assert!(menu(&s).contains(&item("dnd:off", "Включить уведомления")));
    }

    #[test]
    fn a_mailbox_in_trouble_comes_first() {
        lang::pin(Lang::Ru);
        let problem = |id: &str, label: &str, auth: bool| Problem {
            account_id: id.into(),
            label: label.into(),
            auth,
        };
        let s = MenuState {
            problems: vec![problem("a", "Работа", true)],
            ..Default::default()
        };
        let m = menu(&s);
        assert_eq!(
            m[..4],
            [
                note("Работа: не удалось войти"),
                item("account:a", "Открыть настройки ящика…"),
                Entry::Separator,
                item("open", "Открыть Депешу")
            ]
        );
        // Several: a line each, up to three, then how many more.
        let s = MenuState {
            problems: vec![
                problem("a", "Работа", true),
                problem("b", "Личное", false),
                problem("c", "Дача", true),
                problem("d", "Склад", true),
                problem("e", "Архив", true),
            ],
            ..Default::default()
        };
        let m = menu(&s);
        assert_eq!(
            m[..6],
            [
                item("account:a", "Работа: не удалось войти"),
                item("account:b", "Личное: сервер отказал"),
                item("account:c", "Дача: не удалось войти"),
                note("Ещё 2 ящика с ошибками"),
                Entry::Separator,
                item("open", "Открыть Депешу")
            ]
        );
    }

    #[test]
    fn the_hint_counts_the_unread() {
        lang::pin(Lang::Ru);
        assert_eq!(tooltip(0), "Депеша");
        assert_eq!(tooltip(5), "Депеша — 5 непрочитанных");
        assert_eq!(tooltip(1), "Депеша — 1 непрочитанное");
    }

    fn folder(account: &str, name: &str, role: Option<FolderRole>, unread: u32) -> FolderInfo {
        FolderInfo {
            account_id: account.into(),
            folder: Folder {
                name: name.into(),
                display_name: name.into(),
                delimiter: None,
                role,
                selectable: true,
                hidden: false,
            },
            total: 100,
            unread,
        }
    }

    #[test]
    fn only_inboxes_count() {
        let folders = [
            folder("a", "INBOX", Some(FolderRole::Inbox), 4),
            folder("a", "Archive", Some(FolderRole::Archive), 9),
            folder("a", "Lists", None, 7),
            folder("b", "Входящие", Some(FolderRole::Inbox), 1),
        ];
        assert_eq!(inbox_unread(&folders), 5);
        assert_eq!(inbox_unread(&[]), 0);
    }

    #[test]
    fn the_number_is_a_digit_or_nine_plus() {
        assert_eq!(badge_text(0), None);
        assert_eq!(badge_text(1).as_deref(), Some("1"));
        assert_eq!(badge_text(9).as_deref(), Some("9"));
        assert_eq!(badge_text(10).as_deref(), Some("9+"));
        assert_eq!(badge_text(4321).as_deref(), Some("9+"));
    }

    /// A plain red square, opaque.
    fn base(size: u32) -> Vec<u8> {
        (0..size * size).flat_map(|_| [200u8, 30, 30, 255]).collect()
    }

    fn px(img: &[u8], size: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * size + x) * 4) as usize;
        [img[i], img[i + 1], img[i + 2], img[i + 3]]
    }

    #[test]
    fn the_number_is_drawn_in_the_corner() {
        for size in [32, 64] {
            let icon = base(size);
            assert_eq!(badge_icon(&icon, size, 0), icon, "nothing to count, nothing drawn");
            let five = badge_icon(&icon, size, 5);
            assert_eq!(five.len(), icon.len());
            // The upper left part of the seal stays as it was.
            assert_eq!(px(&five, size, 2, 2), px(&icon, size, 2, 2));
            // The badge is white with a dark figure: both are there in the corner.
            let corner: Vec<[u8; 4]> = (size / 2..size)
                .flat_map(|y| (size / 2..size).map(move |x| (x, y)))
                .map(|(x, y)| px(&five, size, x, y))
                .collect();
            assert!(
                corner.iter().any(|p| p[0] > 240 && p[1] > 240 && p[2] > 240),
                "a white circle at {size}"
            );
            assert!(
                corner.iter().any(|p| p[0] < 60 && p[1] < 60 && p[2] < 60 && p[3] > 200),
                "a dark figure at {size}"
            );
            // Different numbers look different; past nine they all read «9+».
            assert_ne!(badge_icon(&icon, size, 4), five);
            assert_ne!(badge_icon(&icon, size, 9), badge_icon(&icon, size, 10));
            assert_eq!(badge_icon(&icon, size, 10), badge_icon(&icon, size, 250));
        }
    }
}
