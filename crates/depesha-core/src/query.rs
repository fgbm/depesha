//! Search operators, the same for the local cache and IMAP SEARCH:
//! `from:` `to:` `subject:` `has:attachment` `is:unread` `is:flagged`
//! `before:` `after:` `in:`, with Russian synonyms. Everything else is free text.

use chrono::{Local, NaiveDate, TimeZone};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchQuery {
    /// Free words: subject, addresses and body.
    pub words: Vec<String>,
    pub from: Vec<String>,
    pub to: Vec<String>,
    pub subject: Vec<String>,
    pub has_attachment: bool,
    pub unread: bool,
    pub flagged: bool,
    /// Unix time bounds: `after` inclusive, `before` exclusive (start of the given day).
    pub after: Option<i64>,
    pub before: Option<i64>,
    /// Folder name or role word (`inbox`, `входящие`, `sent`...).
    pub folder: Option<String>,
}

impl SearchQuery {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    pub fn parse(text: &str) -> Self {
        let mut q = Self::default();
        for token in tokens(text) {
            let Some((key, value)) = token.split_once(':').filter(|(k, v)| !k.is_empty() && !v.is_empty()) else {
                q.words.push(token);
                continue;
            };
            let value = value.to_owned();
            match key.to_lowercase().as_str() {
                "from" | "от" => q.from.push(value),
                "to" | "кому" => q.to.push(value),
                "subject" | "тема" => q.subject.push(value),
                "has" | "есть" if matches!(value.to_lowercase().as_str(), "attachment" | "вложение" | "вложения") => {
                    q.has_attachment = true
                }
                "is" | "это" => match value.to_lowercase().as_str() {
                    "unread" | "непрочитанное" | "непрочитанные" => q.unread = true,
                    "flagged" | "starred" | "флаг" | "сфлагом" => q.flagged = true,
                    _ => q.words.push(token),
                },
                "before" | "до" => match day_start(&value) {
                    Some(t) => q.before = Some(t),
                    None => q.words.push(token),
                },
                "after" | "после" | "с" => match day_start(&value) {
                    Some(t) => q.after = Some(t),
                    None => q.words.push(token),
                },
                "in" | "в" => q.folder = Some(value),
                _ => q.words.push(token),
            }
        }
        q
    }
}

/// Splits on spaces, keeping "quoted phrases" and `key:"quoted value"` together.
fn tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for ch in text.chars() {
        match ch {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// `2026-10-03` or `03.10.2026`, as local midnight.
fn day_start(value: &str) -> Option<i64> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .or_else(|_| NaiveDate::parse_from_str(value, "%d.%m.%Y"))
        .ok()?;
    Local
        .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
        .earliest()
        .map(|d| d.timestamp())
}

/// One IMAP SEARCH key with an optional string argument.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Criterion {
    pub key: &'static str,
    pub value: Option<String>,
}

impl Criterion {
    fn new(key: &'static str, value: impl Into<String>) -> Self {
        Self {
            key,
            value: Some(value.into()),
        }
    }

    fn flag(key: &'static str) -> Self {
        Self { key, value: None }
    }
}

/// The query as IMAP SEARCH keys (RFC 3501 6.4.4). `has:attachment` has no
/// IMAP equivalent and is applied to the results locally.
pub fn imap_criteria(q: &SearchQuery) -> Vec<Criterion> {
    let mut out = Vec::new();
    out.extend(q.words.iter().map(|w| Criterion::new("TEXT", w.clone())));
    out.extend(q.from.iter().map(|w| Criterion::new("FROM", w.clone())));
    out.extend(q.to.iter().map(|w| Criterion::new("TO", w.clone())));
    out.extend(q.subject.iter().map(|w| Criterion::new("SUBJECT", w.clone())));
    if q.unread {
        out.push(Criterion::flag("UNSEEN"));
    }
    if q.flagged {
        out.push(Criterion::flag("FLAGGED"));
    }
    if let Some(t) = q.after {
        out.push(Criterion {
            key: "SINCE",
            value: Some(imap_date(t)),
        });
    }
    if let Some(t) = q.before {
        out.push(Criterion {
            key: "BEFORE",
            value: Some(imap_date(t)),
        });
    }
    out
}

/// `3-Oct-2026`: IMAP dates are atoms, not strings, but quoting them is also valid.
fn imap_date(t: i64) -> String {
    Local
        .timestamp_opt(t, 0)
        .single()
        .map(|d| d.format("%-d-%b-%Y").to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_operators_in_both_languages() {
        let q =
            SearchQuery::parse(r#"от:ivan тема:"акт сверки" счёт is:unread есть:вложение до:2026-10-03 in:Входящие"#);
        assert_eq!(q.from, ["ivan"]);
        assert_eq!(q.subject, ["акт сверки"]);
        assert_eq!(q.words, ["счёт"]);
        assert!(q.unread && q.has_attachment && !q.flagged);
        assert!(q.before.is_some());
        assert_eq!(q.folder.as_deref(), Some("Входящие"));

        let q = SearchQuery::parse("from:a@b.c after:01.09.2026 http://x.example");
        assert_eq!(q.from, ["a@b.c"]);
        assert!(q.after.is_some());
        // A URL is text, not an operator.
        assert_eq!(q.words, ["http://x.example"]);
    }

    #[test]
    fn bad_values_stay_text() {
        let q = SearchQuery::parse("до:завтра is:whatever тема:");
        assert_eq!(q.words, ["до:завтра", "is:whatever", "тема:"]);
    }

    #[test]
    fn maps_to_imap_keys() {
        let q = SearchQuery::parse("from:ivan договор is:flagged after:2026-10-03");
        let keys: Vec<_> = imap_criteria(&q).iter().map(|c| c.key).collect();
        assert_eq!(keys, ["TEXT", "FROM", "FLAGGED", "SINCE"]);
        assert_eq!(imap_criteria(&q)[3].value.as_deref(), Some("3-Oct-2026"));
    }
}
