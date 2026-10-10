//! The mail server as the scenarios see it. A port is introduced where a scenario's rules
//! cannot be tested without a server: for now «Clear» (`clear`), the operations it needs and
//! no others. IMAP and Exchange implement it in `mail`; the tests of the rules, a fake.

use std::future::Future;

use crate::Result;

/// What a «Clear» may touch: the folder as it was when the dialog counted it. What arrives
/// afterwards is not in it and is never wiped, and a run repeated from the same bound goes on
/// with what is left of it (#74).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Bound {
    /// IMAP: the messages of this UIDVALIDITY with a UID below `next` (the UIDNEXT then).
    Imap { validity: u32, next: u32 },
    /// Exchange: the items the folder held then.
    Items(Vec<String>),
}

pub trait MailServer: Send {
    /// How the server names one message: a UID on IMAP, an item id on Exchange.
    type Item: Send + Sync;

    /// How many messages the folder holds on the server and the bound that counted them.
    fn count(&mut self, folder: &str) -> impl Future<Output = Result<(usize, Bound)>> + Send;

    /// The messages of the folder that `bound` names, but those of the cached UIDs `keep`.
    /// The folder renumbered since the bound is `Error::FolderChanged`.
    fn counted(
        &mut self,
        folder: &str,
        bound: &Bound,
        keep: &[u32],
    ) -> impl Future<Output = Result<Vec<Self::Item>>> + Send;

    /// Wipes the messages for good.
    fn erase(&mut self, folder: &str, items: &[Self::Item]) -> impl Future<Output = Result<()>> + Send;

    /// Moves the messages into the folder `to`.
    fn move_to(&mut self, folder: &str, items: &[Self::Item], to: &str) -> impl Future<Output = Result<()>> + Send;

    /// How many messages the server takes in one request.
    fn batch(&self) -> usize;
}
