//! The rules of snoozed mail (#133): a letter waits in the Snoozed folder with a time to come
//! back at and the folder to come back to (`Store::snooze_add_batch`, which keeps the folder it
//! was first snoozed from). Bringing it back, by the clock or by hand, moves it by Message-ID
//! (UIDs change on every move), unread, and only then drops its time: a crash in between must
//! not leave a letter in Snoozed with no time to come back at. The moving itself is the
//! caller's (`Move` goes to the mailbox's queue, `port::MailQueue`), and so is the clock: the rules take `now`.

use std::collections::BTreeMap;

use crate::Result;
use crate::port::{MailQueue, Move};
use crate::store::{MessageRow, Snooze, Store};

/// The letters a snooze can keep: those with a Message-ID, which finds them again once they
/// have moved, and what is kept of them, `(Message-ID, subject)`.
#[derive(Debug)]
pub struct Trackable {
    pub rows: Vec<MessageRow>,
    pub batch: Vec<(String, String)>,
}

/// Of the letters, those that can be snoozed. `None`: none can.
pub fn trackable(rows: Vec<MessageRow>) -> Option<Trackable> {
    let rows: Vec<MessageRow> = rows.into_iter().filter(|r| r.message_id.is_some()).collect();
    let batch: Vec<(String, String)> = rows
        .iter()
        .filter_map(|r| r.message_id.clone().map(|mid| (mid, r.subject.clone())))
        .collect();
    (!rows.is_empty()).then_some(Trackable { rows, batch })
}

/// Snoozed letters that come back together: of one mailbox, from one folder, to one folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub account_id: String,
    pub folder: String,
    pub to: String,
    pub snoozed: Vec<Snooze>,
}

impl Release {
    pub fn message_ids(&self) -> Vec<String> {
        self.snoozed.iter().map(|s| s.message_id.clone()).collect()
    }

    /// The move that brings the group back: unread, as when the time comes.
    pub fn bring(&self) -> Move {
        back(&self.folder, &self.to, self.message_ids())
    }
}

fn back(from: &str, to: &str, message_ids: Vec<String>) -> Move {
    Move {
        from: from.to_owned(),
        message_ids,
        to: to.to_owned(),
        unseen: true,
    }
}

/// The groups the snoozed letters among `message_ids` of `folder` come back in: by the folder
/// they came from, as a series of letters may have come from several. Nothing is dropped:
/// the times stay in the store until the letters have moved.
pub fn releases(store: &Store, account_id: &str, folder: &str, message_ids: &[String]) -> Result<Vec<Release>> {
    let mut back: BTreeMap<String, Vec<Snooze>> = BTreeMap::new();
    for s in store.snoozes_in_folder(account_id, folder, message_ids)? {
        back.entry(s.return_to.clone()).or_default().push(s);
    }
    Ok(back
        .into_iter()
        .map(|(to, snoozed)| Release {
            account_id: account_id.to_owned(),
            folder: folder.to_owned(),
            to,
            snoozed,
        })
        .collect())
}

/// Brings the groups back one after another. A group that failed to come back does not take
/// the others down with it: what the others moved (`T`, the undo) must reach the caller, and
/// the groups after it are tried too. The result says whether some letters stayed. With
/// nothing moved at all the first error is the caller's.
pub async fn release_groups<T, E, F, Fut>(groups: Vec<Release>, mut one: F) -> std::result::Result<(Vec<T>, bool), E>
where
    F: FnMut(Release) -> Fut,
    Fut: std::future::Future<Output = std::result::Result<Option<T>, E>>,
{
    let mut done = Vec::new();
    let mut failed: Option<E> = None;
    for group in groups {
        match one(group).await {
            Ok(Some(moved)) => done.push(moved),
            // Not moved: the times were never dropped, the letters are still snoozed.
            Ok(None) => {}
            Err(e) => {
                failed.get_or_insert(e);
            }
        }
    }
    match failed {
        Some(e) if done.is_empty() => Err(e),
        failed => Ok((done, failed.is_some())),
    }
}

