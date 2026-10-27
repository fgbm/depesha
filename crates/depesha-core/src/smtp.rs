//! Message building (lettre) and our own SMTP submission client: we need the
//! EHLO capabilities, certificate pinning and the exact server replies.

use crate::best_effort;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use lettre::Message;
use lettre::message::header::{ContentTransferEncoding, ContentType};
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufStream};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::account::{Credentials, Security, ServerConfig};
use crate::domain::{Addr, Importance};
use crate::domain::{BodyFormat, Draft};
use crate::imap::Io;
use crate::say::Say;
use crate::{Error, Result, tls};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const REPLY_TIMEOUT: Duration = Duration::from_secs(120);

/// `Importance: high` (RFC 2156) and `X-Priority: 1 (Highest)`, the pair Outlook writes.
fn importance_headers(
    builder: lettre::message::MessageBuilder,
    importance: Importance,
) -> lettre::message::MessageBuilder {
    use lettre::message::header::{Header, HeaderName, HeaderValue};

    macro_rules! plain_header {
        ($type:ident, $name:literal) => {
            #[derive(Clone)]
            struct $type(String);
            impl Header for $type {
                fn name() -> HeaderName {
                    HeaderName::new_from_ascii_str($name)
                }
                fn parse(s: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
                    Ok(Self(s.to_owned()))
                }
                fn display(&self) -> HeaderValue {
                    HeaderValue::new(Self::name(), self.0.clone())
                }
            }
        };
    }
    plain_header!(ImportanceHeader, "Importance");
    plain_header!(PriorityHeader, "X-Priority");

    match importance {
        Importance::High => builder
            .header(ImportanceHeader("high".into()))
            .header(PriorityHeader("1 (Highest)".into())),
        Importance::Low => builder
            .header(ImportanceHeader("low".into()))
            .header(PriorityHeader("5 (Lowest)".into())),
        Importance::Normal => builder,
    }
}

fn mailbox(a: &Addr) -> Result<Mailbox> {
    let email = a
        .email
        .trim()
        .parse()
        .map_err(|_| Error::Said(Say::InvalidAddress { email: a.email.clone() }))?;
    Ok(Mailbox::new(a.name.clone().filter(|n| !n.trim().is_empty()), email))
}

fn text_part(text: String) -> SinglePart {
    SinglePart::builder()
        .header(ContentType::TEXT_PLAIN)
        .header(ContentTransferEncoding::QuotedPrintable)
        .body(text)
}

fn html_part(html: String) -> SinglePart {
    SinglePart::builder()
        .header(ContentType::TEXT_HTML)
        .header(ContentTransferEncoding::QuotedPrintable)
        .body(html)
}

/// The letter as it is kept: the copy in the Drafts folder, the one that comes back into
/// the window. Its plain part carries the pictures as they are, so the draft opens with
/// them.
pub fn build(draft: &Draft) -> Result<Message> {
    build_with(draft, false)
}

/// The letter as it goes out: the plain part stands for the pictures of the text, so a
/// reader without HTML sees a picture as a picture and not as a service address.
pub fn build_sent(draft: &Draft) -> Result<Message> {
    build_with(draft, true)
}

fn build_with(draft: &Draft, sent: bool) -> Result<Message> {
    let from = draft.from.as_ref().ok_or(Error::Said(Say::NoSender))?;
    if draft.to.is_empty() && draft.cc.is_empty() && draft.bcc.is_empty() {
        return Err(Error::Said(Say::NoRecipients));
    }
    let domain = from
        .email
        .rsplit_once('@')
        .map(|(_, d)| d.trim())
        .filter(|d| !d.is_empty())
        .unwrap_or("localhost");
    let message_id = format!(
        "<{}.{}@{domain}>",
        chrono::Utc::now().timestamp_millis(),
        random_token()
    );
    let mut builder = Message::builder()
        .from(mailbox(from)?)
        .subject(draft.subject.clone())
        .message_id(Some(message_id))
        .date_now();
    builder = importance_headers(builder, draft.importance);
    for a in &draft.to {
        builder = builder.to(mailbox(a)?);
    }
    for a in &draft.cc {
        builder = builder.cc(mailbox(a)?);
    }
    for a in &draft.bcc {
        builder = builder.bcc(mailbox(a)?);
    }
    if let Some(id) = &draft.in_reply_to {
        builder = builder.in_reply_to(angle(id));
    }
    if !draft.references.is_empty() {
        builder = builder.references(draft.references.iter().map(|r| angle(r)).collect::<Vec<_>>().join(" "));
    }

    let (plain, rest) = alternatives(draft, sent);
    let body = if rest.is_empty() {
        Part::One(plain)
    } else {
        let alternative = MultiPart::alternative().singlepart(plain);
        Part::Many(rest.into_iter().fold(alternative, |m, part| part.add_to(m)))
    };
    let message = if draft.attachments.is_empty() {
        match body {
            Part::One(part) => builder.singlepart(part),
            Part::Many(parts) => builder.multipart(parts),
        }
    } else {
        let mut mixed = body.add_to(MultiPart::mixed().build());
        for a in &draft.attachments {
            let ct = ContentType::parse(&a.mime).unwrap_or_else(|_| literal_type("application/octet-stream"));
            mixed = mixed.singlepart(Attachment::new(a.name.clone()).body(a.data.clone(), ct));
        }
        builder.multipart(mixed)
    };
    message.map_err(|e| Error::Compose(e.to_string()))
}

/// A body part: one part, or parts of their own (`multipart/…`).
enum Part {
    One(SinglePart),
    Many(MultiPart),
}

impl Part {
    fn add_to(self, to: MultiPart) -> MultiPart {
        match self {
            Part::One(part) => to.singlepart(part),
            Part::Many(parts) => to.multipart(parts),
        }
    }
}

/// The letter's text in every form it goes out in: the plain one, then the others in
/// the order `multipart/alternative` wants them, the sender's favourite last (RFC 2046).
///
/// A letter written in Markdown also carries the Markdown itself (RFC 7763), before the
/// HTML: a reader picks the last part it can show, and RFC 2046 lets a client show an
/// unknown `text/*` subtype as plain text, so a Markdown part last would put the bare
/// markup in front of everyone whose client draws HTML. Clients that know Markdown find
/// it anywhere among the parts.
fn alternatives(draft: &Draft, sent: bool) -> (SinglePart, Vec<Part>) {
    let mut rest = Vec::new();
    let (plain, html, images) = match draft.format {
        BodyFormat::Markdown => {
            // A Markdown letter carries its pictures in the letter itself (decision on #45):
            // they leave the Markdown as parts, the plain and Markdown parts and the HTML it
            // renders to alike calling them by `cid:`. Its signature (#67) is one HTML block
            // that the HTML part shows as it is and the other two as their own versions.
            let (plain, markdown, html, images) = markdown_letter(draft);
            rest.push(Part::One(markdown_part(markdown)));
            // The plain part of the letter that goes out stands for the pictures: a reader
            // without HTML would see a service address or a base64 wall where a picture is.
            // The copy in the Drafts folder keeps them: it opens with the picture in it.
            let plain = if sent {
                pictures_as_words(&plain, &draft.picture_word)
            } else {
                plain
            };
            (text_part(plain), Some(html), images)
        }
        _ => (
            text_part(draft.text.clone()),
            draft.html.as_deref().map(crate::message::compose_html),
            Vec::new(),
        ),
    };
    rest.extend(html.map(|html| html_body(&html, images)));
    (plain, rest)
}

/// The pictures of a Markdown text stood for by the word, in the plain part: `![alt](cid:…)`
/// and `![alt](data:…)` become «[Picture]» or «[Picture: alt]». A picture of the letter
/// outside (`https:`) stands for the word too, and its address stands after it as a link
/// stands in the text part («text <address>»): the reader without HTML may follow it.
///
/// The word is the one the caller brings (`Draft::picture_word`); the core knows no
/// language, and an empty word is the English one.
fn pictures_as_words(text: &str, word: &str) -> String {
    const START: &str = "![";
    let word = if word.trim().is_empty() { "Picture" } else { word.trim() };
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(START) {
        let image = &rest[at..];
        // The alt is one line without brackets, the address what stands up to ")".
        let open = image[START.len()..]
            .find("](")
            .map(|i| i + START.len())
            .filter(|&mid| !image[START.len()..mid].contains(['\n', '[']));
        let Some(mid) = open else {
            out.push_str(&rest[..at + START.len()]);
            rest = &image[START.len()..];
            continue;
        };
        let Some(close) = image[mid + 2..].find(')').map(|i| i + mid + 2) else {
            out.push_str(&rest[..at + START.len()]);
            rest = &image[START.len()..];
            continue;
        };
        let alt = image[START.len()..mid].trim();
        let url = image[mid + 2..close].trim();
        out.push_str(&rest[..at]);
        out.push('[');
        out.push_str(word);
        if !alt.is_empty() {
            out.push_str(": ");
            out.push_str(alt);
        }
        out.push(']');
        // The address of the letter's own picture is a service address: nothing to follow.
        if !is_own_picture(url) {
            out.push_str(&format!(" <{url}>"));
        }
        rest = &image[close + 1..];
    }
    out.push_str(rest);
    out
}

