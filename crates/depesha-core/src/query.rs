//! Search operators, the same for the local cache and IMAP SEARCH:
//! `from:` `to:` `subject:` `has:attachment` `is:unread` `is:flagged` `is:important`
//! `before:` `after:` `in:` (`in:Work/*` with subfolders), size `larger:25M` `smaller:`, age `older:2y` `newer:30d`,
//! a calendar year `year:2024` and a mailbox `account:`, with Russian synonyms.
//! Everything else is free text.

use chrono::{DateTime, Duration, Local, Months, NaiveDate, NaiveDateTime, TimeZone};

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
    /// `is:important`: letters marked high (#72). The server finds them by their headers.
    pub important: bool,
    /// Unix time bounds: `after` inclusive, `before` exclusive (start of the given day).
    pub after: Option<i64>,
    pub before: Option<i64>,
    /// Folder name or role word (`inbox`, `входящие`, `sent`...).
    pub folder: Option<String>,
    /// The folder's subfolders too: `in:Work/*`.
    pub subfolders: bool,
    /// Size bounds in bytes, both exclusive like IMAP LARGER and SMALLER.
    pub larger: Option<u64>,
    pub smaller: Option<u64>,
    /// A mailbox by its address or name; the caller knows the mailboxes.
    pub account: Option<String>,
    /// Label names (`метка:Срочно`): the caller knows each mailbox's keyword for a name.
    pub label: Vec<String>,
}

/// The alternatives of one `from:` value: `from:a@x|b@y` is a letter from either (an address
/// book person with several addresses, #104). A value without `|` is its own single one.
pub fn alternatives(value: &str) -> Vec<&str> {
    let alts: Vec<&str> = value.split('|').map(str::trim).filter(|a| !a.is_empty()).collect();
    if alts.is_empty() { vec![value] } else { alts }
}

impl SearchQuery {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// A letter of this size passes the size bounds.
    pub fn fits_size(&self, size: u64) -> bool {
        self.larger.is_none_or(|n| size > n) && self.smaller.is_none_or(|n| size < n)
    }

    pub fn parse(text: &str) -> Self {
        Self::parse_at(text, Local::now())
    }

    /// `parse` with ages (`older:1y`) counted back from `now`.
    pub fn parse_at(text: &str, now: DateTime<Local>) -> Self {
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
                    "important" | "важное" | "важные" => q.important = true,
                    _ => q.words.push(token),
                },
                "before" | "до" => match day_start(&value) {
                    Some(t) => q.until(t),
                    None => q.words.push(token),
                },
                "after" | "после" | "с" => match day_start(&value) {
                    Some(t) => q.since(t),
                    None => q.words.push(token),
                },
                "older" | "старше" => match ago(&value, now) {
                    Some(t) => q.until(t),
                    None => q.words.push(token),
                },
                "newer" | "новее" | "моложе" => match ago(&value, now) {
                    Some(t) => q.since(t),
                    None => q.words.push(token),
                },
                // From January 1 inclusive to January 1 of the next year exclusive.
                "year" | "год" => match value
                    .parse::<i32>()
                    .ok()
                    .and_then(|y| Some((year_start(y)?, year_start(y + 1)?)))
                {
                    Some((from, to)) => {
                        q.since(from);
                        q.until(to);
                    }
                    None => q.words.push(token),
                },
                "larger" | "больше" => match bytes(&value) {
                    Some(n) => q.larger = Some(q.larger.map_or(n, |m| m.max(n))),
                    None => q.words.push(token),
                },
                "smaller" | "меньше" => match bytes(&value) {
                    Some(n) => q.smaller = Some(q.smaller.map_or(n, |m| m.min(n))),
                    None => q.words.push(token),
                },
                "in" | "в" => match value.strip_suffix("/*").filter(|f| !f.is_empty()) {
                    Some(folder) => {
                        q.folder = Some(folder.to_owned());
                        q.subfolders = true;
                    }
                    None => {
                        q.folder = Some(value);
                        q.subfolders = false;
                    }
                },
                "account" | "ящик" | "аккаунт" => q.account = Some(value),
                // A label by its name: the keyword that carries it on the server is the
                // mailbox's own (acl::keyword_of), resolved where the mailbox is known.
                "label" | "метка" | "метки" => q.label.push(value),
                _ => q.words.push(token),
            }
        }
        q
    }

    /// Bounds narrow each other: `year:2024 older:1y` is what both allow.
    fn since(&mut self, t: i64) {
        self.after = Some(self.after.map_or(t, |a| a.max(t)));
    }

    fn until(&mut self, t: i64) {
        self.before = Some(self.before.map_or(t, |b| b.min(t)));
    }
}

