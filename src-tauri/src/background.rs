//! Work in the background (#4): what closing the main window does, the way back to it,
//! starting at login and quitting for real. The window hides instead of closing: the
//! mail rules and plugins live in its page and keep running.

use std::time::Duration;

use depesha_core::store::OutboxItem;

use crate::config::Settings;

/// Whether the system shows tray icons. Known only after the icon was tried: a panel
/// may come up after the app at login, so a failure is tried again for a minute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tray {
    Checking,
    Present,
    Absent,
}

/// What a click on the window's close button does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnClose {
    Hide,
    Quit,
    /// The main window asks; `no_tray`: there is no icon to come back by (#4, frame 3).
    Ask {
        no_tray: bool,
    },
}

pub fn on_close(_settings: &Settings, _tray: Tray) -> OnClose {
    todo!()
}

/// What a left click on the tray icon does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnTrayClick {
    Show,
    Hide,
}

/// A click took the focus from the window just now: the window was in front.
pub const CLICK_TOOK_FOCUS: Duration = Duration::from_millis(400);

/// As in Telegram: a window in front hides, any other comes forward. `blurred` is how long
/// ago the window lost the focus: on Windows the click on the taskbar takes it first.
pub fn on_tray_click(_visible: bool, _minimized: bool, _focused: bool, _blurred: Option<Duration>) -> OnTrayClick {
    todo!()
}

/// The argument of the login entry (tauri-plugin-autostart).
pub const BACKGROUND_ARG: &str = "--background";

/// Started at login with only the icon: the window stays hidden, unless the user asked
/// to start with the window.
pub fn starts_hidden(_args: &[String], _settings: &Settings) -> bool {
    todo!()
}

/// The tray icon is tried again this often, this many times (a minute), then given up.
pub const TRAY_RETRY: Duration = Duration::from_secs(5);
pub const TRAY_TRIES: u32 = 12;

/// Failed attempts to build the tray icon.
#[derive(Debug, Default)]
pub struct TrayProbe {
    failures: u32,
}

impl TrayProbe {
    /// One more attempt failed: when to try again, or `None` when there is no tray.
    pub fn failed(&mut self) -> Option<Duration> {
        todo!()
    }
}

/// Scheduled letters the app would not send if it quit now: due within a day.
pub const QUIT_ASKS_WITHIN: i64 = 24 * 3600;

pub fn due_soon(_items: &[OutboxItem], _now: i64) -> Vec<&OutboxItem> {
    todo!()
}

/// A letter this late was not sent in time (the app was closed, the computer asleep):
/// it waits for the user instead of leaving hours late.
pub const MISSED_AFTER: i64 = 10 * 60;