/// A picture the letter carries itself: a part of its own (`cid:`) or its bytes (`data:`).
fn is_own_picture(url: &str) -> bool {
    let url = url.to_ascii_lowercase();
    url.starts_with("cid:") || url.starts_with("data:")
}

/// The three forms a Markdown letter goes out in — plain text, the Markdown itself and the
/// HTML it renders to — with the pictures of the text, the quote and the signature as parts
/// of their own. The signature (decision on #67) is one HTML block: the HTML part shows it
/// as it is, the Markdown and plain parts carry a paraphrase and its text, and its pictures
/// share one `cid:` with the HTML.
fn markdown_letter(draft: &Draft) -> (String, String, String, Vec<InlineImage>) {
    let Some(signature) = draft.signature.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        let (markdown, images) = inline_markdown_images(&draft.text);
        let cids: Vec<String> = images.iter().map(|i| i.cid.clone()).collect();
        let html = crate::message::markdown_html_keeping(&markdown, &cids);
        return (markdown.clone(), markdown, html, images);
    };
    let mut images = Vec::new();
    let (head, sig_text, quote) = split_plain(&draft.text);
    let head_md = inline_markdown_images_in(head, &mut images);
    let quote_md = inline_markdown_images_in(quote, &mut images);
    // The signature's pictures leave it once, so the HTML and the Markdown call one part.
    let sig_html = inline_images_in(signature, &mut images);
    let sig_md = signature_markdown(&sig_html);
    let cids: Vec<String> = images.iter().map(|i| i.cid.clone()).collect();
    let block = |body: &str| {
        if body.trim().is_empty() {
            String::new()
        } else {
            format!("\n\n-- \n{body}")
        }
    };
    let plain = format!("{head_md}{}{quote_md}", block(sig_text.unwrap_or("")));
    let markdown = format!("{head_md}{}{quote_md}", block(&sig_md));
    let html = format!(
        "{}{}{}",
        crate::message::markdown_html_keeping(&head_md, &cids),
        signature_html_block(&sig_html, &images),
        crate::message::markdown_html_keeping(&quote_md, &cids)
    );
    (plain, markdown, html, images)
}

/// The signature's HTML as a block of the letter, its pictures called by `cid:`.
fn signature_html_block(html: &str, images: &[InlineImage]) -> String {
    if html.trim().is_empty() {
        return String::new();
    }
    let inline: std::collections::HashMap<String, String> = images
        .iter()
        .map(|i| (i.cid.clone(), format!("cid:{}", i.cid)))
        .collect();
    crate::message::sanitize_html(
        &format!("<div class=\"depesha-signature\">{html}</div>"),
        &inline,
        false,
    )
    .0
}

/// A plain-text or Markdown letter as what is typed, the signature under `-- ` and what
/// follows it (the quote of a reply or the forwarded letter). `body + "\n\n-- \n" + sig +
/// rest` is the letter again, as the frontend's `splitPlain` has it.
fn split_plain(text: &str) -> (&str, Option<&str>, &str) {
    let quoted = &text[..quote_at(text).unwrap_or(text.len())];
    let at = forward_at(quoted).unwrap_or(quoted.len());
    let head = &text[..at];
    let rest = &text[at..];
    if let Some(sep) = head.rfind("\n\n-- \n") {
        return (&head[..sep], Some(&head[sep + 6..]), rest);
    }
    if let Some(sig) = head.strip_prefix("-- \n") {
        return ("", Some(sig), rest);
    }
    (head, None, rest)
}

/// Where the quote of a reply begins: the "… wrote:" line with only ">" lines under it.
fn quote_at(text: &str) -> Option<usize> {
    let lines: Vec<&str> = text.split('\n').collect();
    for i in 0..lines.len().saturating_sub(1) {
        let line = lines[i];
        let header = !line.trim().is_empty()
            && !line.starts_with('>')
            && line.trim_end().ends_with(':')
            && lines[i + 1].starts_with('>');
        if header && lines[i + 1..].iter().all(|l| l.starts_with('>') || l.trim().is_empty()) {
            // The empty lines above the header go with the quote.
            let mut start: usize = lines[..i].iter().map(|l| l.len() + 1).sum();
            while start > 0 && text.as_bytes()[start - 1] == b'\n' {
                start -= 1;
            }
            return Some(start);
        }
    }
    None
}

/// Where a forwarded letter begins: its header line and the empty lines above it.
fn forward_at(head: &str) -> Option<usize> {
    ["-------- Пересылаемое сообщение", "-------- Forwarded message"]
        .iter()
        .filter_map(|needle| head.find(needle))
        .min()
        .map(|i| {
            let mut at = head[..i].rfind('\n').map_or(0, |p| p + 1);
            while at > 0 && head.as_bytes()[at - 1] == b'\n' {
                at -= 1;
            }
            at
        })
}

/// The Markdown a letter was written in (RFC 7763, the variant by RFC 7764).
fn markdown_part(text: String) -> SinglePart {
    SinglePart::builder()
        .header(literal_type(MARKDOWN_TYPE))
        .header(ContentTransferEncoding::QuotedPrintable)
        .body(text)
}

/// The Content-Type of a letter's Markdown part.
pub const MARKDOWN_TYPE: &str = "text/markdown; charset=utf-8; variant=GFM";

/// The HTML of a letter as it goes out: `text/html` alone, or `multipart/related` with
/// the pictures of the HTML as parts of their own that it calls by `cid:`. Every picture
/// of the letter comes this way, those of the text and of the signature alike: the
/// composer puts them into the HTML as `data:` images, and here they become parts. A
/// Markdown letter's pictures arrive already taken out of its Markdown (`extra`).
fn html_body(html: &str, extra: Vec<InlineImage>) -> Part {
    let (html, mut images) = inline_images(html);
    images.extend(extra);
    let part = html_part(html_document(&html));
    if images.is_empty() {
        return Part::One(part);
    }
    let related = MultiPart::related().singlepart(part);
    Part::Many(images.into_iter().enumerate().fold(related, |m, (i, image)| {
        let ct = ContentType::parse(&image.mime).unwrap_or_else(|_| literal_type("image/png"));
        let name = format!("image{}.{}", i + 1, image.extension());
        m.singlepart(Attachment::new_inline_with_name(image.cid, name).body(image.data, ct))
    }))
}

/// A whole HTML document around the letter: clients that show the part as a page get its charset.
fn html_document(body: &str) -> String {
    format!("<!DOCTYPE html>\r\n<html><head><meta charset=\"utf-8\"></head><body>{body}</body></html>\r\n")
}

/// A picture inside the letter, sent as a part of its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineImage {
    /// The `Content-ID`, without angle brackets: the HTML calls it `cid:<cid>`.
    pub cid: String,
    pub mime: String,
    pub data: Vec<u8>,
}

impl InlineImage {
    fn extension(&self) -> &'static str {
        match self.mime.as_str() {
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            _ => "png",
        }
    }
}

/// Pictures the HTML carries as `data:` images, the kinds every mail program shows.
const INLINE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Takes the `data:` pictures out of the cleaned HTML: each `<img src="data:image/…;base64,…">`
/// gets a `cid:` link and the picture becomes an [`InlineImage`]. The same picture twice
/// (a logo) is one part. Anything else stays as it was.
pub fn inline_images(html: &str) -> (String, Vec<InlineImage>) {
    let mut images = Vec::new();
    let html = inline_images_in(html, &mut images);
    (html, images)
}

/// The [`InlineImage`] a `data:` picture becomes, one part per picture: the same picture
/// twice (a logo) is one part, whatever part of the letter it stands in.
fn cid_for(images: &mut Vec<InlineImage>, mime: String, data: Vec<u8>) -> String {
    if let Some(same) = images.iter().find(|i| i.mime == mime && i.data == data) {
        return same.cid.clone();
    }
    let cid = format!("{}@depesha", random_token());
    images.push(InlineImage {
        cid: cid.clone(),
        mime,
        data,
    });
    cid
}

/// [`inline_images`], the pictures added to the letter's own (`images`): a picture of the
/// text, the quote and the signature shares one part with the same picture elsewhere.
fn inline_images_in(html: &str, images: &mut Vec<InlineImage>) -> String {
    const START: &str = "src=\"data:";
    let mut out = String::with_capacity(html.len().min(64 * 1024));
    let mut rest = html;
    while let Some(at) = rest.find(START) {
        let value = &rest[at + START.len()..];
        let Some(end) = value.find('"') else { break };
        let parsed = value[..end].split_once(";base64,").and_then(|(mime, data)| {
            let mime = mime.trim().to_ascii_lowercase();
            let data: String = data.chars().filter(|c| !c.is_ascii_whitespace()).collect();
            INLINE_TYPES.contains(&mime.as_str()).then_some(())?;
            Some((mime, BASE64.decode(data).ok()?))
        });
        out.push_str(&rest[..at]);
        match parsed {
            Some((mime, data)) => {
                let cid = cid_for(images, mime, data);
                out.push_str(&format!("src=\"cid:{cid}\""));
            }
            None => out.push_str(&rest[at..at + START.len() + end + 1]),
        }
        rest = &value[end + 1..];
    }
    out.push_str(rest);
    out
}

