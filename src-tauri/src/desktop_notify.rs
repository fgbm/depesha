//! Desktop notifications that open what they tell about (#63). tauri-plugin-notification
//! drops the handle on the desktop, so a click never came back; here it does: on Linux
//! over D-Bus (notify-rust), on Windows through the toast's activation (WinRT).
//!
//! New mail is told once per check of all mailboxes: one letter by its sender and
//! subject, several by a summary (#4/#63 decisions, frames 10A and 11В). A notification
//! still on screen is replaced, not joined by another one.

use depesha_core::store::MessageRow;
use serde::Serialize;

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
    pub gone: Option<Gone>,
}

/// The target as the cache has it now: the letter where it is, found again by its
/// Message-ID after a move, or gone. `folder_of` answers the folder of a cached letter;
/// `find` a letter by account and Message-ID.
pub fn resolve(
    _target: &Target,
    _folder_of: impl Fn(i64) -> Option<String>,
    _find: impl Fn(&str, &str) -> Option<(i64, String)>,
) -> Open {
    todo!()
}

/// What a notification tells about: letters from people, or, when only newsletters
/// came, those (`true`: bulk, shown only with «notify about all»).
pub fn worth(_letters: Vec<Letter>) -> (Vec<Letter>, bool) {
    todo!()
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
pub fn word(_letters: &[Letter], _bulk: bool, _label: &dyn Fn(&str) -> String, _mailboxes: usize) -> Option<Shown> {
    todo!()
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
pub fn merge(_live: &[Live], _fresh: Vec<Letter>) -> Merge {
    todo!()
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
        }
    }

    #[test]
    fn a_click_finds_the_letter_where_it_is_now() {
        // In place.
        let open = resolve(&target(Some(7)), |id| (id == 7).then(|| "INBOX".into()), |_, _| None);
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
                gone: None
            }
        );
    }
}