pub fn missed(_item: &OutboxItem, _now: i64) -> bool {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use depesha_core::smtp::Draft;
    use depesha_core::store::FollowupPlan;

    fn settings(close: &str, without_tray: bool) -> Settings {
        Settings {
            close_action: close.into(),
            background_without_tray: without_tray,
            ..Settings::default()
        }
    }

    #[test]
    fn closing_asks_until_the_user_chose() {
        assert_eq!(
            on_close(&Settings::default(), Tray::Present),
            OnClose::Ask { no_tray: false }
        );
        assert_eq!(
            on_close(&settings("ask", false), Tray::Present),
            OnClose::Ask { no_tray: false }
        );
        // Something unknown (a newer version's value) asks too.
        assert_eq!(
            on_close(&settings("minimize", false), Tray::Present),
            OnClose::Ask { no_tray: false }
        );
    }

    #[test]
    fn closing_without_a_tray_asks_the_other_question() {
        assert_eq!(
            on_close(&settings("ask", false), Tray::Absent),
            OnClose::Ask { no_tray: true }
        );
        // Not known yet counts as none: the window must not vanish without a way back.
        assert_eq!(
            on_close(&settings("ask", false), Tray::Checking),
            OnClose::Ask { no_tray: true }
        );
    }

    #[test]
    fn the_background_hides_the_window() {
        assert_eq!(on_close(&settings("background", false), Tray::Present), OnClose::Hide);
        // Chosen where the icon was, it is not an agreement to work with none.
        assert_eq!(
            on_close(&settings("background", false), Tray::Absent),
            OnClose::Ask { no_tray: true }
        );
        assert_eq!(on_close(&settings("background", true), Tray::Absent), OnClose::Hide);
        assert_eq!(on_close(&settings("background", true), Tray::Checking), OnClose::Hide);
    }

    #[test]
    fn quit_quits_with_or_without_a_tray() {
        for tray in [Tray::Present, Tray::Absent, Tray::Checking] {
            assert_eq!(on_close(&settings("quit", false), tray), OnClose::Quit);
        }
    }

    #[test]
    fn a_click_on_the_icon_brings_the_window_or_hides_it() {
        use OnTrayClick::*;
        // Hidden or minimized: forward.
        assert_eq!(on_tray_click(false, false, false, None), Show);
        assert_eq!(on_tray_click(true, true, false, None), Show);
        // Behind other windows: forward.
        assert_eq!(on_tray_click(true, false, false, None), Show);
        assert_eq!(on_tray_click(true, false, false, Some(Duration::from_secs(3))), Show);
        // In front: hidden, also when the click itself took the focus a moment ago.
        assert_eq!(on_tray_click(true, false, true, None), Hide);
        assert_eq!(on_tray_click(true, false, false, Some(Duration::from_millis(80))), Hide);
    }

    #[test]
    fn started_at_login_the_window_waits_unless_asked_for() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let with = |autostart: &str| Settings {
            autostart: autostart.into(),
            ..Settings::default()
        };
        assert!(!starts_hidden(&args(&["depesha"]), &with("background")));
        assert!(starts_hidden(&args(&["depesha", "--background"]), &with("background")));
        assert!(!starts_hidden(&args(&["depesha", "--background"]), &with("window")));
        // A login entry left from before still starts quietly.
        assert!(starts_hidden(&args(&["depesha", "--background"]), &with("off")));
    }

    #[test]
    fn the_tray_is_tried_for_a_minute() {
        let mut probe = TrayProbe::default();
        for _ in 1..TRAY_TRIES {
            assert_eq!(probe.failed(), Some(TRAY_RETRY));
        }
        assert_eq!(probe.failed(), None);
        assert_eq!(TRAY_RETRY * TRAY_TRIES, Duration::from_secs(60));
    }

    fn item(id: i64, next_attempt: i64, attempts: u32, failed: bool) -> OutboxItem {
        OutboxItem {
            id,
            account_id: "a".into(),
            draft: Draft::default(),
            attempts,
            next_attempt,
            last_error: None,
            failed,
            created: 0,
            followup_secs: 0,
            followup: FollowupPlan::default(),
        }
    }

    #[test]
    fn quitting_asks_about_letters_due_within_a_day() {
        let now = 1_000_000;
        let items = [
            item(1, now + 60, 0, false),
            item(2, now + QUIT_ASKS_WITHIN, 0, false),
            item(3, now + QUIT_ASKS_WITHIN + 1, 0, false),
            // Refused by the server: it waits for the user anyway.
            item(4, now + 60, 1, true),
            // Due already (the undo window): it goes in a moment.
            item(5, now - 5, 0, false),
        ];
        let ids: Vec<i64> = due_soon(&items, now).iter().map(|i| i.id).collect();
        assert_eq!(ids, vec![1, 2, 5]);
    }

    #[test]
    fn a_letter_late_by_minutes_is_missed() {
        let now = 1_000_000;
        assert!(!missed(&item(1, now, 0, false), now));
        assert!(!missed(&item(1, now - MISSED_AFTER, 0, false), now));
        assert!(missed(&item(1, now - MISSED_AFTER - 1, 0, false), now));
        // A retry after a network error keeps its turn; a refused one waits already.
        assert!(!missed(&item(1, now - 3600, 2, false), now));
        assert!(!missed(&item(1, now - 3600, 0, true), now));
    }
}
