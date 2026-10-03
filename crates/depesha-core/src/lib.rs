//! Core of the Depesha mail client: IMAP sync, SMTP sending, the local cache
//! and message parsing. It knows nothing about the GUI.

pub mod account;
pub mod autodetect;
pub mod error;
pub mod imap;
pub mod message;
pub mod smtp;
pub mod store;
pub mod sync;
pub mod tls;
pub mod utf7;

pub use error::{Error, Result};
