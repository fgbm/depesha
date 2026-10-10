//! The words of the interface: the core returns codes and English text for the log; here they
//! become what the user reads, in the language of the interface (#142).

use std::time::Duration;

use depesha_core::account::OAuthProvider;
use depesha_core::autodetect::{Note, Source};
use depesha_core::outbox::Words;
use depesha_core::tls::{CertProblem, CertWhy};
use depesha_core::{Class, Error, EwsMeaning, ImapFault, Say, SmtpMeaning, Xoauth2Detail, seconds};

use crate::lang::{self, Lang};

/// An error in the user's words.
pub fn error(err: &Error, lang: Lang) -> String {
    match lang {
        Lang::En => err.to_string(),
        Lang::Ru => error_ru(err),
    }
}

/// An error in the language of the interface now.
pub fn error_now(err: &Error) -> String {
    error(err, lang::current())
}

fn error_ru(err: &Error) -> String {
    match err {
        Error::Io(e) => io_ru(e),
        Error::Timeout(what) => format!("сервер не ответил вовремя ({})", timeout_ru(what)),
        Error::Tls(e) => format!("TLS: {e}"),
        Error::Certificate(p) => format!("недоверенный сертификат {}: {}", p.host, cert_reason(p, Lang::Ru)),
        Error::NoTls => "сервер не поддерживает шифрование (STARTTLS); пароль не отправлен".into(),
        Error::InvalidHost(h) => format!("неверное имя сервера: {h}"),
        Error::Auth(m) => format!("сервер отклонил вход: {m}"),
        Error::AuthMechanism(m) => {
            let m = if m.is_empty() { "ничего" } else { m };
            format!("сервер не предлагает поддерживаемый способ входа (предлагает: {m}); нужен PLAIN или LOGIN")
        }
        Error::ImapUnavailable => {
            "сервер принял пароль, но не открыл ящик по IMAP. На Exchange: для ящика выключен IMAP \
             (ImapEnabled) или не запущена служба MSExchangeIMAP4BE"
                .into()
        }
        Error::Imap(_) => format!("IMAP: {}", imap_ru(err)),
        Error::Smtp {
            code,
            enhanced,
            message,
        } => match SmtpMeaning::of(*code, enhanced.as_deref()) {
            Some(m) => format!("{} (сервер: {code} {message})", smtp_ru(m)),
            None => format!("сервер ответил {code}: {message}"),
        },
        Error::SmtpHello { name, code, message } => {
            format!("сервер не принял приветствие клиента (EHLO {name}) ещё до входа: {code} {message}")
        }
        Error::TooLarge { size, limit } => format!("письмо {size} байт больше лимита сервера {limit} байт"),
        Error::Compose(m) => format!("письмо не собрано: {m}"),
        Error::Store(e) => format!("локальная база: {e}"),
        Error::StoreOther(m) => format!("локальная база: {m}"),
        Error::ImapOther(m) => format!("IMAP: {m}"),
        Error::Closed => "сервер закрыл соединение".into(),
        Error::Bye(text) => format!("сервер закрыл соединение: {text}"),
        Error::Paused => "ящик приостановлен, пока не исправлены его настройки".into(),
        Error::Protocol(m) => format!("сервер ответил непонятно: {m}"),
        Error::NotFound => "письмо не найдено".into(),
        Error::Unreadable => "сохранённые данные не читаются".into(),
        Error::CacheTooNew { found, known } => format!(
            "локальный кэш почты сохранён более новой версией Депеши (формат {found}, эта версия \
             читает до {known}). Установите новую версию; кэш оставлен как есть"
        ),
        Error::FolderChanged => {
            "папка изменилась на сервере, пока действие ждало очереди; ничего не сделано, повторите действие".into()
        }
        Error::LabelStripping => "Метка ещё удаляется, попробуйте через минуту".into(),
        Error::LabelCheckUnsupported => {
            "на этом сервере нет UIDPLUS: проверка меток не сможет удалить тестовое письмо, поэтому она не выполняется"
                .into()
        }
        Error::CopyRefused(text) => text.clone(),
        Error::Parse => "не удалось разобрать письмо".into(),
        Error::PrivateAddress(host) => {
            format!("{host} — адрес во внутренней сети; по ссылке из письма Депеша туда не обращается")
        }
        Error::Ews {
            code,
            message,
            back_off,
        } => ews_ru(code, message, *back_off),
        Error::Busy { wait, retrying: true } => {
            format!("сервер Exchange занят; ящик повторит запрос через {} с", seconds(*wait))
        }
        Error::Busy { wait, retrying: false } => {
            format!(
                "сервер Exchange занят; ничего не сделано, повторите через {} с",
                seconds(*wait)
            )
        }
        Error::HttpAuth(offered) => format!(
            "Exchange принимает на EWS только {offered}, а Депеша входит через Basic или NTLM. Попросите \
             администратора включить один из них: Set-WebServicesVirtualDirectory -WindowsAuthentication $true"
        ),
        Error::Said(say) => {
            let body = say_ru(say);
            match say.class() {
                Class::Auth => format!("сервер отклонил вход: {body}"),
                Class::Protocol => format!("сервер ответил непонятно: {body}"),
                Class::Compose => format!("письмо не собрано: {body}"),
                Class::Transient => format!("сеть: {body}"),
            }
        }
    }
}