/// Drops the times of the letters a move has taken out of `folder`, one by one. The server
/// reports only a count, and by UIDs, not by Message-ID (a short count may hide a letter that
/// was not found next to another with the same Message-ID), so the letters are told by the
/// cache: the move synced the folder, and a letter no longer in it has left. A letter still
/// there keeps its time and comes back at it. If the sync failed the cache is stale, every
/// letter looks to be there and nothing is dropped, which is harmless: the clock removes the
/// time of a letter it finds gone from Snoozed.
pub fn drop_left(store: &Store, account_id: &str, folder: &str, message_ids: &[String]) -> Result<()> {
    let mut left = Vec::new();
    for mid in message_ids {
        if store.find_by_message_id(account_id, folder, mid)?.is_none() {
            left.push(mid.clone());
        }
    }
    store.snooze_drop_in_folder(account_id, folder, &left)?;
    Ok(())
}

/// The snoozes whose time has come at `now`, by mailbox: one that hangs or is offline must not
/// hold the others' snoozes up.
pub fn due_by_account(store: &Store, now: i64) -> Result<BTreeMap<String, Vec<Snooze>>> {
    let mut by_account: BTreeMap<String, Vec<Snooze>> = BTreeMap::new();
    for s in store.snoozes_due(now)? {
        by_account.entry(s.account_id.clone()).or_default().push(s);
    }
    Ok(by_account)
}

/// What came of bringing the due snoozes of a mailbox back.
#[derive(Debug, Default)]
pub struct Returned {
    /// Some time was dropped: the counters are to be read again.
    pub changed: bool,
    /// Times that could not be dropped: the next round meets them again and finds their
    /// letters gone. The core does not log; the caller does.
    pub not_dropped: Vec<crate::Error>,
    /// What the queue failed with (offline, the mailbox paused), one per letter that stays.
    pub failed: Vec<crate::Error>,
}

