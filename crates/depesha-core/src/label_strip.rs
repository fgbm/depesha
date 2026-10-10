//! Taking a label off every letter of the mailbox (#42, frame 4Б), one folder per work in the
//! mailbox's quiet queue: a whole-account walk is not one queue item that holds the mailbox for
//! minutes, a folder without rights is skipped and remembered, and the label stays in the list as
//! "being removed" until every folder is done — so a restart or a pause resumes the debt instead
//! of losing it. The queue is the port's (`port::MailQueue`); the tasks window and the events
//! are the app's. The clock is the caller's: the rules take `now` (unix seconds).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::Result;
use crate::port::MailQueue;
use crate::store::Store;

/// A debt held back by a busy or unreachable mailbox is not picked up again sooner.
pub const RETRY_AFTER_SECS: i64 = 120;

/// Whether a debt is resumed by a round: only while the mailbox is online (the round after
/// it comes back picks the debt up), and not sooner than `RETRY_AFTER_SECS` after the last try
/// that came to nothing. A clock set back since that try (`now` before it) counts as time
/// enough: the wait would be for ever.
pub fn resume_due(online: bool, stalled_at: Option<i64>, now: i64) -> bool {
    online && stalled_at.is_none_or(|at| now < at || now - at >= RETRY_AFTER_SECS)
}

type Key = (String, String);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The strips under way, and the labels whose last try came to nothing, by mailbox and label.
#[derive(Default)]
pub struct Stripping {
    running: Mutex<HashSet<Key>>,
    /// When the last try that came to nothing was made.
    stalled: Mutex<HashMap<Key, i64>>,
}

/// A strip under way; it is over when this is dropped, however its task ends. One that ends in
/// a panic is stalled from the moment it began, so that a round does not start it again at once,
/// to fall over again in a loop.
pub struct Running {
    stripping: Arc<Stripping>,
    key: Key,
    since: i64,
}

impl Drop for Running {
    fn drop(&mut self) {
        if std::thread::panicking() {
            lock(&self.stripping.stalled).insert(self.key.clone(), self.since);
        }
        lock(&self.stripping.running).remove(&self.key);
    }
}

impl Stripping {
    /// Starts the strip of one label at `now` unless it is running already.
    pub fn claim(self: &Arc<Self>, account_id: &str, name: &str, now: i64) -> Option<Running> {
        let key = (account_id.to_owned(), name.to_owned());
        lock(&self.running).insert(key.clone()).then(|| Running {
            stripping: self.clone(),
            key,
            since: now,
        })
    }
}

/// The labels of the mailbox marked as being removed whose strip a round is to start: those
/// `resume_due` lets go. One already running is left to `Stripping::claim`.
pub fn resumable(
    store: &Store,
    stripping: &Stripping,
    account_id: &str,
    online: bool,
    now: i64,
) -> Result<Vec<(String, String)>> {
    let stalled = lock(&stripping.stalled);
    Ok(store
        .stripping_labels(account_id)?
        .into_iter()
        .filter(|(name, _)| {
            let at = stalled.get(&(account_id.to_owned(), name.clone())).copied();
            resume_due(online, at, now)
        })
        .collect())
}

/// What came of a walk over the folders.
#[derive(Debug)]
pub enum Ended {
    /// Every folder is done or skipped: the cache follows the server and the label has left the
    /// list. `skipped` names the folders that refused, with why; `not_cleaned` the cache steps
    /// that failed (the next start meets the label gone from the server and finishes).
    Finished {
        /// Letters that lost the label.
        count: usize,
        skipped: Vec<(String, crate::Error)>,
        not_cleaned: Vec<crate::Error>,
    },
    /// A pause, an offline mailbox, a busy server or a locked folder: the debt stays (the row
    /// keeps `stripping`) and a later round resumes it. `silent`: nothing changed since the last
    /// try that came to nothing, so there are no events and no new red task.
    Waiting {
        silent: bool,
        /// Letters that lost the label before the walk stopped.
        count: usize,
        done: u64,
        total: u64,
    },
}

