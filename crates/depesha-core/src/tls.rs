use std::fmt::Write as _;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use tokio_rustls::rustls::{self, CertificateError, ClientConfig, DigitallySignedStruct, SignatureScheme};

use crate::{Error, Result};

/// The reasons a certificate is rejected that the program words itself.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum CertWhy {
    Expired,
    NotYetValid,
    UnknownIssuer,
    WrongName,
    Revoked,
    Failed,
    /// Anything else: the verifier's own words stay in `reason`.
    #[default]
    Other,
}

impl CertWhy {
    pub fn english(self) -> &'static str {
        match self {
            Self::Expired => "the certificate has expired",
            Self::NotYetValid => "the certificate is not valid yet (check the computer's clock)",
            Self::UnknownIssuer => "issued by an unknown authority: self-signed or an internal certificate authority",
            Self::WrongName => "issued for a different server name",
            Self::Revoked => "the certificate is revoked",
            Self::Failed => "the certificate failed verification",
            Self::Other => "",
        }
    }
}

/// Why the server certificate was rejected, with what the user needs to
/// decide whether to trust it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct CertProblem {
    pub host: String,
    /// Why, in English; the words the user reads are made from `why` (or this, for `Other`).
    pub reason: String,
    #[serde(default)]
    pub why: CertWhy,
    /// SHA-256 of the DER certificate, lowercase hex; this is what gets pinned.
    pub sha256: String,
    pub subject: String,
    pub issuer: String,
    pub not_after: Option<i64>,
}

fn platform_verifier() -> Result<Arc<dyn ServerCertVerifier>> {
    static VERIFIER: OnceLock<Arc<dyn ServerCertVerifier>> = OnceLock::new();
    if let Some(v) = VERIFIER.get() {
        return Ok(v.clone());
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let v: Arc<dyn ServerCertVerifier> = Arc::new(rustls_platform_verifier::Verifier::new(provider)?);
    Ok(VERIFIER.get_or_init(|| v).clone())
}

/// System trust store first; a certificate the user explicitly trusted
/// for this server is accepted by its exact SHA-256.
#[derive(Debug)]
struct Verifier {
    inner: Arc<dyn ServerCertVerifier>,
    pinned: Option<String>,
    problem: Arc<Mutex<Option<CertProblem>>>,
    host: String,
}

impl ServerCertVerifier for Verifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fingerprint = sha256_hex(end_entity);
        if self
            .pinned
            .as_deref()
            .is_some_and(|p| p.eq_ignore_ascii_case(&fingerprint))
        {
            return Ok(ServerCertVerified::assertion());
        }
        self.inner
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
            .inspect_err(|err| {
                let problem = describe(&self.host, end_entity, fingerprint, err);
                *self.problem.lock().unwrap_or_else(|e| e.into_inner()) = Some(problem);
            })
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

fn describe(host: &str, cert: &CertificateDer<'_>, sha256: String, err: &rustls::Error) -> CertProblem {
    let (why, reason) = match err {
        rustls::Error::InvalidCertificate(e) => {
            let why = match e {
                CertificateError::Expired | CertificateError::ExpiredContext { .. } => CertWhy::Expired,
                CertificateError::NotValidYet | CertificateError::NotValidYetContext { .. } => CertWhy::NotYetValid,
                CertificateError::UnknownIssuer => CertWhy::UnknownIssuer,
                CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. } => {
                    CertWhy::WrongName
                }
                CertificateError::Revoked => CertWhy::Revoked,
                _ => CertWhy::Failed,
            };
            (why, why.english().to_owned())
        }
        other => (CertWhy::Other, other.to_string()),
    };
    let (subject, issuer, not_after) = match x509_parser::parse_x509_certificate(cert) {
        Ok((_, c)) => (
            c.subject().to_string(),
            c.issuer().to_string(),
            Some(c.validity().not_after.timestamp()),
        ),
        Err(_) => (String::new(), String::new(), None),
    };
    CertProblem {
        host: host.to_owned(),
        reason,
        why,
        sha256,
        subject,
        issuer,
        not_after,
    }
}

pub(crate) fn sha256_hex(der: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, der);
    digest.as_ref().iter().fold(String::with_capacity(64), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

pub(crate) async fn wrap<S>(host: &str, pinned: Option<&str>, tcp: S) -> Result<TlsStream<S>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let name = ServerName::try_from(host.to_owned()).map_err(|_| Error::InvalidHost(host.into()))?;
    let problem = Arc::new(Mutex::new(None));
    let verifier = Verifier {
        inner: platform_verifier()?,
        pinned: pinned.map(str::to_owned),
        problem: problem.clone(),
        host: host.to_owned(),
    };
    let config = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    match TlsConnector::from(Arc::new(config)).connect(name, tcp).await {
        Ok(stream) => Ok(stream),
        Err(err) => match problem.lock().unwrap_or_else(|e| e.into_inner()).take() {
            Some(p) => Err(Error::Certificate(Box::new(p))),
            None => Err(err.into()),
        },
    }
}
