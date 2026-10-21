//! The beginning of a letter's text, shown in the list row (#177). It comes from the
//! server during sync (a prefix of the letter's text part) or from a body already in
//! the cache, and it is what lets the list be read without opening every letter.
//!
//! The text is decoded here and not by the MIME parser: the server returns a cut
//! prefix, so the last base64 group or quoted-printable sequence may be incomplete and
//! is dropped rather than half-decoded. Charset conversion is mail-parser's, the same
//! one the whole letter goes through.

use mail_parser::decoders::charsets::map::charset_decoder;
use mail_parser::decoders::{base64::base64_decode, quoted_printable::quoted_printable_decode};

/// How much of the text a row shows, characters; longer is cut with an ellipsis.
pub const LENGTH: usize = 200;

/// The transfer encoding of a part, as `BODYSTRUCTURE` names it (RFC 2045).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Encoding {
    /// 7bit, 8bit, binary or an encoding the cache does not know: the bytes as they are.
    #[default]
    Identity,
    Base64,
    QuotedPrintable,
}

/// The beginning of a downloaded letter's text, normalized.
pub fn from_body(raw: &[u8]) -> String {
    normalize(&crate::message::index_text(raw))
}

/// The beginning of one part's text. `data` is what the server returned for
/// `BODY.PEEK[<part>]<0.n>`, so the tail may be incomplete; `html` says whether the
/// part's tags are to be stripped before the text is read.
pub fn from_part(data: &[u8], encoding: Encoding, charset: Option<&str>, html: bool) -> String {
    let bytes = match encoding {
        Encoding::Base64 => base64_decode(data),
        Encoding::QuotedPrintable => quoted_printable_decode(data),
        Encoding::Identity => Some(data.to_vec()),
    };
    let Some(bytes) = bytes else { return String::new() };
    let text = decode_charset(&bytes, charset);
    if html {
        normalize(&crate::message::strip_tags(&text))
    } else {
        normalize(&text)
    }
}