/// The label to take off: the mailbox, its name in the list and the keyword on the letters.
pub struct LabelKey<'a> {
    pub account_id: &'a str,
    pub name: &'a str,
    pub keyword: &'a str,
}

/// Takes the keyword off every selectable folder of the mailbox, one work per folder.
/// `progress(done, total)` is told at the start and after each folder, unless the try repeats
/// one that came to nothing (the tasks window is left as it was). `queue`: the mailbox's, none
/// when it is not running (a mailbox gone mid-walk is a retry too). `now` is the caller's clock,
/// read once the walk is over: a stall is stamped when the try ended, not when it began.
pub async fn strip<Q: MailQueue>(
    store: &Store,
    stripping: &Stripping,
    mut queue: Option<&mut Q>,
    label: LabelKey<'_>,
    now: &(dyn Fn() -> i64 + Sync),
    progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<Ended> {
    let LabelKey {
        account_id,
        name,
        keyword,
    } = label;
    let folders: Vec<String> = store
        .folders(Some(account_id))
        .unwrap_or_default()
        .into_iter()
        .filter(|f| f.folder.selectable)
        .map(|f| f.folder.name)
        .collect();
    let total = folders.len() as u64;
    let key = (account_id.to_owned(), name.to_owned());
    // A repeat of a try that came to nothing leaves the tasks window as it was.
    let quiet = lock(&stripping.stalled).contains_key(&key);
    if !quiet {
        progress(0, total);
    }
    let mut count = 0usize;
    let mut retry = false;
    let mut skipped: Vec<(String, crate::Error)> = Vec::new();
    let mut done = 0u64;
    for folder in &folders {
        let Some(queue) = queue.as_deref_mut() else {
            retry = true;
            break;
        };
        match queue.strip_label(folder, keyword).await {
            Ok(n) => count += n,
            // A pause, an offline mailbox, a busy server, a locked folder: try again later,
            // and keep the debt so the label is not removed with its keyword still on.
            Err(e) if e.retry_later() => retry = true,
            // No rights or a refusal: skip the folder and remember it; the rest is cleaned.
            Err(e) => skipped.push((folder.clone(), e)),
        }
        done += 1;
        if !quiet {
            progress(done, total);
        }
    }
    if !retry {
        lock(&stripping.stalled).remove(&key);
        // The server is done with it: the cache follows and the label leaves the list.
        let not_cleaned = [
            store.drop_keyword(account_id, keyword).err(),
            store.remove_label(account_id, name).err(),
        ]
        .into_iter()
        .flatten()
        .collect();
        return Ok(Ended::Finished {
            count,
            skipped,
            not_cleaned,
        });
    }
    let silent = {
        let mut stalled = lock(&stripping.stalled);
        if count == 0 {
            stalled.insert(key, now()).is_some()
        } else {
            stalled.remove(&key);
            false
        }
    };
    Ok(Ended::Waiting {
        silent,
        count,
        done,
        total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Error;
    use crate::acl::{Label, keyword_of};
    use crate::domain::Folder;
    use crate::port::fake::Queue;

    fn folder(name: &str, selectable: bool) -> Folder {
        Folder {
            name: name.into(),
            display_name: name.into(),
            delimiter: Some("/".into()),
            role: None,
            selectable,
            hidden: false,
        }
    }

    /// A mailbox with a label being removed and three folders, one that cannot hold letters.
    fn store() -> Store {
        let store = Store::open_in_memory().unwrap();
        store
            .replace_folders(
                "a",
                &[folder("INBOX", true), folder("[Gmail]", false), folder("Work", true)],
            )
            .unwrap();
        let label = Label {
            name: "Счета".into(),
            keyword: keyword_of("Счета"),
            color: "#d0573f".into(),
            stripping: false,
        };
        store.save_label("a", &label).unwrap();
        store.set_label_stripping("a", "Счета", true).unwrap();
        store
    }

    async fn walk(
        store: &Store,
        stripping: &Stripping,
        queue: Option<&mut Queue>,
        now: i64,
    ) -> (Ended, Vec<(u64, u64)>) {
        let mut seen = Vec::new();
        let ended = strip(
            store,
            stripping,
            queue,
            LabelKey {
                account_id: "a",
                name: "Счета",
                keyword: &keyword_of("Счета"),
            },
            &|| now,
            &mut |d, t| seen.push((d, t)),
        )
        .await
        .unwrap();
        (ended, seen)
    }

    #[test]
    fn an_offline_mailbox_is_not_resumed_and_a_stalled_try_waits() {
        let now = 1_000;
        assert!(!resume_due(false, None, now), "offline: nothing to knock on");
        assert!(resume_due(true, None, now), "back online: the debt is resumed");
        assert!(!resume_due(true, Some(now), now + RETRY_AFTER_SECS / 2), "just tried");
        assert!(resume_due(true, Some(now), now + RETRY_AFTER_SECS));
        // The clock was set back since the try: the wait for it would be for ever.
        assert!(resume_due(true, Some(1_000), 500));
    }

    #[tokio::test]
    async fn every_folder_that_can_hold_letters_is_cleaned_and_the_label_leaves_the_list() {
        let store = store();
        let stripping = Stripping::default();
        let mut queue = Queue {
            stripped: [Ok(3), Ok(2)].into(),
            ..Default::default()
        };
        let (ended, seen) = walk(&store, &stripping, Some(&mut queue), 100).await;
        assert!(
            matches!(&ended, Ended::Finished { skipped, not_cleaned, count: 5 } if skipped.is_empty() && not_cleaned.is_empty())
        );
        let kw = keyword_of("Счета");
        assert_eq!(
            *queue.log.lock().unwrap(),
            [format!("strip INBOX {kw}"), format!("strip Work {kw}")],
            "a folder that cannot hold letters is not asked"
        );
        assert_eq!(seen, [(0, 2), (1, 2), (2, 2)]);
        assert!(store.labels("a").unwrap().is_empty(), "the label has left the list");
    }

    #[tokio::test]
    async fn a_folder_that_refuses_is_named_and_the_rest_is_cleaned_all_the_same() {
        let store = store();
        let stripping = Stripping::default();
        let mut queue = Queue {
            stripped: [Err(Error::Protocol("the folder is read-only".into())), Ok(4)].into(),
            ..Default::default()
        };
        let (ended, _) = walk(&store, &stripping, Some(&mut queue), 100).await;
        let Ended::Finished { skipped, .. } = ended else {
            panic!("{ended:?}");
        };
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].0, "INBOX");
        assert!(matches!(&skipped[0].1, Error::Protocol(_)), "{skipped:?}");
        assert!(
            store.labels("a").unwrap().is_empty(),
            "what refused is told, the label still goes"
        );
    }

    #[tokio::test]
    async fn a_pause_keeps_the_debt_and_a_repeat_that_changes_nothing_is_silent() {
        let store = store();
        let stripping = Stripping::default();
        let mut queue = Queue {
            stripped: [
                Err(Error::Paused),
                Err(Error::Paused),
                Err(Error::Paused),
                Err(Error::Paused),
            ]
            .into(),
            ..Default::default()
        };
        let (ended, seen) = walk(&store, &stripping, Some(&mut queue), 100).await;
        assert!(
            matches!(
                ended,
                Ended::Waiting {
                    silent: false,
                    count: 0,
                    done: 2,
                    total: 2
                }
            ),
            "{ended:?}"
        );
        assert_eq!(seen, [(0, 2), (1, 2), (2, 2)]);
        assert_eq!(store.stripping_labels("a").unwrap().len(), 1, "the debt stays");
        // The same try again: nothing changed, no events, and the tasks window is not touched.
        let (ended, seen) = walk(&store, &stripping, Some(&mut queue), 300).await;
        assert!(matches!(ended, Ended::Waiting { silent: true, .. }), "{ended:?}");
        assert!(seen.is_empty());
        // It is picked up again only two minutes after the last try that came to nothing.
        let due = |now| resumable(&store, &stripping, "a", true, now).unwrap().len();
        assert_eq!(
            (due(300), due(300 + RETRY_AFTER_SECS - 1), due(300 + RETRY_AFTER_SECS)),
            (0, 0, 1)
        );
        assert_eq!(
            resumable(&store, &stripping, "a", false, 10_000).unwrap().len(),
            0,
            "offline"
        );
    }

    #[tokio::test]
    async fn a_walk_that_got_somewhere_before_it_stopped_is_told_and_forgets_the_stall() {
        let store = store();
        let stripping = Stripping::default();
        let mut stuck = Queue {
            stripped: [Err(Error::Paused), Err(Error::Paused)].into(),
            ..Default::default()
        };
        walk(&store, &stripping, Some(&mut stuck), 100).await;
        // This time the first folder is cleaned, and the second is busy.
        let mut queue = Queue {
            stripped: [Ok(5), Err(Error::Paused)].into(),
            ..Default::default()
        };
        let (ended, _) = walk(&store, &stripping, Some(&mut queue), 200).await;
        assert!(
            matches!(
                ended,
                Ended::Waiting {
                    silent: false,
                    count: 5,
                    done: 2,
                    total: 2
                }
            ),
            "{ended:?}"
        );
        assert_eq!(
            store.stripping_labels("a").unwrap().len(),
            1,
            "the label is not removed with its keyword on"
        );
        // Progress was made: the next round is not held back by the stall.
        assert_eq!(resumable(&store, &stripping, "a", true, 201).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_mailbox_that_is_not_running_is_a_retry_and_a_strip_is_not_started_twice() {
        let store = store();
        let stripping = Arc::new(Stripping::default());
        let (ended, _) = walk(&store, &stripping, None, 100).await;
        assert!(
            matches!(
                ended,
                Ended::Waiting {
                    silent: false,
                    count: 0,
                    ..
                }
            ),
            "{ended:?}"
        );
        assert_eq!(store.stripping_labels("a").unwrap().len(), 1);
        let first = stripping.claim("a", "Счета", 0);
        assert!(first.is_some());
        assert!(stripping.claim("a", "Счета", 0).is_none(), "running already");
        assert!(
            stripping.claim("a", "Другая", 0).is_some(),
            "another label is its own strip"
        );
        drop(first);
        assert!(stripping.claim("a", "Счета", 0).is_some(), "over: it may start again");
    }

    #[tokio::test]
    async fn the_stall_is_stamped_when_the_walk_ends_not_when_it_began() {
        let store = store();
        let stripping = Stripping::default();
        // The walk takes a long time: the clock moves with every folder.
        let clock = std::sync::atomic::AtomicI64::new(100);
        let mut queue = Queue {
            stripped: [Err(Error::Paused), Err(Error::Paused)].into(),
            ..Default::default()
        };
        strip(
            &store,
            &stripping,
            Some(&mut queue),
            LabelKey {
                account_id: "a",
                name: "Счета",
                keyword: &keyword_of("Счета"),
            },
            &|| clock.load(std::sync::atomic::Ordering::SeqCst),
            &mut |_, _| {
                clock.fetch_add(500, std::sync::atomic::Ordering::SeqCst);
            },
        )
        .await
        .unwrap();
        let ended_at = clock.load(std::sync::atomic::Ordering::SeqCst);
        assert!(ended_at > 1_000);
        // Two minutes from its end, not from its beginning.
        let due = |now| resumable(&store, &stripping, "a", true, now).unwrap().len();
        assert_eq!(
            (due(ended_at + RETRY_AFTER_SECS - 1), due(ended_at + RETRY_AFTER_SECS)),
            (0, 1)
        );
    }

    #[tokio::test]
    async fn the_cache_steps_that_failed_are_told_and_the_walk_is_still_finished() {
        let store = store();
        let stripping = Stripping::default();
        store.break_for_test("DROP TABLE labels");
        let mut queue = Queue {
            stripped: [Ok(1), Ok(1)].into(),
            ..Default::default()
        };
        let (ended, _) = walk(&store, &stripping, Some(&mut queue), 100).await;
        let Ended::Finished {
            not_cleaned, count: 2, ..
        } = ended
        else {
            panic!("{ended:?}");
        };
        assert_eq!(not_cleaned.len(), 1, "the label could not leave the list");
    }

    #[tokio::test]
    async fn a_quiet_repeat_that_then_gets_through_forgets_the_stall() {
        let store = store();
        let stripping = Stripping::default();
        let mut paused = Queue {
            stripped: [
                Err(Error::Paused),
                Err(Error::Paused),
                Err(Error::Paused),
                Err(Error::Paused),
            ]
            .into(),
            ..Default::default()
        };
        walk(&store, &stripping, Some(&mut paused), 100).await;
        let (quiet, seen) = walk(&store, &stripping, Some(&mut paused), 300).await;
        assert!(matches!(quiet, Ended::Waiting { silent: true, .. }) && seen.is_empty());
        assert!(lock(&stripping.stalled).len() == 1);
        // This time the server answers: done, and nothing of the stall is left.
        let mut fine = Queue {
            stripped: [Ok(1), Ok(1)].into(),
            ..Default::default()
        };
        let (done, seen) = walk(&store, &stripping, Some(&mut fine), 500).await;
        assert!(matches!(done, Ended::Finished { .. }));
        assert!(seen.is_empty(), "still quiet: the tasks window was left as it was");
        assert!(lock(&stripping.stalled).is_empty());
    }

    #[tokio::test]
    async fn a_strip_whose_future_is_dropped_is_not_left_running() {
        let stripping = Arc::new(Stripping::default());
        let held = stripping.clone();
        let timed_out = tokio::time::timeout(std::time::Duration::from_millis(20), async move {
            let _running = held.claim("a", "Счета", 0).unwrap();
            std::future::pending::<()>().await;
        })
        .await;
        assert!(timed_out.is_err(), "the task never ended by itself");
        assert!(
            stripping.claim("a", "Счета", 0).is_some(),
            "cancelled: it may start again"
        );
    }

    #[test]
    fn a_strip_that_panics_is_not_started_again_at_once() {
        let store = store();
        let stripping = Arc::new(Stripping::default());
        let held = stripping.clone();
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _running = held.claim("a", "Счета", 1_000).unwrap();
            panic!("the walk fell over");
        }));
        assert!(panicked.is_err());
        // It is free to start, but not before the stall is out: no loop of panics.
        let due = |now| resumable(&store, &stripping, "a", true, now).unwrap().len();
        assert_eq!((due(1_000), due(1_000 + RETRY_AFTER_SECS)), (0, 1));
        assert!(stripping.claim("a", "Счета", 2_000).is_some());
    }

    #[tokio::test]
    async fn a_refusal_for_lack_of_rights_is_a_skipped_folder_not_a_retry() {
        let store = store();
        let stripping = Stripping::default();
        let noperm = Error::Imap(async_imap::error::Error::No(
            "code: Some(NOPERM), info: Some(\"the folder is read-only\")".into(),
        ));
        assert!(!noperm.retry_later());
        let mut queue = Queue {
            stripped: [Err(noperm), Ok(1)].into(),
            ..Default::default()
        };
        let (ended, _) = walk(&store, &stripping, Some(&mut queue), 100).await;
        assert!(
            matches!(&ended, Ended::Finished { skipped, .. } if skipped.len() == 1),
            "{ended:?}"
        );
    }
}