fn timeout_ru(what: &str) -> &str {
    match what {
        "connecting" => "подключение",
        "server greeting" => "приветствие сервера",
        "search answer" => "ответ на поиск",
        "SMTP answer" => "ответ SMTP",
        "operation" => "операция",
        "connecting to the list server" => "подключение к серверу рассылки",
        "list server answer" => "ответ сервера рассылки",
        "HTTP answer" => "ответ HTTP",
        other => other,
    }
}

fn io_ru(e: &std::io::Error) -> String {
    use std::io::ErrorKind as K;
    let text = e.to_string();
    match e.kind() {
        K::ConnectionRefused => "сервер не принимает соединения (порт закрыт или сервер выключен)".into(),
        K::ConnectionReset | K::ConnectionAborted | K::BrokenPipe | K::UnexpectedEof => {
            "соединение с сервером оборвалось".into()
        }
        K::TimedOut => "сервер не ответил вовремя".into(),
        K::NetworkUnreachable | K::HostUnreachable => "нет сети или сервер недоступен".into(),
        _ if text.contains("lookup address") || text.contains("Name or service not known") => {
            "сервер не найден: проверьте имя (DNS)".into()
        }
        _ => format!("сеть: {text}"),
    }
}

fn imap_ru(err: &Error) -> String {
    match err.imap_fault() {
        Some(Ok(ImapFault::Refused(m))) => format!("сервер отказал: {m}"),
        Some(Ok(ImapFault::NotAccepted(m))) => format!("сервер не принял команду: {m}"),
        Some(Ok(ImapFault::ConnectionLost)) => "соединение с сервером оборвалось".into(),
        Some(Ok(ImapFault::Other(text))) => text,
        Some(Err(io)) => io_ru(io),
        None => String::new(),
    }
}

fn smtp_ru(m: SmtpMeaning) -> &'static str {
    match m {
        SmtpMeaning::RateLimited => {
            "сервер ограничил частоту отправки (у Exchange по умолчанию 5 писем в минуту); письмо уйдёт позже"
        }
        SmtpMeaning::SendAsDenied => "нет права отправлять от имени этого адреса (Send As)",
        SmtpMeaning::WrongLogin => "неверный логин или пароль",
        SmtpMeaning::LoginRequired => "сервер требует входа перед отправкой",
        SmtpMeaning::TooLarge => "письмо слишком большое для сервера",
        SmtpMeaning::NoSuchRecipient => "адрес получателя не существует",
        SmtpMeaning::Refused => "сервер отказался принять письмо (нет прав или письмо отклонено политикой)",
        SmtpMeaning::Temporary => "временная ошибка сервера, письмо уйдёт позже",
    }
}

fn ews_ru(code: &str, message: &str, back_off: Option<Duration>) -> String {
    if code == "ErrorServerBusy" {
        return match back_off {
            Some(d) => format!("сервер занят и просит подождать {} с (Exchange: {code})", seconds(d)),
            None => format!("сервер занят (Exchange: {code})"),
        };
    }
    match EwsMeaning::of(code) {
        Some(m) => {
            let words = match m {
                EwsMeaning::ItemGone => "письма уже нет на сервере",
                EwsMeaning::FolderGone => "папки уже нет на сервере",
                EwsMeaning::TooLarge => "письмо слишком большое для сервера",
                EwsMeaning::SendAsDenied => "нет права отправлять от имени этого адреса (Send As)",
                EwsMeaning::MailboxFull => "ящик переполнен",
                EwsMeaning::AccessDenied => "доступ запрещён",
            };
            format!("{words} (Exchange: {code})")
        }
        None => format!("Exchange ответил {code}: {message}"),
    }
}