/// Splits on spaces, keeping "quoted phrases" and `key:"quoted value"` together.
fn tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    // Whether the open quote stays: it closes right before an `@` (`"a b"@x`), so the
    // quotes are the address's own (RFC 5321 quoted local part), not the query's.
    let mut keep = false;
    let chars: Vec<char> = text.chars().collect();
    for (i, &ch) in chars.iter().enumerate() {
        match ch {
            '"' if !quoted => {
                quoted = true;
                let close = chars[i + 1..].iter().position(|&c| c == '"').map(|p| i + 1 + p);
                keep = close.is_some_and(|j| chars.get(j + 1) == Some(&'@'));
                if keep {
                    cur.push('"');
                }
            }
            '"' => {
                quoted = false;
                if keep {
                    cur.push('"');
                    keep = false;
                }
            }
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

/// January 1 of `year`, local midnight.
fn year_start(year: i32) -> Option<i64> {
    if !(1970..=9999).contains(&year) {
        return None;
    }
    let date = NaiveDate::from_ymd_opt(year, 1, 1)?;
    Local
        .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
        .earliest()
        .map(|d| d.timestamp())
}

/// `30d`, `2w`, `6m`, `1y` (`30д`, `2н`, `6м`, `1г`) back from `now`, as Unix time.
fn ago(value: &str, now: DateTime<Local>) -> Option<i64> {
    ago_in(&Local, value, now)
}

fn ago_in<Tz: TimeZone>(tz: &Tz, value: &str, now: DateTime<Tz>) -> Option<i64> {
    let digits = value.find(|c: char| !c.is_ascii_digit()).unwrap_or(value.len());
    let n: u32 = value[..digits].parse().ok()?;
    let months = |m: u32| local_time(tz, now.naive_local().checked_sub_months(Months::new(m))?);
    match value[digits..].to_lowercase().as_str() {
        "d" | "д" => Some(now.checked_sub_signed(Duration::days(n.into()))?.timestamp()),
        "w" | "н" => Some(now.checked_sub_signed(Duration::weeks(n.into()))?.timestamp()),
        // Months back on the calendar, at the same wall-clock time.
        "m" | "м" | "мес" => months(n),
        "y" | "г" | "л" => months(n.checked_mul(12)?),
        _ => None,
    }
}

/// A wall-clock time as Unix time. One a clock change skipped (the spring gap) is
/// taken an hour later, as the clock showed it then; a repeated one, the earlier.
fn local_time<Tz: TimeZone>(tz: &Tz, at: NaiveDateTime) -> Option<i64> {
    tz.from_local_datetime(&at)
        .earliest()
        .or_else(|| tz.from_local_datetime(&(at + Duration::hours(1))).earliest())
        .map(|d| d.timestamp())
}

/// `25M`, `1.5G`, `500K`, `25МБ`, `1,5ГБ`; a bare number is bytes, as in Gmail.
/// Units are binary, as sizes are shown.
fn bytes(value: &str) -> Option<u64> {
    let end = value
        .find(|c: char| !c.is_ascii_digit() && c != '.' && c != ',')
        .unwrap_or(value.len());
    let n: f64 = value[..end].replace(',', ".").parse().ok()?;
    let unit: u64 = match value[end..].to_lowercase().as_str() {
        "" | "b" | "б" => 1,
        "k" | "kb" | "к" | "кб" => 1 << 10,
        "m" | "mb" | "м" | "мб" => 1 << 20,
        "g" | "gb" | "г" | "гб" => 1 << 30,
        _ => return None,
    };
    (n.is_finite() && n >= 0.0).then(|| (n * unit as f64).round() as u64)
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

/// The keys that find a letter marked high: the headers that say it (RFC 3501 `HEADER`
/// looks for a substring without regard to case), as one `OR` tree. «1» and «2» of
/// `X-Priority` are the high ones; `1 (Highest)` and `2 (High)` carry them first.
const IMPORTANT_KEYS: &str = "OR HEADER Importance high OR HEADER X-Priority 1 OR HEADER X-Priority 2 \
     HEADER X-MSMail-Priority high";

/// The query as IMAP SEARCH keys (RFC 3501 6.4.4). `has:attachment` has no
/// IMAP equivalent and is applied to the results locally. SINCE and BEFORE look at
/// INTERNALDATE, close to the Date the cache filters by.
pub fn imap_criteria(q: &SearchQuery) -> Vec<Criterion> {
    let mut out = Vec::new();
    out.extend(q.words.iter().map(|w| Criterion::new("TEXT", w.clone())));
    for w in &q.from {
        // «Either of these»: OR takes two keys, so three alternatives nest as OR a OR b c.
        let alts = alternatives(w);
        for (i, alt) in alts.iter().enumerate() {
            if i + 1 < alts.len() {
                out.push(Criterion::flag("OR"));
            }
            out.push(Criterion::new("FROM", *alt));
        }
    }
    out.extend(q.to.iter().map(|w| Criterion::new("TO", w.clone())));
    out.extend(q.subject.iter().map(|w| Criterion::new("SUBJECT", w.clone())));
    if q.unread {
        out.push(Criterion::flag("UNSEEN"));
    }
    if q.flagged {
        out.push(Criterion::flag("FLAGGED"));
    }
    if q.important {
        out.push(Criterion::flag(IMPORTANT_KEYS));
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
    // Sizes in SEARCH are 32-bit (RFC 3501, number), and so is every message's size:
    // "larger than 4 GiB" is "larger than the most", "smaller than 4 GiB" is no bound.
    if let Some(n) = q.larger {
        out.push(Criterion::new("LARGER", n.min(u32::MAX.into()).to_string()));
    }
    if let Some(n) = q.smaller.filter(|&n| n <= u32::MAX.into()) {
        out.push(Criterion::new("SMALLER", n.to_string()));
    }
    out
}

/// The query as IMAP SEARCH keys with the labels' keywords resolved by `keyword`: a label
/// is what the user typed, while the server knows it by the mailbox's own keyword. A label
/// the mailbox does not have is left out: no letter of it can carry the keyword.
pub fn imap_criteria_with_labels(q: &SearchQuery, keyword: impl Fn(&str) -> Option<String>) -> Vec<Criterion> {
    let mut out = imap_criteria(q);
    out.extend(
        q.label
            .iter()
            .filter_map(|name| keyword(name))
            .map(|kw| Criterion::new("KEYWORD", kw)),
    );
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

        // The label operator: `метка:` and `label:`, both by the label's name.
        let q = SearchQuery::parse(r#"метка:Срочно from:ivan"#);
        assert_eq!(q.label, ["Срочно"]);
        assert_eq!(q.from, ["ivan"]);
        let q = SearchQuery::parse("label:Important");
        assert_eq!(q.label, ["Important"]);
        // A label resolves to the mailbox's keyword, and an unknown one is left out.
        let q = SearchQuery::parse("метка:Срочно");
        let criteria = imap_criteria_with_labels(&q, |name| (name == "Срочно").then(|| "depesha-srochno".to_owned()));
        assert_eq!(criteria, [Criterion::new("KEYWORD", "depesha-srochno")]);
        assert!(imap_criteria_with_labels(&q, |_| None).is_empty());

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

    fn at(y: i32, m: u32, d: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, m, d, 12, 0, 0).unwrap()
    }

    #[test]
    fn size_operators_in_both_languages() {
        let q = SearchQuery::parse("larger:25M smaller:1.5G");
        assert_eq!(q.larger, Some(25 << 20));
        assert_eq!(q.smaller, Some(3 << 29));
        let q = SearchQuery::parse("больше:10МБ меньше:500кб больше:2,5м");
        // Two lower bounds: the stricter one.
        assert_eq!(q.larger, Some(10 << 20));
        assert_eq!(q.smaller, Some(500 << 10));
        assert_eq!(SearchQuery::parse("larger:1000").larger, Some(1000));
        // Bounds that contradict each other let nothing through.
        assert!(!q.fits_size(400 << 10) && !q.fits_size(20 << 20));
        let q = SearchQuery::parse("larger:10M");
        assert!(q.fits_size(11 << 20) && !q.fits_size(10 << 20));
        let q = SearchQuery::parse("larger:huge больше:-1M");
        assert_eq!(q.words, ["larger:huge", "больше:-1M"]);
        assert_eq!(q.larger, None);
    }

    #[test]
    fn a_calendar_year_is_exact() {
        let q = SearchQuery::parse("year:2024");
        assert_eq!(q.after, year_start(2024));
        assert_eq!(q.before, year_start(2025));
        let jan = Local.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap().timestamp();
        assert_eq!(q.after, Some(jan));
        assert_eq!(SearchQuery::parse("год:24").words, ["год:24"]);
    }

    #[test]
    fn ages_count_back_from_now() {
        let now = at(2026, 10, 5);
        let q = SearchQuery::parse_at("older:1y", now);
        assert_eq!(q.before, Some(at(2025, 10, 5).timestamp()));
        let q = SearchQuery::parse_at("старше:2г", now);
        assert_eq!(q.before, Some(at(2024, 10, 5).timestamp()));
        let q = SearchQuery::parse_at("newer:30d старше:6м", now);
        assert_eq!(q.after, Some(at(2026, 9, 5).timestamp()));
        assert_eq!(q.before, Some(at(2026, 4, 5).timestamp()));
        // A year and an age narrow each other.
        let q = SearchQuery::parse_at("year:2025 older:1y", now);
        assert_eq!(q.after, year_start(2025));
        assert_eq!(q.before, Some(at(2025, 10, 5).timestamp()));
        assert_eq!(SearchQuery::parse_at("older:soon", now).words, ["older:soon"]);
    }

    #[test]
    fn a_folder_alone_or_with_its_subfolders() {
        let q = SearchQuery::parse("в:Работа/*");
        assert_eq!((q.folder.as_deref(), q.subfolders), (Some("Работа"), true));
        let q = SearchQuery::parse("in:Work/Projects/*");
        assert_eq!((q.folder.as_deref(), q.subfolders), (Some("Work/Projects"), true));
        let q = SearchQuery::parse("in:Работа");
        assert_eq!((q.folder.as_deref(), q.subfolders), (Some("Работа"), false));
        // A bare "/*" names no folder.
        let q = SearchQuery::parse("in:/*");
        assert_eq!((q.folder.as_deref(), q.subfolders), (Some("/*"), false));
    }

    #[test]
    fn a_mailbox_by_name() {
        let q = SearchQuery::parse("ящик:work larger:25M");
        assert_eq!(q.account.as_deref(), Some("work"));
        assert!(q.words.is_empty());
    }

    #[test]
    fn from_with_bars_is_a_letter_from_either() {
        let q = SearchQuery::parse("from:olga@example.org|o.smirnova@example.com");
        assert_eq!(q.from, ["olga@example.org|o.smirnova@example.com"]);
        let keys: Vec<_> = imap_criteria(&q)
            .into_iter()
            .map(|c| (c.key, c.value.unwrap_or_default()))
            .collect();
        assert_eq!(
            keys,
            [
                ("OR", String::new()),
                ("FROM", "olga@example.org".to_owned()),
                ("FROM", "o.smirnova@example.com".to_owned())
            ]
        );
        let three = SearchQuery::parse("from:a@x|b@x|c@x");
        let keys: Vec<_> = imap_criteria(&three).iter().map(|c| c.key).collect();
        assert_eq!(keys, ["OR", "FROM", "OR", "FROM", "FROM"]);
        // One address stays one key.
        assert_eq!(imap_criteria(&SearchQuery::parse("from:a@x")).len(), 1);
        assert_eq!(alternatives("a@x"), ["a@x"]);
        assert_eq!(alternatives("a@x||b@x|"), ["a@x", "b@x"]);
    }

    #[test]
    fn important_is_an_operator_in_both_languages_and_stays_off_the_server() {
        for text in ["is:important", "это:важное", "Это:Важные"] {
            let q = SearchQuery::parse(text);
            assert!(q.important, "{text}");
            assert!(q.words.is_empty(), "{text}");
        }
        // The server is asked by the headers; what it finds is marked in the cache (sync.rs).
        let keys = imap_criteria(&SearchQuery::parse("is:important"));
        assert_eq!(keys.len(), 1);
        assert!(keys[0].key.contains("HEADER Importance high") && keys[0].key.contains("X-Priority 2"));
        assert!(keys[0].value.is_none());
        assert!(!SearchQuery::parse("is:flagged").important);
    }

    #[test]
    fn quotes_inside_an_address_stay() {
        // `"a b"@x`: the quotes belong to the address, not to the query syntax.
        let q = SearchQuery::parse(r#"from:"a b"@x.org"#);
        assert_eq!(q.from, [r#""a b"@x.org"#]);
        assert_eq!(imap_criteria(&q)[0].value.as_deref(), Some(r#""a b"@x.org"#));
        // A quoted value that ends the word is still unwrapped.
        assert_eq!(SearchQuery::parse(r#"from:"ivan petrov" док"#).from, ["ivan petrov"]);
        assert_eq!(SearchQuery::parse(r#""два слова" x"#).words, ["два слова", "x"]);
        // Only an `@` right after the closing quote makes it an address; punctuation does not.
        assert_eq!(SearchQuery::parse(r#""a b","#).words, ["a b,"]);
        assert_eq!(SearchQuery::parse(r#""a b"."#).words, ["a b."]);
        let q = SearchQuery::parse(r#"from:"a b","#);
        assert_eq!(imap_criteria(&q)[0].value.as_deref(), Some("a b,"));
    }

    #[test]
    fn maps_to_imap_keys() {
        let q = SearchQuery::parse("from:ivan договор is:flagged after:2026-10-03");
        let keys: Vec<_> = imap_criteria(&q).iter().map(|c| c.key).collect();
        assert_eq!(keys, ["TEXT", "FROM", "FLAGGED", "SINCE"]);
        assert_eq!(imap_criteria(&q)[3].value.as_deref(), Some("3-Oct-2026"));

        let q = SearchQuery::parse("larger:25M smaller:100M");
        let keys: Vec<_> = imap_criteria(&q)
            .into_iter()
            .map(|c| (c.key, c.value.unwrap_or_default()))
            .collect();
        assert_eq!(
            keys,
            [("LARGER", "26214400".to_owned()), ("SMALLER", "104857600".to_owned())]
        );

        // Beyond 32 bits a server answers BAD: the bounds are kept within them.
        let q = SearchQuery::parse("larger:5G");
        let larger = imap_criteria(&q);
        assert_eq!(
            (larger[0].key, larger[0].value.as_deref()),
            ("LARGER", Some("4294967295"))
        );
        assert!(imap_criteria(&SearchQuery::parse("smaller:5G")).is_empty());
        let q = SearchQuery::parse("smaller:4294967295");
        assert_eq!(imap_criteria(&q)[0].value.as_deref(), Some("4294967295"));
    }

    /// Central Europe around 29 March 2026: at 02:00 the clock jumps to 03:00.
    #[derive(Clone)]
    struct Spring;

    impl TimeZone for Spring {
        type Offset = chrono::FixedOffset;

        fn from_offset(_: &Self::Offset) -> Self {
            Spring
        }

        fn offset_from_local_date(&self, _: &NaiveDate) -> chrono::LocalResult<Self::Offset> {
            unimplemented!()
        }

        fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> chrono::LocalResult<Self::Offset> {
            let gap = NaiveDate::from_ymd_opt(2026, 3, 29)
                .unwrap()
                .and_hms_opt(2, 0, 0)
                .unwrap();
            let hour = |h| chrono::FixedOffset::east_opt(h * 3600).unwrap();
            if *local < gap {
                chrono::LocalResult::Single(hour(1))
            } else if *local < gap + Duration::hours(1) {
                chrono::LocalResult::None
            } else {
                chrono::LocalResult::Single(hour(2))
            }
        }

        fn offset_from_utc_date(&self, _: &NaiveDate) -> Self::Offset {
            unimplemented!()
        }

        fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> Self::Offset {
            let change = NaiveDate::from_ymd_opt(2026, 3, 29)
                .unwrap()
                .and_hms_opt(1, 0, 0)
                .unwrap();
            chrono::FixedOffset::east_opt(if *utc < change { 3600 } else { 7200 }).unwrap()
        }
    }

    #[test]
    fn an_age_landing_in_the_spring_gap_still_counts() {
        // A month before 29 April 02:30 is 29 March 02:30, a time the clock skipped.
        let now = Spring.with_ymd_and_hms(2026, 4, 29, 2, 30, 0).unwrap();
        let then = Spring.with_ymd_and_hms(2026, 3, 29, 3, 30, 0).unwrap();
        assert_eq!(ago_in(&Spring, "1m", now), Some(then.timestamp()));
        assert_eq!(ago_in(&Spring, "1м", now), Some(then.timestamp()));
    }
}
