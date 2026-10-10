//! The failures the core words itself, as codes: each has its parameters and an English
//! text for the log. The words the user reads are made from them at the edge of the program.

use crate::account::OAuthProvider;

/// Which of the old kinds of error a phrase of ours stands in for: it decides how the error is
/// told apart (`kind`, `is_transient`, `retry_later`) and what wraps the phrase when it is shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    /// The login or the sign-in did not go through.
    Auth,
    /// The other side answered something we cannot use.
    Protocol,
    /// The message could not be built.
    Compose,
    /// Trouble that passes: worth another try.
    Transient,
}

/// Why an XOAUTH2 login was refused, from the JSON the server sends back with the refusal.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Xoauth2Detail {
    #[error("the sign-in does not allow mail access: sign in again and allow access to mail ({0})")]
    NoMailAccess(String),
    #[error("the sign-in has expired: sign in again ({0})")]
    Expired(String),
    #[error("{0}")]
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Say {
    #[error("the Exchange server is temporarily unavailable (HTTP {status})")]
    EwsUnavailable { status: u16 },
    #[error("EWS answered HTTP {status}; check the server address")]
    EwsHttp { status: u16 },
    #[error("wrong user name or password, or the server takes Kerberos only (the login is often DOMAIN\\user)")]
    EwsKerberos,
    #[error("wrong user name or password (on Exchange the login is often DOMAIN\\user)")]
    EwsWrongLogin,
    #[error("empty answer from EWS")]
    EwsEmptyAnswer,
    #[error("the mailbox has no folder root")]
    EwsNoFolderRoot,
    #[error("the server could not search for non-Latin text (no CHARSET UTF-8 support): {info}")]
    SearchCharset { info: String },
    #[error("the sender gave no way to unsubscribe that is safe to use")]
    UnsubscribeNoSafeWay,
    #[error("one-click unsubscribe works only over https")]
    UnsubscribeHttpsOnly,
    #[error("unexpected answer from the list server: {line}")]
    ListUnexpected { line: String },
    #[error("the list server refused to unsubscribe: HTTP {status}")]
    ListRefused { status: u16 },
    #[error("the unsubscribe address is not a single valid address: {url}")]
    UnsubscribeBadAddress { url: String },
    #[error("the unsubscribe letter's subject or text has control characters")]
    UnsubscribeControlChars,
    #[error("answer too large: {why}")]
    AnswerTooLarge { why: String },
    #[error("invalid address: {email}")]
    InvalidAddress { email: String },
    #[error("no sender")]
    NoSender,
    #[error("no recipients")]
    NoRecipients,
    #[error("ports {first}–{last} for the sign-in answer are busy: {why}")]
    SignInPortsBusy { first: u16, last: u16, why: String },
    #[error("the browser did not come back in ten minutes")]
    SignInTimeout,
    #[error("sign-in cancelled")]
    SignInCancelled,
    #[error("sign-in with {} is not set up in this build: add your OAuth client in Preferences", .provider.title())]
    OauthNotConfigured { provider: OAuthProvider },
    #[error("the provider refused: access was not granted")]
    ProviderDenied,
    #[error("the provider refused: {text}")]
    ProviderRefused { text: String },
    #[error("token endpoint answered {status}: {body}")]
    TokenEndpoint { status: u16, body: String },
    #[error("{} no longer accepts the saved sign-in, sign in again ({detail})", .provider.title())]
    OauthInvalidGrant { provider: OAuthProvider, detail: String },
    #[error("{} does not know this app's OAuth client: {detail}", .provider.title())]
    OauthInvalidClient { provider: OAuthProvider, detail: String },
    #[error("no access token in the answer")]
    OauthNoToken,
    #[error("{} gave no refresh token; remove the app's access in the account settings and sign in again", .provider.title())]
    OauthNoRefresh { provider: OAuthProvider },
    #[error("{} did not grant access to mail: sign in again and tick mail access on the permissions page", .provider.title())]
    OauthNoMailAccess { provider: OAuthProvider },
    #[error("{} did not tell the address", .provider.title())]
    OauthNoAddress { provider: OAuthProvider },
    #[error("the account is not running")]
    AccountNotRunning,
    /// A refusal of the login with what the server added to it.
    #[error("{message} ({detail})")]
    AuthDetail { message: String, detail: Xoauth2Detail },
}

impl Say {
    pub fn class(&self) -> Class {
        use Say::*;
        match self {
            EwsUnavailable { .. } | AccountNotRunning => Class::Transient,
            EwsKerberos
            | EwsWrongLogin
            | SignInTimeout
            | SignInCancelled
            | OauthNotConfigured { .. }
            | ProviderDenied
            | ProviderRefused { .. }
            | OauthInvalidGrant { .. }
            | OauthInvalidClient { .. }
            | OauthNoRefresh { .. }
            | OauthNoMailAccess { .. }
            | AuthDetail { .. } => Class::Auth,
            UnsubscribeBadAddress { .. }
            | UnsubscribeControlChars
            | InvalidAddress { .. }
            | NoSender
            | NoRecipients => Class::Compose,
            EwsHttp { .. }
            | EwsEmptyAnswer
            | EwsNoFolderRoot
            | SearchCharset { .. }
            | UnsubscribeNoSafeWay
            | UnsubscribeHttpsOnly
            | ListUnexpected { .. }
            | ListRefused { .. }
            | AnswerTooLarge { .. }
            | SignInPortsBusy { .. }
            | TokenEndpoint { .. }
            | OauthNoToken
            | OauthNoAddress { .. } => Class::Protocol,
        }
    }

    /// The English words, in the frame the old kind of error put around them.
    pub fn english(&self) -> String {
        let body = self.to_string();
        match self.class() {
            Class::Auth => format!("the server rejected the login: {body}"),
            Class::Protocol => format!("unexpected answer from the server: {body}"),
            Class::Compose => format!("the message could not be built: {body}"),
            Class::Transient => format!("network: {body}"),
        }
    }
}
