use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use mail_parser::{Address, Message, MessageParser, MessagePart, MimeHeaders};
use serde::{Deserialize, Serialize};

use crate::{Error, Result};

/// Inline images above this size are not embedded into the rendered HTML.
const MAX_INLINE_IMAGE: usize = 5 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Addr {
    pub name: Option<String>,
    pub email: String,
}

/// Header fields kept in the local cache for message lists.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Summary {
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub subject: String,
    pub from: Option<Addr>,
    pub to: Vec<Addr>,
    pub cc: Vec<Addr>,
    pub reply_to: Vec<Addr>,
    pub date: Option<i64>,
    pub has_attachments: bool,
    /// Written by a program, not a person: a mailing list, newsletter or notification.
    #[serde(default)]
    pub bulk: bool,
    #[serde(default)]
    pub unsubscribe: Option<Unsubscribe>,
    /// Exchange's `Thread-Index`: links a conversation when `References` is missing.
    #[serde(default)]
    pub thread_index: Option<String>,
}

/// Ways to leave a mailing list, from `List-Unsubscribe` (RFC 2369, RFC 8058).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Unsubscribe {
    /// HTTPS address that unsubscribes on a POST without visiting a page (RFC 8058).
    pub one_click: Option<String>,
    pub http: Option<String>,
    pub mailto: Option<String>,
}

impl Summary {
    /// Key for a conversation none of whose messages is cached yet: the first
    /// message's Message-ID when the references know it, Exchange's thread index
    /// when they do not. The cache links known messages first (`Store::insert_message`).
    pub fn thread_key(&self) -> Option<String> {
        if let Some(root) = self.references.first().filter(|r| !r.is_empty()) {
            return Some(root.clone());
        }
        if let Some(index) = &self.thread_index {
            // The first 22 bytes identify the conversation; 28 base64 characters cover 21 of them.
            // Outlook keeps them in every answer, even when it drops References.
            let index = index.trim();
            if index.len() >= 28 {
                return Some(format!("ti:{}", &index[..28]));
            }
        }
        if let Some(parent) = self.in_reply_to.as_ref().filter(|r| !r.is_empty()) {
            return Some(parent.clone());
        }
        self.message_id.clone().filter(|m| !m.is_empty())
    }

    /// Answers and forwards: their subject has a prefix or they name the parent.
    pub fn is_reply(&self) -> bool {
        self.in_reply_to.as_deref().is_some_and(|r| !r.is_empty()) || strip_prefixes(&self.subject).1
    }
}