/// A media type written in this file as a literal.
#[allow(
    clippy::expect_used,
    reason = "the literals passed are valid media types; `literal_types_parse` tries each"
)]
fn literal_type(text: &str) -> ContentType {
    ContentType::parse(text).expect("valid mime")
}

fn random_token() -> String {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut bytes = [0u8; 12];
    #[allow(
        clippy::expect_used,
        reason = "the system's random source is what TLS stands on: a host without it cannot run the app at all"
    )]
    SystemRandom::new().fill(&mut bytes).expect("system RNG");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The pictures a Markdown letter carries, taken out of its Markdown and turned into parts
/// of their own (decision on #45): `![alt](data:image/…;base64,…)` becomes `![alt](cid:…)`
/// and an [`InlineImage`], so Depesha's own reader finds them and the HTML it renders to
/// shows them. The same picture twice (a logo) is one part. Foreign links stay as they are.
fn inline_markdown_images(text: &str) -> (String, Vec<InlineImage>) {
    let mut images = Vec::new();
    let text = inline_markdown_images_in(text, &mut images);
    (text, images)
}

/// [`inline_markdown_images`], the pictures added to the letter's own (`images`).
fn inline_markdown_images_in(text: &str, images: &mut Vec<InlineImage>) -> String {
    const START: &str = "](data:image/";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(START) {
        let value = &rest[at + 2..]; // past "]("
        let Some(end) = value.find(')') else { break };
        let url = &value[..end];
        let parsed = url.split_once(";base64,").and_then(|(mime, data)| {
            let mime = mime.trim_start_matches("data:").trim().to_ascii_lowercase();
            let data: String = data.chars().filter(|c| !c.is_ascii_whitespace()).collect();
            INLINE_TYPES.contains(&mime.as_str()).then_some(())?;
            Some((mime, BASE64.decode(data).ok()?))
        });
        out.push_str(&rest[..at + 1]);
        match parsed {
            Some((mime, data)) => {
                let cid = cid_for(images, mime, data);
                out.push_str(&format!("(cid:{cid}"));
            }
            None => out.push_str(&rest[at + 1..at + 2 + end]),
        }
        rest = &value[end..];
    }
    out.push_str(rest);
    out
}

/// The signature's HTML as Markdown (decision on #67): bold, italic, links, line breaks and
/// pictures; everything else becomes text. `html` already calls its pictures by `cid:`.
pub fn signature_markdown(html: &str) -> String {
    let mut out = String::new();
    let mut link: Option<String> = None;
    for tok in signature_tokens(html) {
        match tok {
            SigTok::Text(text) => push_words(&mut out, &decode_entities(text)),
            SigTok::Tag { name, close, attrs } => match name.as_str() {
                "br" => end_line(&mut out, true),
                "div" | "p" | "tr" => end_line(&mut out, false),
                "b" | "strong" => out.push_str("**"),
                "i" | "em" => out.push('*'),
                "a" if !close => {
                    link = attr(attrs, "href").map(str::to_owned);
                    out.push('[');
                }
                "a" => {
                    if let Some(href) = link.take() {
                        out.push_str(&format!("]({href})"));
                    }
                }
                "img" if !close => {
                    let alt = attr(attrs, "alt").unwrap_or("");
                    let src = attr(attrs, "src").unwrap_or("");
                    if !src.is_empty() {
                        out.push_str(&format!("![{alt}]({src})"));
                    }
                }
                _ => {}
            },
        }
    }
    while out.ends_with([' ', '\n']) {
        out.pop();
    }
    out
}

/// A text or a tag of the signature, in order. Bold and italic are symbol pairs, so an open
/// and a close push alike; a picture and a link are read from the tag itself.
enum SigTok<'a> {
    Text(&'a str),
    Tag { name: String, close: bool, attrs: &'a str },
}

fn signature_tokens(html: &str) -> Vec<SigTok<'_>> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(at) = rest.find('<') {
        if at > 0 {
            out.push(SigTok::Text(&rest[..at]));
        }
        let after = &rest[at + 1..];
        let Some(end) = after.find('>') else { break };
        let inner = &after[..end];
        let close = inner.starts_with('/');
        let inner = inner.trim_start_matches('/');
        let name_end = inner
            .find(|c: char| c.is_whitespace() || c == '/')
            .unwrap_or(inner.len());
        let name = &inner[..name_end];
        if name.starts_with(|c: char| c.is_ascii_alphabetic()) {
            out.push(SigTok::Tag {
                name: name.to_ascii_lowercase(),
                close,
                attrs: &inner[name_end..],
            });
        }
        rest = &after[end + 1..];
    }
    if !rest.is_empty() {
        out.push(SigTok::Text(rest));
    }
    out
}

/// An attribute of a tag, its value unquoted: `<a href="…">` gives `…` for `href`.
fn attr<'a>(attrs: &'a str, name: &str) -> Option<&'a str> {
    let mut rest = attrs;
    while let Some(at) = rest.find(name) {
        let before_ok = at == 0 || !rest.as_bytes()[at - 1].is_ascii_alphanumeric();
        if before_ok {
            let value = rest[at + name.len()..].trim_start();
            if let Some(value) = value.strip_prefix('=') {
                let value = value.trim_start();
                let quote = value.chars().next().filter(|c| *c == '"' || *c == '\'');
                return Some(match quote {
                    Some(q) => value[1..].split(q).next().unwrap_or(""),
                    None => value.split_whitespace().next().unwrap_or(""),
                });
            }
        }
        rest = &rest[at + name.len()..];
    }
    None
}

/// A line break in the Markdown: `<br>` is a hard break, two spaces at the line's end.
fn end_line(out: &mut String, hard: bool) {
    while out.ends_with(' ') {
        out.pop();
    }
    if out.is_empty() || out.ends_with('\n') {
        return;
    }
    if hard {
        out.push_str("  ");
    }
    out.push('\n');
}

/// Text with its whitespace run as single spaces, no space where the line already has one.
fn push_words(out: &mut String, raw: &str) {
    let mut text = String::new();
    for c in raw.chars() {
        if c.is_whitespace() {
            if !text.ends_with(' ') {
                text.push(' ');
            }
        } else {
            text.push(c);
        }
    }
    if text.is_empty() {
        return;
    }
    if text.starts_with(' ') && (out.is_empty() || out.ends_with([' ', '\n', '['])) {
        text.remove(0);
    }
    out.push_str(&text);
}

/// The character references a signature may carry; anything else stays as it was.
fn decode_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn angle(id: &str) -> String {
    let id = id.trim();
    if id.starts_with('<') {
        id.to_owned()
    } else {
        format!("<{id}>")
    }
}

/// What the server announced in EHLO, after STARTTLS when it was used.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SmtpCaps {
    pub starttls: bool,
    pub auth: Vec<String>,
    pub size: Option<u64>,
}

#[derive(Debug)]
struct Reply {
    code: u16,
    lines: Vec<String>,
}

impl Reply {
    fn text(&self) -> String {
        self.lines.join(" ")
    }

    fn into_error(self) -> Error {
        let text = self.text();
        let enhanced = text
            .split_whitespace()
            .next()
            .filter(|t| t.len() >= 5 && t.split('.').count() == 3 && t.split('.').all(|p| p.parse::<u16>().is_ok()))
            .map(str::to_owned);
        Error::Smtp {
            code: self.code,
            enhanced,
            message: text,
        }
    }
}

struct Conn {
    stream: BufStream<Box<dyn Io>>,
    /// How we introduce ourselves in EHLO.
    name: String,
}

impl Conn {
    async fn reply(&mut self) -> Result<Reply> {
        let mut lines = Vec::new();
        loop {
            let mut line = String::new();
            let n = timeout(REPLY_TIMEOUT, self.stream.read_line(&mut line))
                .await
                .map_err(|_| Error::Timeout("SMTP answer"))??;
            if n == 0 {
                return Err(Error::Closed);
            }
            let line = line.trim_end_matches(['\r', '\n']);
            let code = line
                .get(..3)
                .and_then(|c| c.parse::<u16>().ok())
                .ok_or_else(|| Error::Protocol(line.into()))?;
            let more = line.as_bytes().get(3) == Some(&b'-');
            lines.push(line.get(4..).unwrap_or_default().to_owned());
            if !more {
                return Ok(Reply { code, lines });
            }
        }
    }

    async fn command(&mut self, line: &str) -> Result<Reply> {
        self.stream.write_all(line.as_bytes()).await?;
        self.stream.write_all(b"\r\n").await?;
        self.stream.flush().await?;
        self.reply().await
    }

    async fn expect(&mut self, line: &str, ok: &[u16]) -> Result<Reply> {
        let reply = self.command(line).await?;
        if ok.contains(&reply.code) {
            Ok(reply)
        } else {
            Err(reply.into_error())
        }
    }

