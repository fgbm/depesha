//! Core of the Depesha mail client: IMAP sync, SMTP sending, the local cache
//! and message parsing. It knows nothing about the GUI.

pub mod account;
pub mod acl;
pub mod autodetect;
pub mod avatar;
pub mod clear;
pub mod domain;
pub(crate) mod error;
pub mod ews;
pub(crate) mod http;
pub mod imap;
pub mod lang;
pub mod mail;
pub mod message;
pub(crate) mod net;
pub mod ntlm;
pub mod oauth;
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
pub(crate) mod watchdog;

pub use error::{Error, Result};