/// Subject without "Re:", "Fwd:", "Отв:" and the like, folded: answers match the original.
pub fn topic(subject: &str) -> String {
    let rest = strip_prefixes(subject).0;
    rest.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// The subject without its reply and forward prefixes, and whether there were any.
fn strip_prefixes(subject: &str) -> (&str, bool) {
    const PREFIXES: [&str; 13] = [
        "re",
        "fwd",
        "fw",
        "aw",
        "wg",
        "sv",
        "vs",
        "tr",
        "ответ",
        "отв",
        "пересл",
        "пер",
        "rif",
    ];
    let mut s = subject.trim_start();
    let mut found = false;
    loop {
        let lower = s.to_lowercase();
        let Some(word) = PREFIXES.iter().find(|p| lower.starts_with(*p)) else {
            break;
        };
        // Lower-casing keeps the length of these prefixes: the byte index fits `s`.
        let mut rest = s[word.len()..].trim_start();
        // "Re[2]:", "RE(3):"
        if let Some(inner) = rest.strip_prefix(['[', '(']) {
            let digits = inner.trim_start_matches(|c: char| c.is_ascii_digit());
            match digits.strip_prefix([']', ')']) {
                Some(after) if digits.len() < inner.len() => rest = after.trim_start(),
                _ => break,
            }
        }
        let Some(after) = rest.strip_prefix([':', '：']) else {
            break;
        };
        s = after.trim_start();
        found = true;
    }
    (s, found)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentInfo {
    pub index: u32,
    pub name: String,
    pub mime: String,
    pub size: usize,
    pub content_id: Option<String>,
    pub inline: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageView {
    pub summary: Summary,
    pub text: Option<String>,
    /// Sanitized HTML, safe to put into a sandboxed iframe.
    pub html: Option<String>,
    /// The message references remote images or styles (tracking pixels included).
    pub has_remote_content: bool,
    pub attachments: Vec<AttachmentInfo>,
}

pub fn parse_summary(raw: &[u8]) -> Summary {
    match MessageParser::default().parse_headers(raw) {
        Some(msg) => summary_of(&msg),
        None => Summary::default(),
    }
}

pub fn parse_view(raw: &[u8], allow_remote: bool) -> Result<MessageView> {
    let msg = MessageParser::default().parse(raw).ok_or(Error::Parse)?;
    let attachments = attachments_of(&msg);

    let mut inline = HashMap::new();
    for (part, info) in msg.attachments().zip(&attachments) {
        if let Some(cid) = &info.content_id
            && info.mime.starts_with("image/")
            && info.size <= MAX_INLINE_IMAGE
        {
            let uri = format!("data:{};base64,{}", info.mime, BASE64.encode(part.contents()));
            inline.insert(cid.clone(), uri);
        }
    }

    let (html, has_remote_content) = match msg.body_html(0) {
        Some(html) if msg.html_body_count() > 0 && is_real_html(&msg) => {
            let (clean, remote) = sanitize_html(&html, &inline, allow_remote);
            (Some(clean), remote)
        }
        _ => (None, false),
    };
    let text = msg.body_text(0).map(Cow::into_owned);

    Ok(MessageView {
        summary: summary_of(&msg),
        text,
        html,
        has_remote_content,
        attachments,
    })
}

/// mail-parser converts text/plain to HTML when there is no HTML part;
/// only show HTML that the sender actually wrote.
fn is_real_html(msg: &Message<'_>) -> bool {
    msg.html_bodies().any(|p| p.is_content_type("text", "html"))
}

/// Returns the attachment's metadata and decoded content.
pub fn attachment(raw: &[u8], index: u32) -> Result<(AttachmentInfo, Vec<u8>)> {
    let msg = MessageParser::default().parse(raw).ok_or(Error::Parse)?;
    let part = msg.attachment(index).ok_or(Error::NotFound)?;
    let info = attachment_info(index, part);
    Ok((info, part_bytes(part).to_vec()))
}

/// Plain text used for the full-text search index.
pub fn index_text(raw: &[u8]) -> String {
    let Some(msg) = MessageParser::default().parse(raw) else {
        return String::new();
    };
    if let Some(text) = msg
        .text_bodies()
        .find(|p| p.is_content_type("text", "plain"))
        .and_then(|p| p.text_contents())
    {
        return text.to_owned();
    }
    msg.body_html(0).map(|h| strip_tags(&h)).unwrap_or_default()
}

fn strip_tags(html: &str) -> String {
    ammonia::Builder::empty()
        .clean(html)
        .to_string()
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
}

pub fn sanitize_html(html: &str, inline: &HashMap<String, String>, allow_remote: bool) -> (String, bool) {
    let remote = Arc::new(AtomicBool::new(false));
    let inline = Arc::new(inline.clone());

    let mut builder = ammonia::Builder::default();
    builder
        .add_tags(["font", "center"])
        .add_tag_attributes("font", ["color", "face", "size"])
        .add_generic_attributes([
            "style",
            "align",
            "valign",
            "width",
            "height",
            "bgcolor",
            "color",
            "border",
            "cellpadding",
            "cellspacing",
            "dir",
        ])
        .add_url_schemes(["cid", "data"])
        .link_rel(Some("noopener noreferrer"));

    let flag = remote.clone();
    builder.attribute_filter(move |element, attribute, value| {
        let lower = value.trim_start().to_ascii_lowercase();
        if let Some(cid) = lower.strip_prefix("cid:") {
            let cid = cid.trim_matches(['<', '>']);
            return inline
                .iter()
                .find(|(k, _)| k.trim_matches(['<', '>']).eq_ignore_ascii_case(cid))
                .map(|(_, uri)| Cow::Owned(uri.clone()));
        }
        if lower.starts_with("data:") {
            let ok = element == "img" && attribute == "src" && lower.starts_with("data:image/");
            return ok.then_some(Cow::Borrowed(value));
        }
        let loads_resource = (element == "img" && attribute == "src")
            || attribute == "background"
            || (attribute == "style" && lower.contains("url("));
        if loads_resource && (lower.contains("http:") || lower.contains("https:") || lower.contains("//")) {
            flag.store(true, Ordering::Relaxed);
            if !allow_remote {
                return None;
            }
        }
        Some(Cow::Borrowed(value))
    });

    let clean = builder.clean(html).to_string();
    (clean, remote.load(Ordering::Relaxed))
}

/// A header as one line: unfolded and trimmed.
fn raw_header(msg: &Message<'_>, name: &str) -> Option<String> {
    let v = msg.header_raw(name)?;
    let v = v.split_whitespace().collect::<Vec<_>>().join(" ");
    (!v.is_empty()).then_some(v)
}

/// Parses `List-Unsubscribe: <mailto:...>, <https://...>` and `List-Unsubscribe-Post`.
pub fn parse_unsubscribe(header: &str, post: Option<&str>) -> Option<Unsubscribe> {
    let mut out = Unsubscribe::default();
    for item in header.split(',') {
        let item = item.trim().trim_start_matches('<').trim_end_matches('>').trim();
        let lower = item.to_ascii_lowercase();
        if lower.starts_with("mailto:") {
            out.mailto.get_or_insert_with(|| item.to_owned());
        } else if lower.starts_with("https://") || lower.starts_with("http://") {
            out.http.get_or_insert_with(|| item.to_owned());
        }
    }
    let one_click = post.is_some_and(|p| p.replace(' ', "").eq_ignore_ascii_case("List-Unsubscribe=One-Click"));
    if one_click
        && out
            .http
            .as_deref()
            .is_some_and(|u| u.to_ascii_lowercase().starts_with("https://"))
    {
        out.one_click = out.http.clone();
    }
    (out.http.is_some() || out.mailto.is_some()).then_some(out)
}

fn is_bulk(msg: &Message<'_>) -> bool {
    if raw_header(msg, "List-Id").is_some() || raw_header(msg, "List-Unsubscribe").is_some() {
        return true;
    }
    let precedence = raw_header(msg, "Precedence").unwrap_or_default().to_ascii_lowercase();
    if matches!(precedence.as_str(), "bulk" | "list" | "junk") {
        return true;
    }
    // RFC 3834: anything but "no" is a machine (notifications, out-of-office replies).
    raw_header(msg, "Auto-Submitted").is_some_and(|v| !v.eq_ignore_ascii_case("no"))
}

fn summary_of(msg: &Message<'_>) -> Summary {
    let has_attachments = msg.attachment_count() > 0
        || msg.root_part().content_type().is_some_and(|ct| {
            ct.ctype().eq_ignore_ascii_case("multipart")
                && ct.subtype().is_some_and(|s| s.eq_ignore_ascii_case("mixed"))
        });
    Summary {
        message_id: msg.message_id().map(str::to_owned),
        in_reply_to: msg.in_reply_to().as_text().map(str::to_owned),
        references: match msg.references().as_text_list() {
            Some(list) => list.iter().map(|s| s.to_string()).collect(),
            None => msg
                .references()
                .as_text()
                .map(|s| vec![s.to_owned()])
                .unwrap_or_default(),
        },
        subject: msg.subject().unwrap_or_default().to_owned(),
        from: msg.from().and_then(|a| addrs(a).into_iter().next()),
        to: msg.to().map(addrs).unwrap_or_default(),
        cc: msg.cc().map(addrs).unwrap_or_default(),
        reply_to: msg.reply_to().map(addrs).unwrap_or_default(),
        date: msg.date().map(|d| d.to_timestamp()),
        has_attachments,
        bulk: is_bulk(msg),
        unsubscribe: raw_header(msg, "List-Unsubscribe")
            .and_then(|h| parse_unsubscribe(&h, raw_header(msg, "List-Unsubscribe-Post").as_deref())),
        thread_index: raw_header(msg, "Thread-Index"),
    }
}

fn addrs(address: &Address<'_>) -> Vec<Addr> {
    address
        .iter()
        .filter_map(|a| {
            Some(Addr {
                name: a.name().map(str::to_owned).filter(|n| !n.is_empty()),
                email: a.address()?.to_owned(),
            })
        })
        .collect()
}

fn attachments_of(msg: &Message<'_>) -> Vec<AttachmentInfo> {
    msg.attachments()
        .enumerate()
        .map(|(i, part)| attachment_info(i as u32, part))
        .collect()
}

fn attachment_info(index: u32, part: &MessagePart<'_>) -> AttachmentInfo {
    let mime = part
        .content_type()
        .map(|ct| match ct.subtype() {
            Some(sub) => format!("{}/{}", ct.ctype(), sub),
            None => ct.ctype().to_owned(),
        })
        .unwrap_or_else(|| "application/octet-stream".into())
        .to_ascii_lowercase();
    let inline = part
        .content_disposition()
        .is_some_and(|d| d.ctype().eq_ignore_ascii_case("inline"));
    let name = part
        .attachment_name()
        .map(str::to_owned)
        .or_else(|| part.message().and_then(|m| m.subject()).map(|s| format!("{s}.eml")))
        .unwrap_or_else(|| format!("attachment-{}", index + 1));
    AttachmentInfo {
        index,
        name,
        size: part_bytes(part).len(),
        mime,
        content_id: part.content_id().map(str::to_owned),
        inline,
    }
}

fn part_bytes<'a>(part: &'a MessagePart<'_>) -> &'a [u8] {
    match part.message() {
        Some(inner) => inner.raw_message(),
        None => part.contents(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIL: &[u8] = b"From: =?UTF-8?B?0JjQstCw0L0=?= <ivan@example.org>\r\n\
To: Bob <bob@example.org>, carol@example.org\r\n\
Subject: =?UTF-8?B?0J/RgNC40LLQtdGC?=\r\n\
Date: Fri, 2 Oct 2026 10:00:00 +0300\r\n\
Message-ID: <m1@example.org>\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"b1\"\r\n\
\r\n\
--b1\r\n\
Content-Type: multipart/related; boundary=\"b2\"\r\n\
\r\n\
--b2\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<p onclick=\"x()\" style=\"color:red\">Hi<script>alert(1)</script></p>\
<img src=\"cid:logo@x\"><img src=\"https://tracker.example/p.gif\">\r\n\
--b2\r\n\
Content-Type: image/png\r\n\
Content-ID: <logo@x>\r\n\
Content-Disposition: inline\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
iVBORw0KGgo=\r\n\
--b2--\r\n\
--b1\r\n\
Content-Type: application/pdf; name=\"report.pdf\"\r\n\
Content-Disposition: attachment; filename=\"report.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0xLjQK\r\n\
--b1--\r\n";

    #[test]
    fn parses_headers() {
        let s = parse_summary(MAIL);
        assert_eq!(s.subject, "Привет");
        assert_eq!(
            s.from,
            Some(Addr {
                name: Some("Иван".into()),
                email: "ivan@example.org".into()
            })
        );
        assert_eq!(s.to.len(), 2);
        assert_eq!(s.message_id.as_deref(), Some("m1@example.org"));
        assert!(s.has_attachments);
        assert!(s.date.is_some());
    }

    #[test]
    fn sanitizes_html_and_blocks_remote() {
        let view = parse_view(MAIL, false).unwrap();
        let html = view.html.unwrap();
        assert!(!html.contains("script"), "{html}");
        assert!(!html.contains("onclick"), "{html}");
        assert!(html.contains("color:red"), "{html}");
        assert!(html.contains("data:image/png;base64,"), "{html}");
        assert!(!html.contains("tracker.example"), "{html}");
        assert!(view.has_remote_content);

        let allowed = parse_view(MAIL, true).unwrap();
        assert!(allowed.html.unwrap().contains("tracker.example"));
    }

    #[test]
    fn lists_and_extracts_attachments() {
        let view = parse_view(MAIL, false).unwrap();
        let pdf = view
            .attachments
            .iter()
            .find(|a| a.name == "report.pdf")
            .expect("pdf listed");
        assert_eq!(pdf.mime, "application/pdf");
        assert!(!pdf.inline);
        let (_, bytes) = attachment(MAIL, pdf.index).unwrap();
        assert!(bytes.starts_with(b"%PDF-1.4"));
    }

    /// Criterion 4.2: Windows-1251 and KOI8-R in headers, bodies and attachment names.
    #[test]
    fn decodes_russian_legacy_charsets() {
        let raw = b"From: =?koi8-r?Q?=E2=D5=C8=C7=C1=CC=D4=C5=D2=C9=D1?= <buh@example.ru>\r\n\
To: me@example.ru\r\n\
Subject: =?windows-1251?B?0fe48iDt4CDu7+vg8vM=?=\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"x\"\r\n\
\r\n\
--x\r\n\
Content-Type: text/plain; charset=windows-1251\r\n\
Content-Transfer-Encoding: quoted-printable\r\n\
\r\n\
=C4=EE=E1=F0=FB=E9 =E4=E5=ED=FC! =CE=EF=EB=E0=F2=E8=F2=E5 =E4=EE =EF=FF=F2=\r\n\
=ED=E8=F6=FB.\r\n\
--x\r\n\
Content-Type: text/plain; charset=koi8-r\r\n\
Content-Disposition: attachment; filename*=koi8-r''%CF%D4%DE%A3%D4%2E%74%78%74\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
8NLJ18XUIMnaIEtPSTgtUg==\r\n\
--x--\r\n";
        let view = parse_view(raw, false).unwrap();
        assert_eq!(view.summary.subject, "Счёт на оплату");
        assert_eq!(view.summary.from.as_ref().unwrap().name.as_deref(), Some("Бухгалтерия"));
        assert_eq!(
            view.text.as_deref().map(str::trim),
            Some("Добрый день! Оплатите до пятницы.")
        );
        assert_eq!(view.attachments[0].name, "отчёт.txt");
        let (_, bytes) = attachment(raw, 0).unwrap();
        // Text attachments are saved re-encoded to UTF-8, so any editor opens them.
        assert_eq!(String::from_utf8(bytes).unwrap(), "Привет из KOI8-R");
        assert!(index_text(raw).contains("пятницы"));
    }

    #[test]
    fn recognises_mailing_lists_and_unsubscribe() {
        let raw = b"From: News <news@shop.example>\r\nTo: me@example.org\r\nSubject: Sale\r\n\
List-Unsubscribe: <mailto:unsub@shop.example?subject=stop>,\r\n <https://shop.example/u/123>\r\n\
List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\nHi\r\n";
        let s = parse_summary(raw);
        assert!(s.bulk);
        let u = s.unsubscribe.unwrap();
        assert_eq!(u.mailto.as_deref(), Some("mailto:unsub@shop.example?subject=stop"));
        assert_eq!(u.one_click.as_deref(), Some("https://shop.example/u/123"));

        // Plain http is never one-click; a person's letter is not bulk.
        let u = parse_unsubscribe("<http://x.example/u>", Some("List-Unsubscribe=One-Click")).unwrap();
        assert!(u.one_click.is_none());
        assert!(!parse_summary(MAIL).bulk);
        let auto = b"From: a@b.c\r\nAuto-Submitted: auto-generated\r\nSubject: x\r\n\r\nx";
        assert!(parse_summary(auto).bulk);
        let human = b"From: a@b.c\r\nAuto-Submitted: no\r\nSubject: x\r\n\r\nx";
        assert!(!parse_summary(human).bulk);
    }

    #[test]
    fn thread_key_finds_the_root() {
        let root = b"Message-ID: <a@x>\r\nSubject: q\r\n\r\nx";
        let reply = b"Message-ID: <b@x>\r\nIn-Reply-To: <a@x>\r\nSubject: Re: q\r\n\r\nx";
        let deep = b"Message-ID: <c@x>\r\nIn-Reply-To: <b@x>\r\nReferences: <a@x> <b@x>\r\nSubject: Re: q\r\n\r\nx";
        let keys: Vec<_> = [&root[..], &reply[..], &deep[..]]
            .iter()
            .map(|r| parse_summary(r).thread_key())
            .collect();
        assert_eq!(keys, vec![Some("a@x".to_owned()); 3]);
    }

    #[test]
    fn topic_drops_reply_prefixes() {
        for s in [
            "Счёт",
            "Re: Счёт",
            "RE: re:  счёт",
            "Отв: Счёт",
            "Re[2]: Счёт",
            "FW: Re: Счёт",
            "AW:Счёт",
        ] {
            assert_eq!(topic(s), "счёт", "{s}");
        }
        assert_eq!(topic("Report: May"), "report: may");
        assert_eq!(topic("Перенос встречи"), "перенос встречи");
        assert!(!strip_prefixes("Перенос: среда").1);
        assert!(strip_prefixes("Пересл: среда").1);
    }

    #[test]
    fn outlook_answers_keep_the_thread_index() {
        let root = b"Message-ID: <a@x>\r\nThread-Index: AdlBcDEFGHIJKLMNOPQRSTUVWXYZab==\r\nSubject: q\r\n\r\nx";
        let reply = b"Message-ID: <b@x>\r\nIn-Reply-To: <a@x>\r\nThread-Index: AdlBcDEFGHIJKLMNOPQRSTUVWXYZabCDEFGH\r\nSubject: RE: q\r\n\r\nx";
        assert_eq!(parse_summary(root).thread_key(), parse_summary(reply).thread_key());
    }

    #[test]
    fn indexes_html_as_text() {
        assert!(index_text(MAIL).contains("Hi"));
    }
}
