//! The mail server as the scenarios see it. A port is introduced where a scenario's rules
//! cannot be tested without a server: for now «Clear» (`clear`), the operations it needs and
//! no others. IMAP and Exchange implement it in `mail`; the tests of the rules, a fake. The
//! rules know no protocol: what a count names (`Count`) and how a message is named (`Item`)
//! are the implementation's own. `clear::Bounds<B>` is generic only so the core need not name
//! the app's `mail::Bound`, the sum of the two kinds that the app holds (it learns the kind from
//! the connection); beyond that, the tests with their own fake bound are its only other user.

use std::future::Future;

use crate::Result;
use crate::store::Store;

/// What a count of a folder named, as a dialog took it: the messages the folder held then.
/// What arrives afterwards is not in it, and a run repeated from the same count goes on with
/// what is left of it (#74).
pub trait Count: Clone + Send + Sync {
    /// A test of the cache's UIDs (the numbers the cache gives the messages): is that message
    /// one the count named? When the cache cannot say, nothing is inside.
    fn covers<'a>(&'a self, store: &Store, account_id: &str, folder: &str) -> Box<dyn Fn(u32) -> bool + Send + 'a>;
}

pub trait MailServer: Send {
    /// How the server names one message.
    type Item: Send + Sync;
    /// What a count of a folder named.
    type Bound: Count;

    /// How many messages the folder holds on the server and the count that named them.
    fn count(&mut self, folder: &str) -> impl Future<Output = Result<(usize, Self::Bound)>> + Send;

    /// The server's names of the messages the cache knows by `cached` UIDs.
    fn items_of(&mut self, folder: &str, cached: &[u32]) -> impl Future<Output = Result<Vec<Self::Item>>> + Send;

    /// The messages of the folder that `bound` names, but `keep`. The folder renumbered since
    /// the count is `Error::FolderChanged`.
    fn counted(
        &mut self,
        folder: &str,
        bound: &Self::Bound,
        keep: &[Self::Item],
    ) -> impl Future<Output = Result<Vec<Self::Item>>> + Send;

    /// Wipes the messages for good.
    fn erase(&mut self, folder: &str, items: &[Self::Item]) -> impl Future<Output = Result<()>> + Send;

    /// Moves the messages into the folder `to`.
    fn move_to(&mut self, folder: &str, items: &[Self::Item], to: &str) -> impl Future<Output = Result<()>> + Send;

    /// How many messages the server takes in one request.
    fn batch(&self) -> usize;
}

/// Letters moved by Message-ID: UIDs change on every move, so what is to be found again after
/// a move (an undo, snoozed mail coming back, a wait) cannot rely on them. `unseen` marks the
/// letters unread in the folder they arrive in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Move {
    pub from: String,
    pub message_ids: Vec<String>,
    pub to: String,
    pub unseen: bool,
}

/// The mailbox's queue, as the scenarios that ask the server for work nobody waits on with
/// their hand on the keyboard see it (snoozed mail coming back, waits for an answer). The app
/// runs the work behind the user's own actions; the tests of the rules, a fake.
pub trait MailQueue: Send {
    /// Moves the letters; how many were found and moved (none: they are elsewhere already).
    fn move_by_message_id(&mut self, moves: Move) -> impl Future<Output = Result<usize>> + Send;

    /// Makes a folder.
    fn create_folder(&mut self, name: &str) -> impl Future<Output = Result<()>> + Send;

    /// Changes a flag by the UIDs of `folder` read under `validity`.
    fn set_flag(
        &mut self,
        folder: &str,
        validity: u32,
        uids: &[u32],
        change: crate::domain::FlagChange,
    ) -> impl Future<Output = Result<()>> + Send;
}

/// A queue for the tests of the rules: it records what it is asked and answers from a script.
#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use std::collections::VecDeque;

    #[derive(Default)]
    pub(crate) struct Queue {
        /// What it was asked, in order: `move …`, `create …`, `flag …`.
        pub log: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        pub moves: Vec<Move>,
        /// The answers of `move_by_message_id`, in order; `Ok(1)` once they run out.
        pub moved: VecDeque<Result<usize>>,
        /// The answers of `create_folder`; `Ok` once they run out.
        pub created: VecDeque<Result<()>>,
        pub flags: Vec<(String, u32, Vec<u32>, crate::domain::FlagChange)>,
    }

    impl MailQueue for Queue {
        async fn move_by_message_id(&mut self, moves: Move) -> Result<usize> {
            self.log
                .lock()
                .unwrap()
                .push(format!("move {}", moves.message_ids.join(",")));
            self.moves.push(moves);
            self.moved.pop_front().unwrap_or(Ok(1))
        }

        async fn create_folder(&mut self, name: &str) -> Result<()> {
            self.log.lock().unwrap().push(format!("create {name}"));
            self.created.pop_front().unwrap_or(Ok(()))
        }

        async fn set_flag(
            &mut self,
            folder: &str,
            validity: u32,
            uids: &[u32],
            change: crate::domain::FlagChange,
        ) -> Result<()> {
            self.log.lock().unwrap().push(format!("flag {folder}"));
            self.flags.push((folder.to_owned(), validity, uids.to_vec(), change));
            Ok(())
        }
    }
}