    async fn ehlo(&mut self) -> Result<SmtpCaps> {
        let reply = self.command(&format!("EHLO {}", self.name)).await?;
        // Some servers refuse a client by its EHLO name; that is not a policy on the message.
        if reply.code != 250 {
            return Err(Error::SmtpHello {
                name: self.name.clone(),
                code: reply.code,
                message: reply.text(),
            });
        }
        let mut caps = SmtpCaps::default();
        for line in reply.lines.iter().skip(1) {
            let mut words = line.split_whitespace();
            match words.next().map(str::to_ascii_uppercase).as_deref() {
                Some("STARTTLS") => caps.starttls = true,
                Some("AUTH") => caps.auth.extend(words.map(str::to_ascii_uppercase)),
                Some("SIZE") => caps.size = words.next().and_then(|s| s.parse().ok()).filter(|s| *s > 0),
                _ => {}
            }
        }
        caps.auth.dedup();
        Ok(caps)
    }
}

/// The EHLO name: the host's full domain name, otherwise our address as a literal,
/// as Thunderbird does. Never `localhost`: sendmail answers it with
/// "550 5.7.1 Sender unknown", and Windows has no /etc/hostname to read.
fn ehlo_name(hostname: Option<&str>, local: Option<SocketAddr>) -> String {
    if let Some(h) = hostname.map(str::trim)
        && h.contains('.')
        && !h.starts_with('.')
        && !h.ends_with('.')
        && !h.to_ascii_lowercase().starts_with("localhost")
        && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
    {
        return h.to_owned();
    }
    match local.map(|a| a.ip()) {
        Some(IpAddr::V4(ip)) => format!("[{ip}]"),
        Some(IpAddr::V6(ip)) => match ip.to_ipv4_mapped() {
            Some(v4) => format!("[{v4}]"),
            None => format!("[IPv6:{ip}]"),
        },
        None => "[127.0.0.1]".into(),
    }
}

fn hostname() -> Option<String> {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
}

/// Where an attempt stands, named for a log the caller writes once it settles — set as each
/// step starts, so a failure is placed where it actually happened (`open`, `send_with_stage`),
/// never guessed from the kind of error afterwards (a dropped connection reads the same at the
/// greeting as at DATA). A `Mutex`, not a `Cell`: a plain `Cell` is not `Sync`, and Tauri
/// commands need their future `Send` across the `.await` this is held over.
#[derive(Debug)]
pub struct Stage(std::sync::Mutex<&'static str>);

impl Stage {
    pub fn new() -> Self {
        Self(std::sync::Mutex::new("connect"))
    }

    pub(crate) fn set(&self, value: &'static str) {
        *crate::lock::lock(&self.0) = value;
    }

    /// The step the attempt last entered, once it is done with this: `"connect"` until the
    /// first step actually starts.
    pub fn get(&self) -> &'static str {
        *crate::lock::lock(&self.0)
    }
}

