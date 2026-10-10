use crate::tr;
use depesha_core::ErrorKind;
use depesha_core::tls::CertProblem;
use serde::Serialize;

/// Error as the GUI sees it: a kind to branch on, a Russian message to show,
/// and certificate details when the user may decide to trust it.
#[derive(Debug, Clone, Serialize)]
pub struct CmdError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cert: Option<Box<CertProblem>>,
}

impl CmdError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            cert: None,
        }
    }
}

/// The words the user sees: what a rule of the core logs or stores of a failure it was handed.
impl std::fmt::Display for CmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<depesha_core::Error> for CmdError {
    fn from(err: depesha_core::Error) -> Self {
        let lang = crate::lang::current();
        let cert = match &err {
            depesha_core::Error::Certificate(p) => Some(Box::new(crate::localize::cert_view(p, lang))),
            _ => None,
        };
        Self {
            kind: err.kind(),
            message: crate::localize::error(&err, lang),
            cert,
        }
    }
}

impl From<std::io::Error> for CmdError {
    fn from(err: std::io::Error) -> Self {
        Self::new(ErrorKind::Io, tr!("file: {err}", "файл: {err}"))
    }
}

pub type CmdResult<T> = Result<T, CmdError>;
