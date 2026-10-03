//! OAuth 2.0 sign-in for desktop apps (RFC 8252): the system browser opens the
//! provider's page, the answer comes back to a one-shot HTTP server on the loopback
//! interface, and PKCE (RFC 7636) protects the code. IMAP and SMTP then log in
//! with the access token (SASL XOAUTH2); the refresh token lives in the keyring.

use std::future::Future;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::account::OAuthProvider;
use crate::http;
use crate::lang::pick;
use crate::tr;
use crate::{Error, Result};

/// Fixed so they can be registered: Yandex compares the port of the redirect URI.
pub const PORTS: [u16; 3] = [47851, 47852, 47853];
pub const CALLBACK_PATH: &str = "/oauth/callback";
/// How long the browser page may stay open before the sign-in gives up.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// The app's registration at the provider. Desktop apps cannot keep a secret
/// (RFC 8252, 8.5): Google and Yandex still issue one, PKCE is what protects the code.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OAuthClient {
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
}

impl OAuthClient {
    /// The client built into this copy of the app (environment variables at build time).
    pub fn builtin(provider: OAuthProvider) -> Option<Self> {
        let (id, secret) = match provider {
            OAuthProvider::Google => (
                option_env!("DEPESHA_GOOGLE_CLIENT_ID"),
                option_env!("DEPESHA_GOOGLE_CLIENT_SECRET"),
            ),
            OAuthProvider::Yandex => (
                option_env!("DEPESHA_YANDEX_CLIENT_ID"),
                option_env!("DEPESHA_YANDEX_CLIENT_SECRET"),
            ),
            OAuthProvider::Microsoft => (option_env!("DEPESHA_MICROSOFT_CLIENT_ID"), None),
        };
        let id = id.map(str::trim).filter(|s| !s.is_empty())?;
        Some(Self {
            client_id: id.to_owned(),
            client_secret: secret.map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned),
        })
    }

    pub fn is_set(&self) -> bool {
        !self.client_id.trim().is_empty()
    }
}

struct Endpoints {
    auth: &'static str,
    token: &'static str,
    scope: &'static str,
    /// Host in the redirect URI: Microsoft registers `localhost`, the others take the IP.
    redirect_host: &'static str,
    extra: &'static [(&'static str, &'static str)],
}

fn endpoints(provider: OAuthProvider) -> Endpoints {
    match provider {
        OAuthProvider::Google => Endpoints {
            auth: "https://accounts.google.com/o/oauth2/v2/auth",
            token: "https://oauth2.googleapis.com/token",
            scope: "https://mail.google.com/ openid email profile",
            redirect_host: "127.0.0.1",
            // Without consent on every sign-in Google returns no refresh token the second time.
            extra: &[("access_type", "offline"), ("prompt", "consent")],
        },
        OAuthProvider::Yandex => Endpoints {
            auth: "https://oauth.yandex.ru/authorize",
            token: "https://oauth.yandex.ru/token",
            scope: "mail:imap_full mail:smtp login:email login:info",
            redirect_host: "127.0.0.1",
            extra: &[("force_confirm", "yes")],
        },
        OAuthProvider::Microsoft => Endpoints {
            auth: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            scope: "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send \
                    offline_access openid email profile",
            redirect_host: "localhost",
            extra: &[("prompt", "select_account")],
        },
    }
}

/// Tokens from the provider. `refresh_token` is empty when the provider kept the old one.
#[derive(Clone, Default)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix time when the access token stops working.
    pub expires_at: i64,
}

impl std::fmt::Debug for Tokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tokens").field("expires_at", &self.expires_at).finish_non_exhaustive()
    }
}

/// Result of a sign-in: who signed in, and the tokens.
#[derive(Debug, Clone)]
pub struct Grant {
    pub provider: OAuthProvider,
    pub email: String,
    pub name: Option<String>,
    pub tokens: Tokens,
}

/// PKCE verifier and its S256 challenge.
fn pkce() -> (String, String) {
    let verifier = URL_SAFE_NO_PAD.encode(random_bytes::<32>());
    (verifier.clone(), challenge_of(&verifier))
}

fn challenge_of(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes()))
}

fn random_bytes<const N: usize>() -> [u8; N] {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut bytes = [0u8; N];
    SystemRandom::new().fill(&mut bytes).expect("system RNG");
    bytes
}

async fn bind() -> Result<(TcpListener, u16)> {
    let mut last = None;
    for port in PORTS {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => return Ok((l, port)),
            Err(e) => last = Some(e),
        }
    }
    Err(Error::Protocol(tr!(
        "ports {}–{} for the sign-in answer are busy: {}",
        "порты {}–{} для ответа на вход заняты: {}",
        PORTS[0],
        PORTS[PORTS.len() - 1],
        last.map(|e| e.to_string()).unwrap_or_default()
    )))
}