/// The name of a sign-in provider as the interface says it.
pub fn provider_title(provider: OAuthProvider, lang: Lang) -> &'static str {
    match (provider, lang) {
        (OAuthProvider::Yandex, Lang::Ru) => "Яндекс",
        _ => provider.title(),
    }
}

fn say_ru(say: &Say) -> String {
    let title = |p: &OAuthProvider| provider_title(*p, Lang::Ru);
    match say {
        Say::EwsUnavailable { status } => format!("сервер Exchange временно недоступен (HTTP {status})"),
        Say::EwsHttp { status } => format!("EWS ответил HTTP {status}; проверьте адрес сервера"),
        Say::EwsKerberos => {
            "неверный логин или пароль, либо сервер принимает только Kerberos (логин часто ДОМЕН\\пользователь)".into()
        }
        Say::EwsWrongLogin => "неверный логин или пароль (на Exchange логин часто ДОМЕН\\пользователь)".into(),
        Say::EwsEmptyAnswer => "пустой ответ EWS".into(),
        Say::EwsNoFolderRoot => "у ящика нет корня папок".into(),
        Say::SearchCharset { info } => {
            format!("сервер не выполнил поиск по-русски (нет поддержки CHARSET UTF-8): {info}")
        }
        Say::UnsubscribeNoSafeWay => "отправитель не указал безопасного способа отписаться".into(),
        Say::UnsubscribeHttpsOnly => "отписка в один клик возможна только по https".into(),
        Say::ListUnexpected { line } => format!("сервер рассылки ответил непонятно: {line}"),
        Say::ListRefused { status } => format!("сервер рассылки отказал в отписке: HTTP {status}"),
        Say::UnsubscribeBadAddress { url } => format!("адрес для отписки — не один правильный адрес: {url}"),
        Say::UnsubscribeControlChars => "в теме или тексте письма-отписки есть управляющие символы".into(),
        Say::AnswerTooLarge { why } => format!("слишком большой ответ: {why}"),
        Say::InvalidAddress { email } => format!("неверный адрес: {email}"),
        Say::NoSender => "не указан отправитель".into(),
        Say::NoRecipients => "нет ни одного получателя".into(),
        Say::SignInPortsBusy { first, last, why } => {
            format!("порты {first}–{last} для ответа на вход заняты: {why}")
        }
        Say::SignInTimeout => "браузер не вернулся за десять минут".into(),
        Say::SignInCancelled => "вход отменён".into(),
        Say::OauthNotConfigured { provider } => format!(
            "вход через {} не настроен в этой сборке: укажите свой OAuth-клиент в настройках",
            title(provider)
        ),
        Say::ProviderDenied => "провайдер отказал: доступ не разрешён".into(),
        Say::ProviderRefused { text } => format!("провайдер отказал: {text}"),
        Say::TokenEndpoint { status, body } => format!("сервер токенов ответил {status}: {body}"),
        Say::OauthInvalidGrant { provider, detail } => format!(
            "{} больше не принимает сохранённый вход, войдите заново ({detail})",
            title(provider)
        ),
        Say::OauthInvalidClient { provider, detail } => {
            format!("{} не знает OAuth-клиент приложения: {detail}", title(provider))
        }
        Say::OauthNoToken => "в ответе нет токена доступа".into(),
        Say::OauthNoRefresh { provider } => format!(
            "{} не выдал токен обновления; отзовите доступ приложения в настройках аккаунта и войдите снова",
            title(provider)
        ),
        Say::OauthNoMailAccess { provider } => format!(
            "{} не дал доступ к почте: войдите заново и на странице разрешений отметьте доступ к почте",
            title(provider)
        ),
        Say::OauthNoAddress { provider } => format!("{} не сообщил адрес", title(provider)),
        Say::AccountNotRunning => "учётная запись не запущена".into(),
        Say::AuthDetail { message, detail } => {
            let detail = match detail {
                Xoauth2Detail::NoMailAccess(status) => {
                    format!("вход не даёт доступа к почте: войдите заново и разрешите доступ к почте ({status})")
                }
                Xoauth2Detail::Expired(status) => format!("вход устарел: войдите заново ({status})"),
                Xoauth2Detail::Other(text) => text.clone(),
            };
            format!("{message} ({detail})")
        }
    }
}

