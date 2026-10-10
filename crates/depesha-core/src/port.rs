//! The mail server as the scenarios see it. A port is introduced where a scenario's rules
//! cannot be tested without a server: for now «Clear» (`clear`), the operations it needs and
//! no others. IMAP and Exchange implement it in `mail`; the tests of the rules, a fake. The
//! rules know no protocol: what a count names (`Count`) and how a message is named (`Item`)
//! are the implementation's own.

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