pub fn authorize_url(
    provider: OAuthProvider,
    client: &OAuthClient,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
    login_hint: Option<&str>,
) -> String {
    let ep = endpoints(provider);
    let mut params = vec![
        ("response_type", "code"),
        ("client_id", client.client_id.as_str()),
        ("redirect_uri", redirect_uri),
        ("scope", ep.scope),
        ("state", state),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
    ];
    params.extend(ep.extra.iter().copied());
    if let Some(hint) = login_hint.filter(|h| !h.trim().is_empty()) {
        params.push(("login_hint", hint.trim()));
    }
    let query = String::from_utf8(http::form(&params)).expect("ASCII");
    format!("{}?{query}", ep.auth)
}

/// Signs in through the system browser. `open` shows the URL to the user; the call
/// ends when the browser comes back, `cancel` completes, or after ten minutes.
pub async fn sign_in(
    provider: OAuthProvider,
    client: &OAuthClient,
    login_hint: Option<&str>,
    open: impl FnOnce(&str) -> Result<()>,
    cancel: impl Future<Output = ()>,
) -> Result<Grant> {
    if !client.is_set() {
        return Err(not_configured(provider));
    }
    let (listener, port) = bind().await?;
    let redirect_uri = format!("http://{}:{port}{CALLBACK_PATH}", endpoints(provider).redirect_host);
    let state = URL_SAFE_NO_PAD.encode(random_bytes::<16>());
    let (verifier, challenge) = pkce();
    open(&authorize_url(provider, client, &redirect_uri, &state, &challenge, login_hint))?;

    let code = tokio::select! {
        r = tokio::time::timeout(SIGN_IN_TIMEOUT, wait_for_code(&listener, &state)) => {
            r.map_err(|_| Error::Auth(pick("the browser did not come back in ten minutes", "браузер не вернулся за десять минут").into()))??
        }
        _ = cancel => return Err(Error::Auth(pick("sign-in cancelled", "вход отменён").into())),
    };
    drop(listener);

    let tokens = exchange(provider, client, &code, &verifier, &redirect_uri).await?;
    let (email, name) = identity(provider, &tokens).await?;
    Ok(Grant {
        provider,
        email,
        name,
        tokens: tokens.tokens,
    })
}

pub fn not_configured(provider: OAuthProvider) -> Error {
    Error::Auth(tr!(
        "sign-in with {} is not set up in this build: add your OAuth client in Preferences",
        "вход через {} не настроен в этой сборке: укажите свой OAuth-клиент в настройках",
        provider.title()
    ))
}

/// Accepts browser requests until one brings the code (or an error) for our state.
async fn wait_for_code(listener: &TcpListener, state: &str) -> Result<String> {
    loop {
        let (mut stream, _) = listener.accept().await?;
        let Ok(Some(target)) = read_target(&mut stream).await else {
            continue;
        };
        if !target.starts_with(CALLBACK_PATH) {
            let _ = respond(&mut stream, "404 Not Found", "").await;
            continue;
        }
        let params = http::query_params(&target);
        let get = |k: &str| params.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        if get("state").as_deref() != Some(state) {
            // Not our request (an old tab, another program): ignore it.
            let _ = respond(&mut stream, "400 Bad Request", pick("Unexpected request.", "Неожиданный запрос.")).await;
            continue;
        }
        if let Some(error) = get("error") {
            let detail = get("error_description").unwrap_or_default();
            let text = if error == "access_denied" {
                pick("access was not granted", "доступ не разрешён").to_owned()
            } else {
                format!("{error} {detail}").trim().to_owned()
            };
            let _ = respond(&mut stream, "200 OK", &page(false, &text)).await;
            return Err(Error::Auth(tr!(
                "the provider refused: {text}",
                "провайдер отказал: {text}"
            )));
        }
        let Some(code) = get("code").filter(|c| !c.is_empty()) else {
            let _ = respond(&mut stream, "400 Bad Request", "").await;
            continue;
        };
        let _ = respond(&mut stream, "200 OK", &page(true, "")).await;
        return Ok(code);
    }
}