impl Default for Stage {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolves and connects within one budget (`CONNECT_TIMEOUT`, as before): a dead address
/// among several (IPv6 with no route, a port a firewall drops) used to eat the whole budget
/// by itself, with nothing in the log to say so. The addresses the resolver gave are logged
/// on failure — IPs only, never anything about the letter — so a network that blocks the
/// server can be told apart from one that is simply down.
async fn connect(server: &ServerConfig) -> Result<TcpStream> {
    let attempt = async {
        let addrs: Vec<SocketAddr> = tokio::net::lookup_host((server.host.as_str(), server.port))
            .await?
            .collect();
        let tcp = TcpStream::connect(addrs.as_slice()).await;
        Ok::<_, std::io::Error>((addrs, tcp))
    };
    match timeout(CONNECT_TIMEOUT, attempt).await {
        Err(_) => {
            tracing::warn!(host = %server.host, port = server.port, stage = "connect", "smtp: the server did not answer in time");
            Err(Error::Timeout("connecting"))
        }
        Ok(Err(e)) => {
            tracing::warn!(host = %server.host, port = server.port, stage = "resolve", error = %e, "smtp: could not resolve the server");
            Err(e.into())
        }
        Ok(Ok((_, Ok(tcp)))) => Ok(tcp),
        Ok(Ok((addrs, Err(e)))) => {
            let tried: Vec<String> = addrs.iter().map(|a| a.ip().to_string()).collect();
            tracing::warn!(host = %server.host, port = server.port, stage = "connect", addrs = ?tried, error = %e, "smtp: could not connect");
            Err(e.into())
        }
    }
}

/// A failure of the attempt, logged where it actually happened: never guessed from the kind
/// of error afterwards, which cannot tell a dropped connection at the greeting from one at
/// DATA. The server, the step and the numbers are the log's; the reply's own words — which may
/// quote the recipient, the login or the greeting — are the user's to read.
fn log_stage(server: &ServerConfig, stage: &'static str, error: &Error) {
    tracing::warn!(
        host = %server.host,
        port = server.port,
        stage,
        kind = error.kind().as_str(),
        error = error.journal(),
        "smtp: attempt failed"
    );
}

/// Connects, upgrades to TLS as configured and logs in when credentials are given. `stage` is
/// set as each step starts, for a caller that logs a failure to say where it happened.
async fn open(server: &ServerConfig, creds: Option<&Credentials>, stage: &Stage) -> Result<(Conn, SmtpCaps)> {
    stage.set("connect");
    let tcp = connect(server).await?;
    crate::net::keepalive(&tcp);
    let pinned = server.trusted_cert.as_deref();
    let name = ehlo_name(hostname().as_deref(), tcp.local_addr().ok());
    stage.set("tls");
    let stream: Box<dyn Io> = match server.security {
        Security::Tls => Box::new(
            tls::wrap(&server.host, pinned, tcp)
                .await
                .inspect_err(|e| log_stage(server, "tls", e))?,
        ),
        Security::StartTls | Security::Plain => Box::new(tcp),
    };
    let mut conn = Conn {
        stream: BufStream::new(stream),
        name,
    };
    stage.set("greeting");
    let greeting = match timeout(CONNECT_TIMEOUT, conn.reply()).await {
        Err(_) => {
            let e = Error::Timeout("server greeting");
            log_stage(server, "greeting", &e);
            return Err(e);
        }
        Ok(Err(e)) => {
            log_stage(server, "greeting", &e);
            return Err(e);
        }
        Ok(Ok(reply)) => reply,
    };
    if greeting.code != 220 {
        let e = greeting.into_error();
        log_stage(server, "greeting", &e);
        return Err(e);
    }
    stage.set("ehlo");
    let mut caps = conn.ehlo().await.inspect_err(|e| log_stage(server, "ehlo", e))?;

    if server.security == Security::StartTls {
        stage.set("tls");
        if !caps.starttls {
            let e = Error::NoTls;
            log_stage(server, "tls", &e);
            return Err(e);
        }
        conn.expect("STARTTLS", &[220])
            .await
            .inspect_err(|e| log_stage(server, "tls", e))?;
        let plain = conn.stream.into_inner();
        let secured: Box<dyn Io> = Box::new(
            tls::wrap(&server.host, pinned, plain)
                .await
                .inspect_err(|e| log_stage(server, "tls", e))?,
        );
        conn = Conn {
            stream: BufStream::new(secured),
            name: conn.name,
        };
        stage.set("ehlo");
        caps = conn.ehlo().await.inspect_err(|e| log_stage(server, "ehlo", e))?;
    }

    if let Some(creds) = creds {
        stage.set("auth");
        login(&mut conn, &caps, creds)
            .await
            .inspect_err(|e| log_stage(server, "auth", e))?;
    }
    Ok((conn, caps))
}

async fn login(conn: &mut Conn, caps: &SmtpCaps, creds: &Credentials) -> Result<()> {
    let has = |m: &str| caps.auth.iter().any(|a| a == m);
    let auth_err = |reply: Reply| match reply.code {
        535 | 534 | 530 => Error::Auth(reply.text()),
        _ => reply.into_error(),
    };
    // Gmail, Yandex and Microsoft all take XOAUTH2; try it even when EHLO forgets to list it.
    if let Some(initial) = creds.xoauth2() {
        let reply = conn
            .command(&format!("AUTH XOAUTH2 {}", BASE64.encode(initial)))
            .await?;
        return match reply.code {
            235 => Ok(()),
            // The error comes as a base64 JSON challenge; an empty answer ends the exchange.
            334 => {
                let detail = BASE64
                    .decode(reply.text().trim())
                    .ok()
                    .and_then(|j| crate::imap::xoauth2_error(&j));
                let last = conn.command("").await?;
                let mut err = auth_err(last);
                if let (Error::Auth(m), Some(d)) = (&mut err, detail) {
                    err = Error::Said(Say::AuthDetail {
                        message: std::mem::take(m),
                        detail: d,
                    });
                }
                Err(err)
            }
            _ => Err(auth_err(reply)),
        };
    }
    if has("PLAIN") {
        let token = BASE64.encode(format!("\0{}\0{}", creds.username, creds.password()));
        let reply = conn.command(&format!("AUTH PLAIN {token}")).await?;
        return if reply.code == 235 {
            Ok(())
        } else {
            Err(auth_err(reply))
        };
    }
    if has("LOGIN") {
        let steps = [
            "AUTH LOGIN".to_owned(),
            BASE64.encode(&creds.username),
            BASE64.encode(creds.password()),
        ];
        for (i, step) in steps.iter().enumerate() {
            let reply = conn.command(step).await?;
            let expected = if i < 2 { 334 } else { 235 };
            if reply.code != expected {
                return Err(auth_err(reply));
            }
        }
        return Ok(());
    }
    if caps.auth.is_empty() {
        Err(Error::AuthMechanism(String::new()))
    } else {
        Err(Error::AuthMechanism(caps.auth.join(" ")))
    }
}

/// Checks that an SMTP server answers with the configured security, without logging in.
pub async fn probe(server: &ServerConfig) -> Result<SmtpCaps> {
    let (mut conn, caps) = open(server, None, &Stage::new()).await?;
    best_effort("say QUIT", conn.command("QUIT").await);
    Ok(caps)
}

/// Checks connection, TLS and login without sending anything.
pub async fn check(server: &ServerConfig, creds: &Credentials) -> Result<SmtpCaps> {
    let (mut conn, caps) = open(server, Some(creds), &Stage::new()).await?;
    best_effort("say QUIT", conn.command("QUIT").await);
    Ok(caps)
}

/// Sends the message and returns its RFC 822 bytes for the Sent folder.
pub async fn send(server: &ServerConfig, creds: &Credentials, message: &Message) -> Result<Vec<u8>> {
    send_with_stage(server, creds, message, &Stage::new()).await
}

/// Like `send`, but also tells the caller which step the attempt reached when it failed:
/// `stage` is set as each one starts, so the caller (the outbox, naming the mailbox) can log
/// where the trouble was without guessing from the kind of error — a dropped connection reads
/// the same at the greeting as at DATA.
pub async fn send_with_stage(
    server: &ServerConfig,
    creds: &Credentials,
    message: &Message,
    stage: &Stage,
) -> Result<Vec<u8>> {
    let envelope = message.envelope();
    let from = envelope.from().map(|a| a.to_string()).unwrap_or_default();
    let raw = message.formatted();

    let (mut conn, caps) = open(server, Some(creds), stage).await?;
    if let Some(limit) = caps.size
        && raw.len() as u64 > limit
    {
        return Err(Error::TooLarge { size: raw.len(), limit });
    }
    let size = if caps.size.is_some() {
        format!(" SIZE={}", raw.len())
    } else {
        String::new()
    };
    stage.set("send");
    conn.expect(&format!("MAIL FROM:<{from}>{size}"), &[250])
        .await
        .inspect_err(|e| log_stage(server, "send", e))?;
    for rcpt in envelope.to() {
        conn.expect(&format!("RCPT TO:<{rcpt}>"), &[250, 251])
            .await
            .inspect_err(|e| log_stage(server, "send", e))?;
    }
    conn.expect("DATA", &[354])
        .await
        .inspect_err(|e| log_stage(server, "send", e))?;
    let reply = match data(&mut conn, &raw).await {
        Ok(reply) => reply,
        Err(e) => {
            log_stage(server, "send", &e);
            return Err(e);
        }
    };
    if reply.code != 250 {
        let e = reply.into_error();
        log_stage(server, "send", &e);
        return Err(e);
    }
    best_effort("say QUIT", conn.command("QUIT").await);
    Ok(raw)
}

/// Writes the message body and reads the reply that settles it: one step, so a dropped
/// connection partway through is one failure of «send», not of «write» or «read» apart.
async fn data(conn: &mut Conn, raw: &[u8]) -> Result<Reply> {
    conn.stream.write_all(&dot_stuff(raw)).await?;
    conn.stream.flush().await?;
    conn.reply().await
}

/// Escapes leading dots and appends the end-of-data marker (RFC 5321, 4.5.2).
fn dot_stuff(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() + 64);
    let mut line_start = true;
    for &b in raw {
        if line_start && b == b'.' {
            out.push(b'.');
        }
        out.push(b);
        line_start = b == b'\n';
    }
    if !out.ends_with(b"\r\n") {
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b".\r\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_sink::logged;

    #[test]
    fn literal_types_parse() {
        for text in ["application/octet-stream", "image/png", MARKDOWN_TYPE] {
            drop(literal_type(text));
        }
    }
    use crate::domain::OutgoingAttachment;

    fn addr(email: &str) -> Addr {
        Addr {
            name: None,
            email: email.into(),
        }
    }

    #[test]
    fn builds_reply_with_attachment() {
        let draft = Draft {
            from: Some(Addr {
                name: Some("Влад".into()),
                email: "me@example.org".into(),
            }),
            to: vec![addr("you@example.org")],
            bcc: vec![addr("hidden@example.org")],
            subject: "Re: Привет".into(),
            text: "Текст".into(),
            in_reply_to: Some("m1@example.org".into()),
            references: vec!["m0@example.org".into(), "<m1@example.org>".into()],
            attachments: vec![OutgoingAttachment {
                name: "a.txt".into(),
                mime: "text/plain".into(),
                data: b"hi".to_vec(),
            }],
            ..Default::default()
        };
        let message = build(&draft).unwrap();
        let raw = String::from_utf8(message.formatted()).unwrap();
        assert!(raw.contains("In-Reply-To: <m1@example.org>"), "{raw}");
        assert!(raw.contains("References: <m0@example.org> <m1@example.org>"), "{raw}");
        assert!(raw.contains("filename=\"a.txt\""), "{raw}");
        assert!(raw.contains("Message-ID: <"), "{raw}");
        assert!(raw.contains("Date: "), "{raw}");
        assert!(!raw.contains("hidden@example.org"), "Bcc leaked into headers: {raw}");
        assert!(raw.is_ascii(), "body must be 7-bit for servers without 8BITMIME");
        let rcpts: Vec<String> = message.envelope().to().iter().map(|a| a.to_string()).collect();
        assert!(rcpts.contains(&"hidden@example.org".to_owned()));

        let parsed = crate::message::parse_view(raw.as_bytes(), false).unwrap();
        assert_eq!(parsed.summary.subject, "Re: Привет");
        assert_eq!(parsed.text.as_deref().map(str::trim), Some("Текст"));
    }

    fn letter(format: BodyFormat, text: &str, html: Option<&str>) -> Draft {
        Draft {
            from: Some(addr("me@example.org")),
            to: vec![addr("you@example.org")],
            subject: "Формат".into(),
            text: text.into(),
            html: html.map(Into::into),
            format,
            ..Default::default()
        }
    }

    #[test]
    fn a_letter_asked_to_be_read_first_says_so_in_the_pair_outlook_writes() {
        let raw_of = |importance| {
            let draft = Draft {
                importance,
                ..letter(BodyFormat::Plain, "Срочно", None)
            };
            String::from_utf8(build(&draft).unwrap().formatted()).unwrap()
        };
        let high = raw_of(Importance::High);
        assert!(high.contains("Importance: high"), "{high}");
        assert!(high.contains("X-Priority: 1 (Highest)"), "{high}");
        // What goes out is read back as high, and a plain letter carries neither header.
        assert_eq!(
            crate::message::parse_summary(high.as_bytes()).importance,
            Importance::High
        );
        let plain = raw_of(Importance::Normal);
        assert!(
            !plain.contains("Importance:") && !plain.contains("X-Priority:"),
            "{plain}"
        );
    }

    fn content_types(raw: &str) -> Vec<String> {
        raw.lines()
            .filter_map(|l| l.strip_prefix("Content-Type: "))
            .map(|v| v.split(';').next().unwrap_or_default().trim().to_owned())
            .collect()
    }

    #[test]
    fn plain_text_goes_as_one_part() {
        let raw = String::from_utf8(build(&letter(BodyFormat::Plain, "Привет", None)).unwrap().formatted()).unwrap();
        assert_eq!(content_types(&raw), ["text/plain"], "{raw}");
    }

    #[test]
    fn html_goes_with_its_plain_version() {
        let draft = letter(
            BodyFormat::Html,
            "Привет, Боб!",
            Some("<div>Привет, <b>Боб</b>!</div><script>alert(1)</script><div onclick=\"x()\">.</div>"),
        );
        let raw = String::from_utf8(build(&draft).unwrap().formatted()).unwrap();
        assert_eq!(
            content_types(&raw),
            ["multipart/alternative", "text/plain", "text/html"],
            "{raw}"
        );
        let view = crate::message::parse_view(raw.as_bytes(), false).unwrap();
        assert_eq!(view.text.as_deref().map(str::trim), Some("Привет, Боб!"));
        let html = view.html.unwrap();
        assert!(html.contains("<b>Боб</b>"), "{html}");
        assert!(!html.contains("script") && !html.contains("onclick"), "{html}");
    }

    #[test]
    fn markdown_goes_as_is_and_rendered() {
        let text = "**жирный**\n\n- раз\n- два\n- [x] готово\n\n-- \nИван";
        let raw = String::from_utf8(build(&letter(BodyFormat::Markdown, text, None)).unwrap().formatted()).unwrap();
        // The Markdown before the HTML: a client that does not know it shows the HTML.
        assert_eq!(
            content_types(&raw),
            ["multipart/alternative", "text/plain", "text/markdown", "text/html"],
            "{raw}"
        );
        let markdown = raw
            .lines()
            .find(|l| l.starts_with("Content-Type: text/markdown"))
            .unwrap();
        assert!(
            markdown.contains("charset=utf-8") && markdown.contains("variant=GFM"),
            "{markdown}"
        );
        assert!(raw.is_ascii(), "body must be 7-bit for servers without 8BITMIME");
        let view = crate::message::parse_view(raw.as_bytes(), false).unwrap();
        assert_eq!(
            view.text.map(|t| t.replace("\r\n", "\n")).as_deref().map(str::trim_end),
            Some(text)
        );
        let html = view.html.unwrap();
        assert!(html.contains("<strong>жирный</strong>"), "{html}");
        assert!(html.contains("<ul>") && html.contains("<li>раз</li>"), "{html}");
        // A task keeps its box as a character: mail programs drop form fields.
        assert!(html.contains("<li>☑ готово</li>"), "{html}");
        // The signature keeps its line breaks.
        assert!(html.contains("--<br>"), "{html}");
        // Our own letter reads back with its Markdown, which is no attachment.
        use crate::message::BodyView;
        assert_eq!(view.views, [BodyView::Text, BodyView::Markdown, BodyView::Html]);
        assert!(view.markdown.unwrap().contains("<strong>жирный</strong>"));
        assert!(view.attachments.is_empty(), "{:?}", view.attachments);
        assert!(!view.summary.has_attachments);
    }

    #[test]
    fn only_markdown_letters_carry_markdown() {
        for (format, html) in [(BodyFormat::Plain, None), (BodyFormat::Html, Some("<p>Да</p>"))] {
            let raw = String::from_utf8(build(&letter(format, "Да", html)).unwrap().formatted()).unwrap();
            assert!(!raw.contains("text/markdown"), "{raw}");
            assert!(
                crate::message::parse_view(raw.as_bytes(), false)
                    .unwrap()
                    .markdown
                    .is_none()
            );
        }
    }

    #[test]
    fn markdown_letter_keeps_attachments_beside() {
        let mut draft = letter(BodyFormat::Markdown, "# План", None);
        draft.attachments.push(OutgoingAttachment {
            name: "план.md".into(),
            mime: "text/markdown".into(),
            data: b"# other".to_vec(),
        });
        let raw = String::from_utf8(build(&draft).unwrap().formatted()).unwrap();
        assert_eq!(
            content_types(&raw),
            [
                "multipart/mixed",
                "multipart/alternative",
                "text/plain",
                "text/markdown",
                "text/html",
                "text/markdown"
            ],
            "{raw}"
        );
        // The letter's Markdown is its text; the attached file stays a file.
        let view = crate::message::parse_view(raw.as_bytes(), false).unwrap();
        assert_eq!(view.attachments.len(), 1, "{:?}", view.attachments);
        assert_eq!(view.attachments[0].name, "план.md");
        assert!(view.markdown.unwrap().contains("<h1>План</h1>"));
        let (_, bytes) = crate::message::attachment(raw.as_bytes(), view.attachments[0].index).unwrap();
        assert_eq!(bytes, b"# other");
    }

    #[test]
    fn formatted_letter_keeps_attachments_beside() {
        let mut draft = letter(BodyFormat::Html, "Счёт", Some("<p>Счёт</p>"));
        draft.attachments.push(OutgoingAttachment {
            name: "a.txt".into(),
            mime: "text/plain".into(),
            data: b"hi".to_vec(),
        });
        let raw = String::from_utf8(build(&draft).unwrap().formatted()).unwrap();
        assert_eq!(
            content_types(&raw),
            [
                "multipart/mixed",
                "multipart/alternative",
                "text/plain",
                "text/html",
                "text/plain"
            ],
            "{raw}"
        );
    }

    const PNG: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    fn header_value<'a>(raw: &'a str, name: &str) -> Vec<&'a str> {
        raw.lines()
            .filter_map(|l| l.strip_prefix(name))
            .map(str::trim)
            .collect()
    }

    #[test]
    fn pictures_in_the_text_go_as_related_parts() {
        let html = format!(
            "<div>Зал:</div><img src=\"data:image/png;base64,{PNG}\" style=\"width:100%\"><img src=\"data:image/png;base64,{PNG}\"><img src=\"cid:foreign@example.org\">"
        );
        let draft = letter(BodyFormat::Html, "Зал:", Some(&html));
        let raw = String::from_utf8(build(&draft).unwrap().formatted()).unwrap();
        assert_eq!(
            content_types(&raw),
            [
                "multipart/alternative",
                "text/plain",
                "multipart/related",
                "text/html",
                "image/png"
            ],
            "{raw}"
        );
        // The same picture twice is one part; the HTML calls it by its Content-ID.
        let ids = header_value(&raw, "Content-ID: ");
        assert_eq!(ids.len(), 1, "{raw}");
        let cid = ids[0].trim_matches(['<', '>']);
        let view = crate::message::parse_view(raw.as_bytes(), false).unwrap();
        let picture = &view.attachments[0];
        assert!(
            picture.inline && picture.content_id.as_deref() == Some(cid),
            "{picture:?}"
        );
        // The HTML finds its picture by that id: the reader shows it.
        assert!(view.html.unwrap().contains(&format!("data:image/png;base64,{PNG}")));
        // A cid: link of someone else's letter leads nowhere and goes.
        assert!(!raw.contains("foreign@example.org"), "{raw}");
    }

    #[test]
    fn a_signature_with_a_logo_goes_inside_the_letter() {
        // The logo stands in the signature and once more in the text: one part for both.
        let logo = format!("data:image/png;base64,{PNG}");
        let html = format!(
            "<div>Смета готова.</div><img src=\"{logo}\">\
             <div class=\"depesha-signature\"><div><img src=\"{logo}\" style=\"width:46px\"> Мария Соколова</div>\
             <div><a href=\"https://example.com\">example.com</a></div></div>"
        );
        let text = "Смета готова.\n\n-- \nМария Соколова\nexample.com";
        let raw = String::from_utf8(build(&letter(BodyFormat::Html, text, Some(&html))).unwrap().formatted()).unwrap();
        assert_eq!(
            content_types(&raw),
            [
                "multipart/alternative",
                "text/plain",
                "multipart/related",
                "text/html",
                "image/png"
            ],
            "{raw}"
        );
        let ids = header_value(&raw, "Content-ID: ");
        assert_eq!(ids.len(), 1, "{raw}");
        let cid = ids[0].trim_matches(['<', '>']);
        // No picture is left in the HTML itself, none is loaded from the web.
        assert!(!raw.contains("src=\"http"), "{raw}");
        assert!(!raw.contains("data:image"), "{raw}");
        // The reader finds both places by that id, without loading remote pictures.
        let shown = crate::message::parse_view(raw.as_bytes(), false).unwrap();
        assert_eq!(shown.attachments.len(), 1);
        assert!(shown.attachments[0].inline && shown.attachments[0].content_id.as_deref() == Some(cid));
        let view_html = shown.html.unwrap();
        assert!(view_html.contains("depesha-signature"), "{view_html}");
        assert_eq!(view_html.matches(&logo).count(), 2, "{view_html}");
    }

    #[test]
    fn a_plain_letter_gets_the_text_of_the_signature_only() {
        let text = "Да.\n\n-- \nМария Соколова\nexample.com <https://example.com>";
        let raw = String::from_utf8(build(&letter(BodyFormat::Plain, text, None)).unwrap().formatted()).unwrap();
        assert_eq!(content_types(&raw), ["text/plain"], "{raw}");
        assert!(!raw.contains("Content-ID"), "{raw}");
    }

    #[test]
    fn pictures_go_beside_attachments() {
        let html = format!("<p>Фото</p><img src=\"data:image/png;base64,{PNG}\">");
        let mut draft = letter(BodyFormat::Html, "Фото", Some(&html));
        draft.attachments.push(OutgoingAttachment {
            name: "смета.pdf".into(),
            mime: "application/pdf".into(),
            data: b"%PDF".to_vec(),
        });
        let raw = String::from_utf8(build(&draft).unwrap().formatted()).unwrap();
        assert_eq!(
            content_types(&raw),
            [
                "multipart/mixed",
                "multipart/alternative",
                "text/plain",
                "multipart/related",
                "text/html",
                "image/png",
                "application/pdf"
            ],
            "{raw}"
        );
    }

    #[test]
    fn a_draft_with_a_picture_opens_with_it() {
        let html = format!("<div>Фото:</div><img src=\"data:image/png;base64,{PNG}\">");
        let raw = build(&letter(BodyFormat::Html, "Фото:", Some(&html)))
            .unwrap()
            .formatted();
        let view = crate::message::parse_view(&raw, false).unwrap();
        let shown = view.html.unwrap();
        assert!(shown.contains(&format!("data:image/png;base64,{PNG}")), "{shown}");
        assert!(!shown.contains("cid:"), "{shown}");
        // Saved again, it is the same letter.
        let again = build(&letter(BodyFormat::Html, "Фото:", Some(&shown)))
            .unwrap()
            .formatted();
        let again = String::from_utf8(again).unwrap();
        assert_eq!(header_value(&again, "Content-ID: ").len(), 1, "{again}");
    }

    #[test]
    fn only_pictures_leave_the_html() {
        let (html, images) = inline_images(
            "<img src=\"data:text/html;base64,PGI+\"><img src=\"data:image/png;base64,***\"><a href=\"x\">a</a>",
        );
        assert!(images.is_empty());
        assert_eq!(
            html,
            "<img src=\"data:text/html;base64,PGI+\"><img src=\"data:image/png;base64,***\"><a href=\"x\">a</a>"
        );
    }

    #[test]
    fn a_markdown_picture_leaves_the_markdown_for_a_part_of_its_own() {
        let (text, images) = inline_markdown_images(&format!(
            "План:\n\n![Зал](data:image/png;base64,{PNG})\n\n![Зал](data:image/png;base64,{PNG}) ![чужое](https://tracker.example/p.gif)"
        ));
        // The two same pictures are one part; both stand as `cid:` in the Markdown.
        assert_eq!(images.len(), 1, "{images:?}");
        assert_eq!(text.matches("](cid:").count(), 2, "{text}");
        assert!(!text.contains("data:image/png"), "{text}");
        // A foreign link is left as it was.
        assert!(text.contains("https://tracker.example/p.gif"), "{text}");
    }

    #[test]
    fn a_markdown_letter_of_one_picture_has_no_text_in_the_list() {
        // A letter of one picture and no words: the picture goes out in its place, and the
        // list's preview of it, sent or kept as a draft, shows no address and no base64.
        let text = format!("![](data:image/png;base64,{PNG})\n");
        let raw = build(&letter(BodyFormat::Markdown, &text, None)).unwrap().formatted();
        let shown = String::from_utf8(raw.clone()).unwrap();
        assert!(content_types(&shown).iter().any(|t| t == "image/png"), "{shown}");
        let view = crate::message::parse_view(&raw, false).unwrap();
        assert!(view.html.unwrap().contains(&format!("data:image/png;base64,{PNG}")));
        let snippet = crate::snippet::from_body(&raw);
        assert_eq!(snippet, "", "{snippet}");
    }

    /// The plain part of a Markdown letter stands for its pictures: a reader without HTML
    /// sees a picture as a service address (`cid:…`) or a base64 wall, not a picture.
    #[test]
    fn the_plain_part_of_a_markdown_letter_stands_for_its_pictures() {
        let text =
            format!("План зала:\n\n![План зала](data:image/png;base64,{PNG})\n\n![](data:image/png;base64,{PNG})\n");
        let raw = String::from_utf8(
            build_sent(&letter(BodyFormat::Markdown, &text, None))
                .unwrap()
                .formatted(),
        )
        .unwrap();
        let plain = crate::message::parse_view(raw.as_bytes(), false).unwrap().text.unwrap();
        assert!(plain.contains("[Picture: План зала]"), "{plain}");
        assert!(plain.contains("[Picture]"), "{plain}");
        assert!(!plain.contains("cid:"), "{plain}");
        assert!(!plain.contains("data:"), "{plain}");
    }

    /// The plain part stands for the pictures; the HTML part and the picture itself are
    /// where they were: a reader that draws HTML sees the picture.
    #[test]
    fn the_letter_that_goes_out_keeps_its_html_and_its_picture() {
        let text = format!("План зала:\n\n![План зала](data:image/png;base64,{PNG})\n");
        let raw = String::from_utf8(
            build_sent(&letter(BodyFormat::Markdown, &text, None))
                .unwrap()
                .formatted(),
        )
        .unwrap();
        assert_eq!(
            content_types(&raw),
            [
                "multipart/alternative",
                "text/plain",
                "text/markdown",
                "multipart/related",
                "text/html",
                "image/png"
            ],
            "{raw}"
        );
        let view = crate::message::parse_view(raw.as_bytes(), false).unwrap();
        let html = view.html.unwrap();
        assert!(html.contains(&format!("data:image/png;base64,{PNG}")), "{html}");
        assert!(view.attachments[0].inline, "{:?}", view.attachments[0]);
    }

    /// The same, with the word the caller brings: the core knows no language.
    #[test]
    fn the_word_of_the_picture_is_the_one_the_caller_brings() {
        let text = format!("![План](data:image/png;base64,{PNG})\n");
        let draft = Draft {
            picture_word: "Изображение".into(),
            ..letter(BodyFormat::Markdown, &text, None)
        };
        let raw = String::from_utf8(build_sent(&draft).unwrap().formatted()).unwrap();
        let plain = crate::message::parse_view(raw.as_bytes(), false).unwrap().text.unwrap();
        assert!(plain.contains("[Изображение: План]"), "{plain}");
        assert!(!plain.contains("cid:"), "{plain}");
    }

    /// The copy in the Drafts folder keeps the picture in its plain part: the draft opens
    /// with the picture in it, not with the word that stands for it.
    #[test]
    fn the_draft_keeps_its_picture_in_the_plain_part() {
        let text = format!("![План](data:image/png;base64,{PNG})\n");
        let raw = String::from_utf8(build(&letter(BodyFormat::Markdown, &text, None)).unwrap().formatted()).unwrap();
        let plain = crate::message::parse_view(raw.as_bytes(), false).unwrap().text.unwrap();
        assert!(plain.contains("![План](cid:"), "{plain}");
        assert!(!plain.contains("[Picture"), "{plain}");
    }

    /// A picture outside the letter (over https) stands for the word too, and its address
    /// stands after it as a link stands in the text part.
    #[test]
    fn a_picture_of_the_letter_outside_stands_for_the_word_and_keeps_its_address() {
        let text = "![Схема](https://example.com/p.png)\n";
        let raw = String::from_utf8(
            build_sent(&letter(BodyFormat::Markdown, text, None))
                .unwrap()
                .formatted(),
        )
        .unwrap();
        let plain = crate::message::parse_view(raw.as_bytes(), false).unwrap().text.unwrap();
        assert!(
            plain.contains("[Picture: Схема] <https://example.com/p.png>"),
            "{plain}"
        );
        assert!(!plain.contains("!["), "{plain}");
    }

    #[test]
    fn pictures_in_a_markdown_letter_go_as_related_parts() {
        // A Markdown letter carries its pictures in the letter itself (decision on #45):
        // the HTML part the Markdown renders to holds them as `data:` images, and here they
        // become `multipart/related` parts the HTML calls by `cid:` — not attachments.
        let text = format!("План зала:\n\n![План](data:image/png;base64,{PNG})\n");
        let raw = String::from_utf8(build(&letter(BodyFormat::Markdown, &text, None)).unwrap().formatted()).unwrap();
        assert_eq!(
            content_types(&raw),
            [
                "multipart/alternative",
                "text/plain",
                "text/markdown",
                "multipart/related",
                "text/html",
                "image/png"
            ],
            "{raw}"
        );
        // The picture is a part with a Content-ID, not a file of the letter: no attachment.
        let ids = header_value(&raw, "Content-ID: ");
        assert_eq!(ids.len(), 1, "{raw}");
        assert!(!raw.contains("attachment"), "{raw}");
        assert!(!raw.contains("data:image"), "the picture stays out of the HTML: {raw}");
        // The reader finds it by that id and shows the letter with the picture inside.
        let view = crate::message::parse_view(raw.as_bytes(), false).unwrap();
        assert!(view.attachments[0].inline, "{:?}", view.attachments[0]);
        assert!(view.attachments[0].content_id.is_some());
        assert!(view.html.unwrap().contains(&format!("data:image/png;base64,{PNG}")));
        let markdown = view.markdown.unwrap();
        assert!(markdown.contains("<img"), "{markdown}");
    }

    #[test]
    fn a_markdown_signature_goes_inside_the_letter_in_its_three_forms() {
        // A Markdown letter carries the same HTML signature as an HTML one (decision on #67):
        // the HTML part shows it as it is, the Markdown part as a paraphrase, the plain one as
        // text. Its logo is one part that both the HTML and the Markdown call by one `cid:`.
        let logo = format!("data:image/png;base64,{PNG}");
        let signature = format!(
            "<div><img src=\"{logo}\" style=\"width:46px\"> <b>Мария Соколова</b></div>\
             <div>Руководитель проектов</div><div><a href=\"https://example.com\">example.com</a></div>"
        );
        let text = "Смета готова.\n\n-- \nМария Соколова\nРуководитель проектов\nexample.com";
        let draft = Draft {
            signature: Some(signature),
            ..letter(BodyFormat::Markdown, text, None)
        };
        let raw = String::from_utf8(build(&draft).unwrap().formatted()).unwrap();
        assert_eq!(
            content_types(&raw),
            [
                "multipart/alternative",
                "text/plain",
                "text/markdown",
                "multipart/related",
                "text/html",
                "image/png"
            ],
            "{raw}"
        );
        // The logo is one part; the HTML and the Markdown call it by the same id.
        let ids = header_value(&raw, "Content-ID: ");
        assert_eq!(ids.len(), 1, "{raw}");
        let cid = ids[0].trim_matches(['<', '>']);
        assert!(!raw.contains("data:image"), "the logo leaves the letter: {raw}");
        // Quoted-printable folds long lines and spells "=" as "=3D"; joined back and decoded,
        // both parts name the same picture.
        let joined = raw.replace("=\r\n", "").replace("=3D", "=");
        let markdown = joined.split("Content-Type: text/markdown").nth(1).unwrap();
        assert!(markdown.contains(&format!("](cid:{cid})")), "{markdown}");
        let html = joined.split("Content-Type: text/html").nth(1).unwrap();
        assert!(html.contains("depesha-signature"), "{html}");
        assert!(html.contains(&format!("src=\"cid:{cid}\"")), "{html}");
        // The reader shows the letter with both, the same picture found by its id.
        let view = crate::message::parse_view(raw.as_bytes(), false).unwrap();
        assert_eq!(view.attachments.len(), 1);
        assert!(view.attachments[0].inline);
        assert!(view.html.unwrap().contains(&logo));
        // The plain part keeps the signature's text under the separator.
        let plain = view.text.unwrap().replace("\r\n", "\n");
        assert!(plain.contains("-- \nМария Соколова"), "{plain}");
    }

    #[test]
    fn a_html_signature_becomes_markdown() {
        // Bold, italic, links, line breaks and pictures; everything else as text (#67).
        let md = signature_markdown(
            "<div><b>Мария</b> <i>Соколова</i></div>\
             <div><a href=\"https://example.com\">example.com</a></div>\
             <div>Строка<br>вторая</div>\
             <div><img src=\"cid:x@depesha\" alt=\"Север\"></div>",
        );
        assert!(md.contains("**Мария**"), "{md}");
        assert!(md.contains("*Соколова*"), "{md}");
        assert!(md.contains("[example.com](https://example.com)"), "{md}");
        assert!(md.contains("Строка  \nвторая"), "{md}");
        assert!(md.contains("![Север](cid:x@depesha)"), "{md}");
    }

    #[test]
    fn signature_and_quote_blocks_survive_cleaning() {
        let html = "<div>Да</div><div class=\"depesha-signature\">-- <br>Иван</div>\
                    <div class=\"depesha-quote other\"><blockquote style=\"margin:0\">Вопрос</blockquote></div>";
        let clean = crate::message::compose_html(html);
        assert!(clean.contains("<div class=\"depesha-signature\">"), "{clean}");
        assert!(clean.contains("<div class=\"depesha-quote\">"), "{clean}");
    }

    #[test]
    fn the_empty_line_above_the_signature_reaches_the_letter() {
        let html = "<p>Привет</p><div><br></div><div class=\"depesha-signature\"><div>Иван</div></div>";
        let clean = crate::message::compose_html(html);
        assert!(
            clean.contains("<div><br></div><div class=\"depesha-signature\""),
            "{clean}"
        );

        let draft = letter(BodyFormat::Html, "Привет\n\n-- \nИван", Some(html));
        let raw = String::from_utf8(build(&draft).unwrap().formatted()).unwrap();
        // Quoted-printable spells the separator's trailing space (RFC 3676) as "=20".
        assert!(raw.contains("--=20"), "the plain part keeps the separator: {raw}");
    }

    #[test]
    fn outbox_entries_from_before_formats_are_plain() {
        let draft: Draft = serde_json::from_str(r#"{"from":null,"to":[],"cc":[],"bcc":[],"subject":"","text":"x","html":null,"in_reply_to":null,"references":[],"attachments":[]}"#).unwrap();
        assert_eq!(draft.format, BodyFormat::Plain);
    }

    #[test]
    fn rejects_empty_recipients() {
        let draft = Draft {
            from: Some(addr("me@example.org")),
            ..Default::default()
        };
        assert!(matches!(build(&draft), Err(Error::Said(Say::NoRecipients))));
    }

    #[test]
    fn stuffs_dots() {
        assert_eq!(dot_stuff(b".a\r\nb\r\n.\r\n"), b"..a\r\nb\r\n..\r\n.\r\n");
        assert_eq!(dot_stuff(b"x"), b"x\r\n.\r\n");
    }

    #[test]
    fn ehlo_name_is_never_localhost() {
        let v4: SocketAddr = "192.168.1.10:51000".parse().unwrap();
        let v6: SocketAddr = "[2001:db8::5]:51000".parse().unwrap();
        let mapped: SocketAddr = "[::ffff:10.0.0.7]:51000".parse().unwrap();
        assert_eq!(
            ehlo_name(Some("ws1.corp.example.org\n"), Some(v4)),
            "ws1.corp.example.org"
        );
        // Windows and bare Linux names have no domain: the address literal goes instead.
        assert_eq!(ehlo_name(Some("DESKTOP-ABC123"), Some(v4)), "[192.168.1.10]");
        assert_eq!(ehlo_name(None, Some(v4)), "[192.168.1.10]");
        assert_eq!(ehlo_name(Some("localhost.localdomain"), Some(v4)), "[192.168.1.10]");
        assert_eq!(ehlo_name(Some("ноут.дом"), Some(v4)), "[192.168.1.10]");
        assert_eq!(ehlo_name(None, Some(v6)), "[IPv6:2001:db8::5]");
        assert_eq!(ehlo_name(None, Some(mapped)), "[10.0.0.7]");
        assert_eq!(ehlo_name(None, None), "[127.0.0.1]");
    }

    #[tokio::test]
    async fn refused_ehlo_is_explained_as_greeting() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let mut s = BufReader::new(sock);
            s.get_mut().write_all(b"220 mx ESMTP\r\n").await.unwrap();
            let mut line = String::new();
            s.read_line(&mut line).await.unwrap();
            s.get_mut().write_all(b"550 5.7.1 Sender unknown\r\n").await.unwrap();
            line
        });
        let cfg = ServerConfig {
            host: "127.0.0.1".into(),
            port,
            security: Security::Plain,
            trusted_cert: None,
        };
        let err = check(&cfg, &Credentials::new("u", "p")).await.unwrap_err();
        let ehlo = server.await.unwrap();
        let want = ehlo_name(hostname().as_deref(), Some(([127, 0, 0, 1], 0).into()));
        assert_eq!(ehlo.trim_end(), format!("EHLO {want}"));
        assert!(
            matches!(&err, Error::SmtpHello { code: 550, name, .. } if *name == want),
            "{err:?}"
        );
        assert!(!err.to_string().contains("policy"), "{err}");
    }

    #[test]
    fn explains_exchange_codes() {
        let e = Reply {
            code: 421,
            lines: vec!["4.4.2 Message submission rate for this client has exceeded".into()],
        }
        .into_error();
        assert_eq!(e.kind(), crate::error::ErrorKind::RateLimited);
        assert!(e.is_transient());
        let e = Reply {
            code: 550,
            lines: vec!["5.7.60 SMTP; Client does not have permissions to send as this sender".into()],
        }
        .into_error();
        assert!(e.to_string().contains("Send As"), "{e}");
        assert!(!e.is_transient());
    }

    /// Every failed step is logged, and the log may keep the server and the step, the kind of
    /// trouble and the numeric codes — never the reply itself, which may quote the recipient,
    /// the login or the greeting the server refused.
    #[test]
    fn a_failed_step_is_logged_without_the_servers_words() {
        let cfg = ServerConfig {
            host: "smtp.example.com".into(),
            port: 465,
            security: Security::Tls,
            trusted_cert: None,
        };
        let refused = Error::Smtp {
            code: 550,
            enhanced: Some("5.1.1".into()),
            message: "<user@example.org>: no such user".into(),
        };
        let login = Error::Auth("535 login user@example.org refused".into());
        let greeting = Error::SmtpHello {
            name: "workstation.local".into(),
            code: 501,
            message: "syntax error, user@example.org".into(),
        };
        let line = logged(|| {
            log_stage(&cfg, "send", &refused);
            log_stage(&cfg, "auth", &login);
            log_stage(&cfg, "ehlo", &greeting);
        });
        for word in ["example.org", "user@", "no such user", "535 login", "workstation.local"] {
            assert!(!line.contains(word), "{word} in {line}");
        }
        assert!(line.contains("smtp.example.com") && line.contains("send"), "{line}");
        // A line that carries codes puts the variant and the codes in one field, not beside it.
        assert!(line.contains("error=\"smtp 550 5.1.1\""), "{line}");
        assert!(!line.contains("tag="), "{line}");
        // A failure without codes names its variant on its own.
        assert!(line.contains("error=\"auth\""), "{line}");
    }
}
