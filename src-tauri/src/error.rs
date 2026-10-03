use depesha_core::tls::CertProblem;
use serde::Serialize;

/// Error as the GUI sees it: a kind to branch on, a Russian message to show,
/// and certificate details when the user may decide to trust it.
#[derive(Debug, Clone, Serialize)]
pub struct CmdError {
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cert: Option<Box<CertProblem>>,
}

impl CmdError {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
            cert: None,
        }
    }
}

impl From<depesha_core::Error> for CmdError {
    fn from(err: depesha_core::Error) -> Self {
        let cert = match &err {
            depesha_core::Error::Certificate(p) => Some(p.clone()),
            _ => None,
        };
        Self {
            kind: err.kind().into(),
            message: err.to_string(),
            cert,
        }
    }
}

impl From<std::io::Error> for CmdError {
    fn from(err: std::io::Error) -> Self {
        Self::new("io", format!("файл: {err}"))
    }
}

pub type CmdResult<T> = Result<T, CmdError>;
