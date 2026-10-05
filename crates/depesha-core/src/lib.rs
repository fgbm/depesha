//! Core of the Depesha mail client: IMAP sync, SMTP sending, the local cache
//! and message parsing. It knows nothing about the GUI.

pub mod account;
pub mod autodetect;
pub mod avatar;
pub mod error;
pub mod ews;
pub mod http;
pub mod imap;
pub mod lang;
pub mod mail;
pub mod message;
pub mod ntlm;
pub mod oauth;
pub mod query;
pub mod smtp;
pub mod store;
pub mod sync;
pub mod tls;
pub mod unsubscribe;
pub mod utf7;
pub mod watchdog;

pub use error::{Error, Result};
