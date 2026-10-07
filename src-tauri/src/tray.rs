//! The tray icon (#4): the number of unread letters drawn on it, a short menu, and a
//! click that brings the window or hides it. On Linux the icon goes through
//! StatusNotifierItem (ksni): a left click arrives as activation, the menu is on the right.

use depesha_core::imap::FolderRole;
use depesha_core::store::FolderInfo;

/// Unread letters in the inboxes of every mailbox, newsletters included (#4, frame 6A).
pub fn inbox_unread(_folders: &[FolderInfo]) -> u32 {
    todo!()
}

/// What the icon shows: nothing, a digit, or `9+`.
pub fn badge_text(_unread: u32) -> Option<String> {
    todo!()
}

/// The icon with the number in a white circle at its lower right corner. `rgba` is a
/// square `size`×`size` picture; with nothing to count it comes back as it is.
pub fn badge_icon(_rgba: &[u8], _size: u32, _unread: u32) -> Vec<u8> {
    todo!()
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
pub fn menu(_s: &MenuState) -> Vec<Entry> {
    todo!()
}

/// The hint over the icon (Windows).
pub fn tooltip(_unread: u32) -> String {
    todo!()
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