/// Bytes of a part as text, in the charset it names; unknown and absent charsets are
/// read as UTF-8, a byte sequence that is not valid losing only its bad parts.
fn decode_charset(bytes: &[u8], charset: Option<&str>) -> String {
    match charset.map(str::trim).filter(|c| !c.is_empty()) {
        Some(name) => match charset_decoder(name.as_bytes()) {
            Some(decode) => decode(bytes),
            None => String::from_utf8_lossy(bytes).into_owned(),
        },
        None => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// One line for the row: whitespace folded to single spaces, the quoted lines and the
/// signature dropped, the pictures of the text taken out (a row cannot show them), the
/// control characters and direction marks a sender may hide text with taken out, cut to
/// `LENGTH` with an ellipsis.
pub fn normalize(text: &str) -> String {
    let text = without_pictures(text);
    let mut out = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // A quotation is the letter it answers, not this one.
        if line.starts_with('>') {
            continue;
        }
        // The signature marker (RFC 3676) and everything under it are not the letter.
        if line == "--" || line.starts_with("-- ") {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(line);
    }
    let folded = out.split_whitespace().collect::<Vec<_>>().join(" ");
    cut(&folded.chars().filter(|c| !is_hidden(*c)).collect::<String>())
}

/// The text without its pictures: a Markdown image (`![alt](url)`, a Markdown letter's own
/// picture), and a bare `data:` or `cid:` address. A prefix the server cut may end inside an
/// image, and then the rest goes with it.
fn without_pictures(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("![") {
        out.push_str(&rest[..at]);
        let image = &rest[at..];
        // The alt is one line without brackets, the address what stands up to ")".
        let open = image.find("](").filter(|&mid| !image[2..mid].contains(['\n', '[']));
        match open {
            Some(mid) => {
                rest = image[mid + 2..]
                    .find(')')
                    .map_or("", |close| &image[mid + 2 + close + 1..])
            }
            None => {
                out.push_str("![");
                rest = &image[2..];
            }
        }
    }
    out.push_str(rest);
    out.lines()
        .map(|line| {
            line.split(' ')
                .filter(|word| !is_address(word))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A word that is the address of a picture inside the letter: `data:image/…` or `cid:…`.
/// A word "data:" in the text, with nothing after it, is a word.
fn is_address(word: &str) -> bool {
    let word = word.trim_start_matches(['<', '(', '"']).to_ascii_lowercase();
    word.strip_prefix("data:").is_some_and(|rest| rest.contains(['/', ',']))
        || word.strip_prefix("cid:").is_some_and(|rest| !rest.is_empty())
}

/// A character a row must not carry: the control ones and the direction marks that would
/// reorder the text around them (U+202A–U+202E, U+2066–U+2069).
fn is_hidden(c: char) -> bool {
    c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

/// The text cut to `LENGTH` characters, an ellipsis standing for the rest.
fn cut(text: &str) -> String {
    if text.chars().count() <= LENGTH {
        return text.to_owned();
    }
    let head: String = text.chars().take(LENGTH).collect();
    format!("{}…", head.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD as BASE64;

    /// Criterion: the spaces of a wrapped, indented letter fold into one line.
    #[test]
    fn folds_whitespace_into_one_line() {
        assert_eq!(
            normalize("Добрый день!\n\n   Как   дела?\tХорошо."),
            "Добрый день! Как дела? Хорошо."
        );
    }

    /// Criterion: the quoted lines and the signature after "-- " are dropped.
    #[test]
    fn drops_quotes_and_the_signature() {
        let letter = "Согласен, встречаемся в среду.\n\
                      > Когда вам удобно?\n\
                      > > Мне в четверг.\n\
                      -- \n\
                      Иван\n\
                      +7 900 000-00-00";
        assert_eq!(normalize(letter), "Согласен, встречаемся в среду.");
        assert_eq!(normalize("Письмо\n--\nподпись"), "Письмо");
    }

    /// Criterion: the control characters and the direction marks do not reach the row.
    #[test]
    fn drops_control_characters_and_direction_marks() {
        assert_eq!(normalize("Привет\u{0}\u{7}, мир\u{202e}!"), "Привет, мир!");
        assert_eq!(normalize("a\u{2066}b\u{2069}c"), "abc");
    }

    /// Criterion: a long text is cut with an ellipsis, by characters, not bytes.
    #[test]
    fn cuts_long_text_with_an_ellipsis() {
        let long = "я".repeat(500);
        let out = normalize(&long);
        assert_eq!(out.chars().count(), LENGTH + 1, "200 characters and the ellipsis");
        assert!(out.ends_with('…'));
        let short = "я".repeat(50);
        assert_eq!(normalize(&short), short, "a short text keeps no ellipsis");
    }

    /// Criterion: a base64 part cut in the middle of a group decodes to the whole groups,
    /// the incomplete one dropped rather than half-decoded.
    #[test]
    fn decodes_truncated_base64() {
        let full = BASE64.encode("Привет, мир!");
        let cut = &full.as_bytes()[..full.len() - 3];
        let out = from_part(cut, Encoding::Base64, Some("utf-8"), false);
        assert!("Привет, мир!".starts_with(&out), "{out}");
        assert!(
            !out.is_empty() && !out.contains('\u{fffd}'),
            "no half-decoded tail: {out}"
        );
        // The whole text decodes, not only the tail.
        assert_eq!(
            from_part(full.as_bytes(), Encoding::Base64, Some("utf-8"), false),
            "Привет, мир!"
        );
    }

    /// Criterion: a quoted-printable part in Windows-1251, its last sequence cut, decodes
    /// to the whole sequences; a lone "=" at the end is dropped, not half-decoded.
    #[test]
    fn decodes_truncated_quoted_printable_in_cp1251() {
        let full = "=CF=F0=E8=E2=E5=F2, =EC=E8=F0";
        // Cut before the last byte of the last escape.
        let cut = &full.as_bytes()[..full.len() - 1];
        let out = from_part(cut, Encoding::QuotedPrintable, Some("windows-1251"), false);
        assert!("Привет, мир".starts_with(&out), "{out}");
        assert!(
            !out.is_empty() && !out.contains('\u{fffd}'),
            "no half-decoded tail: {out}"
        );
        // Cut right after the "=": nothing of the escape leaks into the text.
        let at_eq = &full.as_bytes()[..full.len() - 2];
        assert_eq!(
            from_part(at_eq, Encoding::QuotedPrintable, Some("windows-1251"), false),
            "Привет, ми"
        );
        // The whole sequence decodes, not only the tail.
        assert_eq!(
            from_part(full.as_bytes(), Encoding::QuotedPrintable, Some("windows-1251"), false),
            "Привет, мир"
        );
    }

    /// Criterion: an HTML part gives its text without tags.
    #[test]
    fn strips_html_tags() {
        let html = b"<html><body><p>Hello&nbsp;<b>world</b>!</p><script>x()</script></body></html>";
        assert_eq!(from_part(html, Encoding::Identity, Some("utf-8"), true), "Hello world!");
    }

    /// An unknown charset and an absent one are read as UTF-8, losing only bad bytes.
    #[test]
    fn unknown_charset_reads_as_utf8() {
        assert_eq!(
            from_part("Привет".as_bytes(), Encoding::Identity, None, false),
            "Привет"
        );
        assert_eq!(
            from_part(b"Hi \xff", Encoding::Identity, Some("nonsense-charset"), false),
            "Hi \u{fffd}"
        );
    }

    /// Criterion: the pictures of a text (a Markdown image, a bare `data:` or `cid:`
    /// address) are not shown in the row; a picture cut by the prefix goes whole.
    #[test]
    fn leaves_the_pictures_of_a_text_out() {
        assert_eq!(normalize("![](data:image/png;base64,iVBORw0KGgo=)"), "");
        assert_eq!(normalize("![План](cid:3f2a@depesha)\n"), "");
        assert_eq!(
            normalize("План зала:\n\n![План](data:image/png;base64,AA)\n\nПриходите к 10."),
            "План зала: Приходите к 10."
        );
        assert_eq!(normalize("Вот: data:image/png;base64,AAAA и всё"), "Вот: и всё");
        assert_eq!(normalize("Смотри <cid:logo@x> тут"), "Смотри тут");
        // Cut by the prefix inside the address: nothing of it is left.
        assert_eq!(normalize("Фото:\n![](data:image/jpeg;base64,/9j/4AAQSk"), "Фото:");
        // What only looks like one stays: a word "Data:", a "!" before a link.
        assert_eq!(normalize("Data: см. ниже"), "Data: см. ниже");
        assert_eq!(normalize("Ура![ссылка]"), "Ура![ссылка]");
    }

    /// Criterion: an incoming letter whose text carries its picture as `data:` gives no
    /// base64 to the row, neither from its text part nor from its HTML.
    #[test]
    fn an_incoming_picture_in_data_gives_no_base64() {
        let text = format!("![]({PICTURE})\n");
        let out = from_part(text.as_bytes(), Encoding::Identity, Some("utf-8"), false);
        assert_eq!(out, "");
        let html = format!("<p><img src=\"{PICTURE}\"></p>");
        assert_eq!(from_part(html.as_bytes(), Encoding::Identity, Some("utf-8"), true), "");
        let encoded = BASE64.encode(format!("Привет!\n{text}"));
        assert_eq!(
            from_part(encoded.as_bytes(), Encoding::Base64, Some("utf-8"), false),
            "Привет!"
        );
    }

    const PICTURE: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    /// The whole downloaded letter gives the same beginning as its text part.
    #[test]
    fn a_downloaded_body_gives_its_text() {
        let raw = "From: a@example.org\r\nSubject: s\r\nMIME-Version: 1.0\r\n\
Content-Type: text/plain; charset=utf-8\r\n\r\nПривет, мир!\n\n> цитата\n-- \nподпись"
            .as_bytes();
        assert_eq!(from_body(raw), "Привет, мир!");
    }
}