/// Why a certificate is rejected, in the user's words.
pub fn cert_reason(p: &CertProblem, lang: Lang) -> String {
    if lang == Lang::En || p.why == CertWhy::Other {
        return p.reason.clone();
    }
    match p.why {
        CertWhy::Expired => "срок действия сертификата истёк",
        CertWhy::NotYetValid => "сертификат ещё не действует (проверьте часы компьютера)",
        CertWhy::UnknownIssuer => {
            "сертификат выдан неизвестным центром: самоподписанный или внутренний центр сертификации"
        }
        CertWhy::WrongName => "сертификат выдан для другого имени сервера",
        CertWhy::Revoked => "сертификат отозван",
        CertWhy::Failed => "сертификат не прошёл проверку",
        CertWhy::Other => unreachable!(),
    }
    .into()
}

/// The certificate as the interface gets it: its reason worded.
pub fn cert_view(p: &CertProblem, lang: Lang) -> CertProblem {
    CertProblem {
        reason: cert_reason(p, lang),
        ..p.clone()
    }
}

fn source_text(s: &Source, lang: Lang) -> String {
    if lang == Lang::En {
        return s.to_string();
    }
    match s {
        Source::KnownProvider => "известный провайдер".into(),
        Source::ProbingNames => "перебор адресов сервера".into(),
        Source::EnteredAddress => "указанный адрес".into(),
        other => other.to_string(),
    }
}

fn note_text(n: &Note, lang: Lang) -> String {
    if lang == Lang::En {
        return n.to_string();
    }
    match n {
        Note::NoDomain => "адрес без домена".into(),
        Note::Microsoft365BrowserOnly => {
            "Microsoft 365 принимает только вход через браузер: вернитесь и нажмите «Войти через Microsoft»".into()
        }
        Note::AutoconfigHostMissing(host) => format!("{host} из autoconfig не существует"),
        Note::Untrusted { server, problem } => format!("{server} — {}", cert_reason(problem, lang)),
        Note::NoTls { server } => format!("{server} — {}", error(&Error::NoTls, lang)),
    }
}

/// What a detection says, worded: the strings the interface shows.
pub fn source_and_notes(source: Option<&Source>, notes: &[Note], lang: Lang) -> (String, Vec<String>) {
    (
        source.map(|s| source_text(s, lang)).unwrap_or_default(),
        notes.iter().map(|n| note_text(n, lang)).collect(),
    )
}

/// The words the outbox rules store (`last_error`) in the language of the interface.
pub struct Phrases;

impl Words for Phrases {
    fn failure(&self, e: &Error) -> String {
        error_now(e)
    }
    fn possibly_sent(&self) -> String {
        crate::tr!(
            "possibly sent: check “Sent”",
            "возможно, ушло — проверьте «Отправленные»"
        )
    }
    fn not_on_time(&self) -> String {
        crate::tr!(
            "not sent on time: Depesha was closed or the computer was asleep",
            "не ушло вовремя: Депеша была закрыта или компьютер спал"
        )
    }
    fn account_removed(&self) -> String {
        crate::tr!("the account was removed", "учётная запись удалена")
    }
}