/// Brings the due snoozes back one after another through the queue. None moved: they were
/// moved elsewhere by hand (another client), there is nothing to bring back and the time goes.
/// An error leaves the time: the next round tries again. `on_back` hears of each letter as
/// soon as it has come back, before the next is moved: the user is told of it at once, not
/// after the whole batch.
pub async fn return_due<Q: MailQueue>(
    store: &Store,
    due: &[Snooze],
    queue: &mut Q,
    on_back: &mut (dyn FnMut(&Snooze) + Send),
) -> Returned {
    let mut out = Returned::default();
    for s in due {
        let count = match queue
            .move_by_message_id(back(&s.folder, &s.return_to, vec![s.message_id.clone()]))
            .await
        {
            Ok(count) => count,
            Err(e) => {
                out.failed.push(e);
                continue;
            }
        };
        out.changed = true;
        if let Err(e) = store.snooze_remove(&s.account_id, &s.message_id) {
            out.not_dropped.push(e);
        }
        if count > 0 {
            on_back(s);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Error;
    use crate::domain::{Folder, FolderRole};
    use crate::message::Summary;
    use crate::port::fake::Queue;
    use crate::store::NewMessage;

    fn store() -> Store {
        let store = Store::open_in_memory().unwrap();
        let snoozed = Folder {
            name: "Snoozed".into(),
            display_name: "Snoozed".into(),
            delimiter: Some("/".into()),
            role: Some(FolderRole::Snoozed),
            selectable: true,
            hidden: false,
        };
        store.replace_folders("a", &[snoozed]).unwrap();
        store
    }

    fn snooze(store: &Store, account: &str, mid: &str, return_to: &str, until: i64) -> Snooze {
        let s = Snooze {
            account_id: account.into(),
            message_id: mid.into(),
            folder: "Snoozed".into(),
            return_to: return_to.into(),
            until,
            subject: format!("о {mid}"),
        };
        store.snooze_add(&s).unwrap();
        s
    }

    fn cache(store: &Store, uid: u32, mid: &str) {
        let s = Summary {
            message_id: Some(mid.into()),
            date: Some(1),
            ..Default::default()
        };
        let msg = NewMessage {
            uid,
            summary: &s,
            fallback_date: 0,
            size: 1,
            flags: Default::default(),
            keywords: Vec::new(),
        };
        store.insert_message("a", "Snoozed", &msg).unwrap();
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn the_times_of_the_letters_that_left_are_dropped_by_name() {
        let store = store();
        let all = ids(&["<a@x>", "<b@x>", "<c@x>"]);
        for id in &all {
            snooze(&store, "a", id, "INBOX", 100);
        }
        // After a short move the cache of Snoozed still holds "b" twice (one Message-ID, two
        // UIDs: the count of the server cannot tell it from two letters) and not "a", "c".
        cache(&store, 1, "b@x");
        cache(&store, 2, "b@x");
        // Reading the times drops nothing: a crash before the move leaves them.
        assert_eq!(store.snoozes_in_folder("a", "Snoozed", &all).unwrap().len(), 3);
        drop_left(&store, "a", "Snoozed", &all).unwrap();
        let left = store.snoozes_in_folder("a", "Snoozed", &all).unwrap();
        assert_eq!(left.len(), 1, "only the letter still snoozed keeps its time");
        assert_eq!(left[0].message_id, "<b@x>");
    }

    #[test]
    fn letters_come_back_in_groups_by_the_folder_they_came_from() {
        let store = store();
        snooze(&store, "a", "<1@x>", "INBOX", 100);
        snooze(&store, "a", "<2@x>", "Work", 100);
        snooze(&store, "a", "<3@x>", "INBOX", 100);
        snooze(&store, "a", "<4@x>", "INBOX", 100);
        // The letters asked for: three of the four, and one that is not snoozed.
        let asked = ids(&["<1@x>", "<2@x>", "<3@x>", "<nope@x>"]);
        let groups = releases(&store, "a", "Snoozed", &asked).unwrap();
        assert_eq!(
            groups.iter().map(|g| g.to.as_str()).collect::<Vec<_>>(),
            ["INBOX", "Work"]
        );
        let mut inbox = groups[0].message_ids();
        inbox.sort();
        assert_eq!(inbox, ["<1@x>", "<3@x>"]);
        assert_eq!(groups[1].message_ids(), ["<2@x>"]);
        // They come back unread, from where they wait to where they were.
        assert_eq!(
            groups[1].bring(),
            Move {
                from: "Snoozed".into(),
                message_ids: ids(&["<2@x>"]),
                to: "Work".into(),
                unseen: true
            }
        );
        // Asking only brings nothing out of the store.
        assert_eq!(store.snoozes_in_folder("a", "Snoozed", &asked).unwrap().len(), 3);
        assert!(releases(&store, "a", "INBOX", &asked).unwrap().is_empty());
    }

    #[test]
    fn only_letters_with_a_message_id_can_be_snoozed() {
        let store = store();
        let row = |uid: u32, mid: Option<&str>, subject: &str| {
            let s = Summary {
                message_id: mid.map(str::to_owned),
                subject: subject.into(),
                date: Some(1),
                ..Default::default()
            };
            let msg = NewMessage {
                uid,
                summary: &s,
                fallback_date: 0,
                size: 1,
                flags: Default::default(),
                keywords: Vec::new(),
            };
            let id = store.insert_message("a", "Snoozed", &msg).unwrap();
            store.get_at(id).unwrap().unwrap().0
        };
        let with = row(1, Some("<w@x>"), "Есть");
        let without = row(2, None, "Нет");
        let kept = trackable(vec![with.clone(), without.clone()]).unwrap();
        assert_eq!(kept.batch, [("<w@x>".to_owned(), "Есть".to_owned())]);
        // Only those are to be moved: a letter moved without a time would never come back.
        assert_eq!(kept.rows.iter().map(|r| r.uid).collect::<Vec<_>>(), [1]);
        assert!(trackable(vec![without]).is_none());
        assert!(trackable(Vec::new()).is_none());
    }

    #[test]
    fn due_snoozes_are_told_by_the_clock_it_is_given_and_by_mailbox() {
        let store = store();
        snooze(&store, "a", "<now@x>", "INBOX", 100);
        snooze(&store, "a", "<later@x>", "INBOX", 200);
        snooze(&store, "b", "<other@x>", "INBOX", 50);
        let due = due_by_account(&store, 100).unwrap();
        assert_eq!(due.keys().collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(due["a"].len(), 1);
        assert_eq!(due["a"][0].message_id, "<now@x>");
        // The same store at another time: the rules do not look at the clock themselves.
        assert!(due_by_account(&store, 49).unwrap().is_empty());
        assert_eq!(due_by_account(&store, 200).unwrap()["a"].len(), 2);
    }

    #[tokio::test]
    async fn a_due_snooze_goes_when_its_letter_came_back_or_was_moved_by_hand_and_stays_when_the_server_is_down() {
        let store = store();
        let back = snooze(&store, "a", "<back@x>", "INBOX", 10);
        let gone = snooze(&store, "a", "<gone@x>", "INBOX", 10);
        let down = snooze(&store, "a", "<down@x>", "Work", 10);
        let mut queue = Queue {
            moved: [Ok(1), Ok(0), Err(Error::Closed)].into(),
            ..Default::default()
        };
        let mut told = Vec::new();
        let out = return_due(
            &store,
            &[back.clone(), gone.clone(), down.clone()],
            &mut queue,
            &mut |s| told.push(s.message_id.clone()),
        )
        .await;
        assert_eq!(told, ["<back@x>"], "only a letter that came back is told of");
        assert!(out.changed);
        // The failure is seen outside, one per letter that stays.
        assert!(matches!(out.failed.as_slice(), [Error::Closed]));
        // One letter at a time, unread, to the folder it left.
        assert_eq!(queue.moves.len(), 3);
        assert!(queue.moves.iter().all(|m| m.unseen && m.from == "Snoozed"));
        assert_eq!(queue.moves[2].to, "Work");
        // The letter nobody found is forgotten, the offline one is tried again.
        let left = store.snoozes_due(100).unwrap();
        assert_eq!(left, [down]);
        // Nothing moved, nothing changed.
        let mut queue = Queue {
            moved: [Err(Error::Closed)].into(),
            ..Default::default()
        };
        let out = return_due(&store, &left, &mut queue, &mut |_| {}).await;
        assert!(!out.changed && out.not_dropped.is_empty());
        assert_eq!(out.failed.len(), 1);
    }

    #[tokio::test]
    async fn a_letter_is_told_of_as_soon_as_it_is_back_before_the_next_is_moved() {
        let store = store();
        let one = snooze(&store, "a", "<1@x>", "INBOX", 10);
        let two = snooze(&store, "a", "<2@x>", "INBOX", 10);
        let mut queue = Queue::default();
        let log = queue.log.clone();
        return_due(&store, &[one, two], &mut queue, &mut |s| {
            log.lock().unwrap().push(format!("told {}", s.message_id));
        })
        .await;
        assert_eq!(
            *queue.log.lock().unwrap(),
            ["move <1@x>", "told <1@x>", "move <2@x>", "told <2@x>"]
        );
    }

    #[tokio::test]
    async fn a_failed_group_does_not_cost_the_others_their_undo() {
        let group = |folder: &str| Release {
            account_id: "a".into(),
            folder: folder.into(),
            to: "INBOX".into(),
            snoozed: Vec::new(),
        };
        let (done, partial) = release_groups(vec![group("one"), group("two"), group("three")], |g| async move {
            if g.folder == "two" {
                Err("connection lost")
            } else {
                Ok(Some(g.folder))
            }
        })
        .await
        .unwrap();
        assert_eq!(done, ["one", "three"], "the group after the failed one was tried too");
        assert!(partial);
        // Nothing moved: the error is the caller's.
        let err = release_groups(vec![group("one")], |_| async {
            Err::<Option<()>, _>("connection lost")
        })
        .await
        .unwrap_err();
        assert_eq!(err, "connection lost");
        // Not moved but not failed (the letters were gone): nothing to undo, no warning.
        let (done, partial) = release_groups(vec![group("one")], |_| async { Ok::<Option<()>, &str>(None) })
            .await
            .unwrap();
        assert!(done.is_empty() && !partial);
        // All back: no warning.
        let (_, partial) = release_groups(vec![group("one")], |g| async move { Ok::<_, &str>(Some(g.folder)) })
            .await
            .unwrap();
        assert!(!partial);
    }
}
