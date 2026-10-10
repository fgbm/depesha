//! Core of the Depesha mail client: IMAP sync, SMTP sending, the local cache
//! and message parsing. It knows nothing about the GUI.

pub mod account;
pub mod acl;
pub mod autodetect;
pub mod avatar;
mod blocking;
pub mod clear;
pub mod domain;
pub(crate) mod error;
pub mod ews;
pub(crate) mod http;
pub mod idle_pace;
pub mod imap;
pub mod label_strip;
pub mod lang;
pub mod mail;
pub mod message;
pub(crate) mod net;
pub mod ntlm;
pub mod oauth;
pub mod outbox;
pub mod port;
pub mod query;
pub mod quota;
pub mod smtp;
pub mod snooze;
pub mod store;
pub mod sync;
pub mod tls;
pub mod unsubscribe;
pub mod utf7;
pub mod waiting;
pub(crate) mod watchdog;

pub use error::{Error, ErrorKind, Result};