/// The words of the pages the browser shows when a sign-in comes back.
pub fn sign_in_pages() -> depesha_core::oauth::PageWords {
    depesha_core::oauth::PageWords {
        signed_in: lang::pick("Signed in", "Вход выполнен").into(),
        close_tab: lang::pick(
            "You can close this tab and return to Depesha.",
            "Вкладку можно закрыть и вернуться в Депешу.",
        )
        .into(),
        failed: lang::pick("Sign-in failed", "Вход не выполнен").into(),
        unexpected: lang::pick("Unexpected request.", "Неожиданный запрос.").into(),
        denied: lang::pick("access was not granted", "доступ не разрешён").into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    include!("error_samples.in");

    /// The texts the user read before the core stopped wording errors (#142): every wording of
    /// `Error`, in both languages, as the old `Display` made them.
    #[test]
    fn the_texts_of_the_errors_are_the_ones_the_user_always_read() {
        let mut got = String::new();
        for lang in [Lang::En, Lang::Ru] {
            for (name, e) in samples() {
                got.push_str(&format!("{lang:?}|{name}|{}\n", error(&e, lang)));
            }
        }
        let want = include_str!("error_texts.golden");
        for (g, w) in got.lines().zip(want.lines()) {
            assert_eq!(g, w);
        }
        assert_eq!(got.lines().count(), want.lines().count());
    }

    fn say_error(s: Say) -> Error {
        Error::Said(s)
    }

    /// Every phrase the core words itself, as the user read it before: wrapped in what the old
    /// kind of error put around it, in both languages.
    #[test]
    fn the_phrases_of_the_core_read_as_they_always_did() {
        use OAuthProvider::{Google, Yandex};
        let s = String::from;
        let table: Vec<(Say, &str, &str)> = vec![
            (
                Say::EwsUnavailable { status: 503 },
                "network: the Exchange server is temporarily unavailable (HTTP 503)",
                "сеть: сервер Exchange временно недоступен (HTTP 503)",
            ),
            (
                Say::EwsHttp { status: 404 },
                "unexpected answer from the server: EWS answered HTTP 404; check the server address",
                "сервер ответил непонятно: EWS ответил HTTP 404; проверьте адрес сервера",
            ),
            (
                Say::EwsKerberos,
                "the server rejected the login: wrong user name or password, or the server takes Kerberos only (the login is often DOMAIN\\user)",
                "сервер отклонил вход: неверный логин или пароль, либо сервер принимает только Kerberos (логин часто ДОМЕН\\пользователь)",
            ),
            (
                Say::EwsWrongLogin,
                "the server rejected the login: wrong user name or password (on Exchange the login is often DOMAIN\\user)",
                "сервер отклонил вход: неверный логин или пароль (на Exchange логин часто ДОМЕН\\пользователь)",
            ),
            (
                Say::EwsEmptyAnswer,
                "unexpected answer from the server: empty answer from EWS",
                "сервер ответил непонятно: пустой ответ EWS",
            ),
            (
                Say::EwsNoFolderRoot,
                "unexpected answer from the server: the mailbox has no folder root",
                "сервер ответил непонятно: у ящика нет корня папок",
            ),
            (
                Say::SearchCharset { info: s("x") },
                "unexpected answer from the server: the server could not search for non-Latin text (no CHARSET UTF-8 support): x",
                "сервер ответил непонятно: сервер не выполнил поиск по-русски (нет поддержки CHARSET UTF-8): x",
            ),
            (
                Say::UnsubscribeNoSafeWay,
                "unexpected answer from the server: the sender gave no way to unsubscribe that is safe to use",
                "сервер ответил непонятно: отправитель не указал безопасного способа отписаться",
            ),
            (
                Say::UnsubscribeHttpsOnly,
                "unexpected answer from the server: one-click unsubscribe works only over https",
                "сервер ответил непонятно: отписка в один клик возможна только по https",
            ),
            (
                Say::ListUnexpected {
                    line: s("HTTP/1.1 ???"),
                },
                "unexpected answer from the server: unexpected answer from the list server: HTTP/1.1 ???",
                "сервер ответил непонятно: сервер рассылки ответил непонятно: HTTP/1.1 ???",
            ),
            (
                Say::ListRefused { status: 500 },
                "unexpected answer from the server: the list server refused to unsubscribe: HTTP 500",
                "сервер ответил непонятно: сервер рассылки отказал в отписке: HTTP 500",
            ),
            (
                Say::UnsubscribeBadAddress { url: s("mailto:x") },
                "the message could not be built: the unsubscribe address is not a single valid address: mailto:x",
                "письмо не собрано: адрес для отписки — не один правильный адрес: mailto:x",
            ),
            (
                Say::UnsubscribeControlChars,
                "the message could not be built: the unsubscribe letter's subject or text has control characters",
                "письмо не собрано: в теме или тексте письма-отписки есть управляющие символы",
            ),
            (
                Say::AnswerTooLarge { why: s("limit") },
                "unexpected answer from the server: answer too large: limit",
                "сервер ответил непонятно: слишком большой ответ: limit",
            ),
            (
                Say::InvalidAddress { email: s("a b") },
                "the message could not be built: invalid address: a b",
                "письмо не собрано: неверный адрес: a b",
            ),
            (
                Say::NoSender,
                "the message could not be built: no sender",
                "письмо не собрано: не указан отправитель",
            ),
            (
                Say::NoRecipients,
                "the message could not be built: no recipients",
                "письмо не собрано: нет ни одного получателя",
            ),
            (
                Say::SignInPortsBusy {
                    first: 47851,
                    last: 47853,
                    why: s("in use"),
                },
                "unexpected answer from the server: ports 47851–47853 for the sign-in answer are busy: in use",
                "сервер ответил непонятно: порты 47851–47853 для ответа на вход заняты: in use",
            ),
            (
                Say::SignInTimeout,
                "the server rejected the login: the browser did not come back in ten minutes",
                "сервер отклонил вход: браузер не вернулся за десять минут",
            ),
            (
                Say::SignInCancelled,
                "the server rejected the login: sign-in cancelled",
                "сервер отклонил вход: вход отменён",
            ),
            (
                Say::OauthNotConfigured { provider: Yandex },
                "the server rejected the login: sign-in with Yandex is not set up in this build: add your OAuth client in Preferences",
                "сервер отклонил вход: вход через Яндекс не настроен в этой сборке: укажите свой OAuth-клиент в настройках",
            ),
            (
                Say::ProviderDenied,
                "the server rejected the login: the provider refused: access was not granted",
                "сервер отклонил вход: провайдер отказал: доступ не разрешён",
            ),
            (
                Say::ProviderRefused {
                    text: s("server_error x"),
                },
                "the server rejected the login: the provider refused: server_error x",
                "сервер отклонил вход: провайдер отказал: server_error x",
            ),
            (
                Say::TokenEndpoint {
                    status: 502,
                    body: s("bad gateway"),
                },
                "unexpected answer from the server: token endpoint answered 502: bad gateway",
                "сервер ответил непонятно: сервер токенов ответил 502: bad gateway",
            ),
            (
                Say::OauthInvalidGrant {
                    provider: Google,
                    detail: s("expired"),
                },
                "the server rejected the login: Google no longer accepts the saved sign-in, sign in again (expired)",
                "сервер отклонил вход: Google больше не принимает сохранённый вход, войдите заново (expired)",
            ),
            (
                Say::OauthInvalidClient {
                    provider: Yandex,
                    detail: s("unknown"),
                },
                "the server rejected the login: Yandex does not know this app's OAuth client: unknown",
                "сервер отклонил вход: Яндекс не знает OAuth-клиент приложения: unknown",
            ),
            (
                Say::OauthNoToken,
                "unexpected answer from the server: no access token in the answer",
                "сервер ответил непонятно: в ответе нет токена доступа",
            ),
            (
                Say::OauthNoRefresh { provider: Google },
                "the server rejected the login: Google gave no refresh token; remove the app's access in the account settings and sign in again",
                "сервер отклонил вход: Google не выдал токен обновления; отзовите доступ приложения в настройках аккаунта и войдите снова",
            ),
            (
                Say::OauthNoMailAccess { provider: Google },
                "the server rejected the login: Google did not grant access to mail: sign in again and tick mail access on the permissions page",
                "сервер отклонил вход: Google не дал доступ к почте: войдите заново и на странице разрешений отметьте доступ к почте",
            ),
            (
                Say::OauthNoAddress { provider: Yandex },
                "unexpected answer from the server: Yandex did not tell the address",
                "сервер ответил непонятно: Яндекс не сообщил адрес",
            ),
            (
                Say::AccountNotRunning,
                "network: the account is not running",
                "сеть: учётная запись не запущена",
            ),
            (
                Say::AuthDetail {
                    message: s("refused"),
                    detail: Xoauth2Detail::NoMailAccess(s("400")),
                },
                "the server rejected the login: refused (the sign-in does not allow mail access: sign in again and allow access to mail (400))",
                "сервер отклонил вход: refused (вход не даёт доступа к почте: войдите заново и разрешите доступ к почте (400))",
            ),
            (
                Say::AuthDetail {
                    message: s("refused"),
                    detail: Xoauth2Detail::Expired(s("401")),
                },
                "the server rejected the login: refused (the sign-in has expired: sign in again (401))",
                "сервер отклонил вход: refused (вход устарел: войдите заново (401))",
            ),
        ];
        for (say, en, ru) in table {
            let e = say_error(say);
            assert_eq!(error(&e, Lang::En), en);
            assert_eq!(error(&e, Lang::Ru), ru);
        }
    }

    #[test]
    fn a_certificate_reason_is_worded_by_its_code() {
        let p = |why: CertWhy, reason: &str| CertProblem {
            host: "h".into(),
            reason: reason.into(),
            why,
            sha256: String::new(),
            subject: String::new(),
            issuer: String::new(),
            not_after: None,
        };
        for (why, en, ru) in [
            (
                CertWhy::Expired,
                "the certificate has expired",
                "срок действия сертификата истёк",
            ),
            (
                CertWhy::NotYetValid,
                "the certificate is not valid yet (check the computer's clock)",
                "сертификат ещё не действует (проверьте часы компьютера)",
            ),
            (
                CertWhy::UnknownIssuer,
                "issued by an unknown authority: self-signed or an internal certificate authority",
                "сертификат выдан неизвестным центром: самоподписанный или внутренний центр сертификации",
            ),
            (
                CertWhy::WrongName,
                "issued for a different server name",
                "сертификат выдан для другого имени сервера",
            ),
            (CertWhy::Revoked, "the certificate is revoked", "сертификат отозван"),
            (
                CertWhy::Failed,
                "the certificate failed verification",
                "сертификат не прошёл проверку",
            ),
        ] {
            let problem = p(why, en);
            assert_eq!(cert_reason(&problem, Lang::En), en);
            assert_eq!(cert_reason(&problem, Lang::Ru), ru);
        }
        // A reason the verifier worded itself is shown as it came.
        assert_eq!(cert_reason(&p(CertWhy::Other, "bad der"), Lang::Ru), "bad der");
    }

    #[test]
    fn the_source_and_the_notes_of_a_detection_read_as_they_always_did() {
        let problem = Box::new(CertProblem {
            host: "smtp.example.org".into(),
            reason: "issued for a different server name".into(),
            why: CertWhy::WrongName,
            sha256: String::new(),
            subject: String::new(),
            issuer: String::new(),
            not_after: None,
        });
        let notes = [
            Note::NoDomain,
            Note::Microsoft365BrowserOnly,
            Note::AutoconfigHostMissing("smtp.example.org".into()),
            Note::Untrusted {
                server: "smtp.example.org:587".into(),
                problem,
            },
            Note::NoTls {
                server: "mx.example.org:25".into(),
            },
        ];
        let (src, en) = source_and_notes(Some(&Source::KnownProvider), &notes, Lang::En);
        assert_eq!(src, "known provider");
        assert_eq!(
            en,
            [
                "the address has no domain",
                "Microsoft 365 accepts only sign-in through the browser: go back and use «Sign in with Microsoft»",
                "smtp.example.org from autoconfig does not exist",
                "smtp.example.org:587 — issued for a different server name",
                "mx.example.org:25 — the server does not support encryption (STARTTLS); the password was not sent",
            ]
        );
        let (src, ru) = source_and_notes(Some(&Source::KnownProvider), &notes, Lang::Ru);
        assert_eq!(src, "известный провайдер");
        assert_eq!(
            ru,
            [
                "адрес без домена",
                "Microsoft 365 принимает только вход через браузер: вернитесь и нажмите «Войти через Microsoft»",
                "smtp.example.org из autoconfig не существует",
                "smtp.example.org:587 — сертификат выдан для другого имени сервера",
                "mx.example.org:25 — сервер не поддерживает шифрование (STARTTLS); пароль не отправлен",
            ]
        );
        for (source, en, ru) in [
            (Source::ProbingNames, "probing server names", "перебор адресов сервера"),
            (Source::EnteredAddress, "the address you entered", "указанный адрес"),
            (Source::DnsSrv, "DNS SRV", "DNS SRV"),
            (Source::Autoconfig("h".into()), "autoconfig (h)", "autoconfig (h)"),
            (Source::Mx("h".into()), "MX: h", "MX: h"),
            (Source::MxMicrosoft365, "MX: Microsoft 365", "MX: Microsoft 365"),
            (Source::Autodiscover("h".into()), "Autodiscover (h)", "Autodiscover (h)"),
        ] {
            assert_eq!(source_and_notes(Some(&source), &[], Lang::En).0, en);
            assert_eq!(source_and_notes(Some(&source), &[], Lang::Ru).0, ru);
        }
        assert_eq!(source_and_notes(None, &[], Lang::Ru).0, "");
    }
}