/// Request target of `GET /path?query HTTP/1.1`.
async fn read_target(stream: &mut TcpStream) -> std::io::Result<Option<String>> {
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    let read = async {
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 64 * 1024 {
            let n = stream.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        Ok::<_, std::io::Error>(())
    };
    if tokio::time::timeout(Duration::from_secs(10), read).await.is_err() {
        return Ok(None);
    }
    let head = String::from_utf8_lossy(&buf);
    let mut words = head.lines().next().unwrap_or_default().split_whitespace();
    Ok(match (words.next(), words.next()) {
        (Some("GET"), Some(target)) => Some(target.to_owned()),
        _ => None,
    })
}

async fn respond(stream: &mut TcpStream, status: &str, html: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        html.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(html.as_bytes()).await?;
    stream.shutdown().await
}

fn page(ok: bool, detail: &str) -> String {
    let (title, text) = if ok {
        (
            pick("Signed in", "Вход выполнен"),
            pick("You can close this tab and return to Depesha.", "Вкладку можно закрыть и вернуться в Депешу."),
        )
    } else {
        (pick("Sign-in failed", "Вход не выполнен"), detail)
    };
    let escape = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(
        "<!doctype html><meta charset=utf-8><title>{t}</title>\
         <body style=\"font:16px system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 1em\">\
         <h1 style=\"font-size:22px\">{t}</h1><p>{x}</p></body>",
        t = escape(title),
        x = escape(text)
    )
}

#[derive(Deserialize)]
struct TokenAnswer {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<serde_json::Value>,
    id_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

struct Exchanged {
    tokens: Tokens,
    id_token: Option<String>,
}

async fn token_request(provider: OAuthProvider, client: &OAuthClient, params: &[(&str, &str)]) -> Result<Exchanged> {
    let mut params = params.to_vec();
    params.push(("client_id", &client.client_id));
    if let Some(secret) = &client.client_secret {
        params.push(("client_secret", secret));
    }
    let resp = http::request(
        "POST",
        endpoints(provider).token,
        &[
            ("Content-Type", "application/x-www-form-urlencoded".into()),
            ("Accept", "application/json".into()),
        ],
        http::form(&params),
    )
    .await?;
    let answer: TokenAnswer = serde_json::from_slice(&resp.body).map_err(|_| {
        Error::Protocol(tr!(
            "token endpoint answered {}: {}",
            "сервер токенов ответил {}: {}",
            resp.status,
            resp.text().chars().take(300).collect::<String>()
        ))
    })?;
    if let Some(error) = answer.error {
        let detail = answer.error_description.unwrap_or_default();
        return Err(Error::Auth(match error.as_str() {
            // Revoked, expired (Google keeps test-mode tokens for 7 days) or password changed.
            "invalid_grant" => tr!(
                "{} no longer accepts the saved sign-in, sign in again ({detail})",
                "{} больше не принимает сохранённый вход, войдите заново ({detail})",
                provider.title()
            ),
            "invalid_client" | "unauthorized_client" => tr!(
                "{} does not know this app's OAuth client: {detail}",
                "{} не знает OAuth-клиент приложения: {detail}",
                provider.title()
            ),
            _ => format!("{error}: {detail}"),
        }));
    }
    let access_token = answer
        .access_token
        .filter(|t| !t.is_empty())
        .ok_or_else(|| Error::Protocol(tr!("no access token in the answer", "в ответе нет токена доступа")))?;
    let expires_in = match answer.expires_in {
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(3600),
        Some(serde_json::Value::String(s)) => s.parse().unwrap_or(3600),
        _ => 3600,
    };
    Ok(Exchanged {
        tokens: Tokens {
            access_token,
            refresh_token: answer.refresh_token.unwrap_or_default(),
            expires_at: chrono::Utc::now().timestamp() + expires_in,
        },
        id_token: answer.id_token,
    })
}

async fn exchange(
    provider: OAuthProvider,
    client: &OAuthClient,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<Exchanged> {
    let ex = token_request(
        provider,
        client,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect_uri),
        ],
    )
    .await?;
    if ex.tokens.refresh_token.is_empty() {
        return Err(Error::Auth(tr!(
            "{} gave no refresh token; remove the app's access in the account settings and sign in again",
            "{} не выдал токен обновления; отзовите доступ приложения в настройках аккаунта и войдите снова",
            provider.title()
        )));
    }
    Ok(ex)
}

/// A new access token. The returned refresh token is empty unless the provider rotated it.
pub async fn refresh(provider: OAuthProvider, client: &OAuthClient, refresh_token: &str) -> Result<Tokens> {
    if !client.is_set() {
        return Err(not_configured(provider));
    }
    let ex = token_request(
        provider,
        client,
        &[("grant_type", "refresh_token"), ("refresh_token", refresh_token)],
    )
    .await?;
    Ok(ex.tokens)
}

/// The mailbox address and name of whoever signed in.
async fn identity(provider: OAuthProvider, ex: &Exchanged) -> Result<(String, Option<String>)> {
    if provider == OAuthProvider::Yandex {
        let resp = http::request(
            "GET",
            "https://login.yandex.ru/info?format=json",
            &[("Authorization", format!("OAuth {}", ex.tokens.access_token))],
            Vec::new(),
        )
        .await?;
        let v: serde_json::Value = serde_json::from_slice(&resp.body).unwrap_or_default();
        let email = v["default_email"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| v["login"].as_str().map(|l| format!("{l}@yandex.ru")));
        let name = v["real_name"].as_str().or(v["display_name"].as_str()).map(str::to_owned);
        return email
            .map(|e| (e, name.filter(|n| !n.is_empty())))
            .ok_or_else(|| Error::Protocol(tr!("Yandex did not tell the address", "Яндекс не сообщил адрес")));
    }
    let claims = ex.id_token.as_deref().and_then(jwt_claims).unwrap_or_default();
    let email = claims["email"]
        .as_str()
        .or(claims["preferred_username"].as_str())
        .filter(|e| e.contains('@'))
        .map(str::to_owned)
        .ok_or_else(|| {
            Error::Protocol(tr!(
                "{} did not tell the address",
                "{} не сообщил адрес",
                provider.title()
            ))
        })?;
    let name = claims["name"].as_str().filter(|n| !n.is_empty()).map(str::to_owned);
    Ok((email, name))
}

/// Claims of an ID token. It came straight from the token endpoint over TLS,
/// so the signature need not be checked (OpenID Connect Core, 3.1.3.7).
fn jwt_claims(jwt: &str) -> Option<serde_json::Value> {
    let payload = jwt.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc7636() {
        // RFC 7636, appendix B.
        assert_eq!(
            challenge_of("dBjftJeZ4CVP-mJ92K9pX9JpKdNC3zKg3RkZ9Ht_9DM"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let (v, c) = pkce();
        assert_eq!(v.len(), 43);
        assert_eq!(challenge_of(&v), c);
    }

    #[test]
    fn builds_authorize_url() {
        let client = OAuthClient {
            client_id: "id.apps".into(),
            client_secret: None,
        };
        let url = authorize_url(
            OAuthProvider::Google,
            &client,
            "http://127.0.0.1:47851/oauth/callback",
            "st",
            "ch",
            Some("a@gmail.com"),
        );
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=id.apps"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A47851%2Foauth%2Fcallback"));
        assert!(url.contains("scope=https%3A%2F%2Fmail.google.com%2F%20openid"));
        assert!(url.contains("code_challenge=ch&code_challenge_method=S256"));
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("login_hint=a%40gmail.com"));
        let ms = authorize_url(OAuthProvider::Microsoft, &client, "http://localhost:1/oauth/callback", "s", "c", None);
        assert!(ms.contains("IMAP.AccessAsUser.All") && ms.contains("offline_access"));
        assert!(!ms.contains("login_hint"));
    }

    #[test]
    fn reads_id_token_claims() {
        let payload = URL_SAFE_NO_PAD.encode(r#"{"email":"a@outlook.com","name":"Анна"}"#);
        let claims = jwt_claims(&format!("eyJhbGciOiJSUzI1NiJ9.{payload}.sig")).unwrap();
        assert_eq!(claims["email"], "a@outlook.com");
        assert_eq!(claims["name"], "Анна");
        assert!(jwt_claims("garbage").is_none());
    }

    #[tokio::test]
    async fn loopback_receives_the_code() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let browser = async move {
            let get = |path: &'static str| async move {
                let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).await.unwrap();
                let mut out = String::new();
                s.read_to_string(&mut out).await.unwrap();
                out
            };
            assert!(get("/favicon.ico").await.starts_with("HTTP/1.1 404"));
            assert!(get("/oauth/callback?code=x&state=wrong").await.starts_with("HTTP/1.1 400"));
            get("/oauth/callback?code=4%2F0Ab&state=good").await
        };
        let (code, page) = tokio::join!(wait_for_code(&listener, "good"), browser);
        assert_eq!(code.unwrap(), "4/0Ab");
        assert!(page.starts_with("HTTP/1.1 200"));

        let denied = async move {
            let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            s.write_all(b"GET /oauth/callback?error=access_denied&state=good HTTP/1.1\r\n\r\n").await.unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).await.unwrap();
        };
        let (r, ()) = tokio::join!(wait_for_code(&listener, "good"), denied);
        assert_eq!(r.unwrap_err().kind(), "auth");
    }
}
