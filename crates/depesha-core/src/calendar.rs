//! A meeting invitation in a letter (`text/calendar`, RFC 5545): the meeting the reading pane
//! shows as a card, its update and its cancellation, and why the card cannot be drawn.
//!
//! The core reads the file and says what it holds; the words and the reader's own time zone
//! belong to the interface. Times travel as the wall clock the calendar wrote plus the zone it
//! named, so a time in a zone the system knows (IANA, or the Windows name the table in
//! `windows_zones` translates) is turned into the reader's local time without a time zone
//! database in the core.

use chrono::{Datelike, NaiveDate};
use mail_parser::{Message, MessageParser, MessagePart, MimeHeaders};
use serde::{Deserialize, Serialize};

mod windows_zones;

/// What the calendar asks of the reader: an invitation, an answer to one, or its cancellation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Method {
    Request,
    Reply,
    Cancel,
    Publish,
    #[serde(other)]
    Other,
}

/// Why an invitation shows as a plain attachment instead of a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Problem {
    /// The file is no calendar at all: its text is not one, or it holds no `VCALENDAR`.
    NotCalendar,
    /// A calendar with no meeting the card could show: no `VEVENT`, or none with a start.
    NoEvent,
}

/// How often a meeting comes back (`FREQ`), and what a week's `BYDAY` names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Frequency {
    Daily,
    Weekly,
    Monthly,
    Yearly,
    #[serde(other)]
    Other,
}

/// A meeting's place in the day, as the calendar wrote it: a date, a wall clock and, when the
/// file named one, the zone that clock is in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Wall {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    /// The date without a time: the whole day.
    pub all_day: bool,
    /// The IANA zone name the calendar's `TZID` stands for, `UTC` for a time ending in `Z`.
    pub zone: Option<String>,
    /// What the file's own `VTIMEZONE` says the offset is, seconds east of UTC: the fallback
    /// for a zone name the interface cannot resolve.
    pub offset: Option<i32>,
}

/// A person of the invitation: the organizer or one of those invited.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Party {
    /// `CN`; empty when the file names no one, and the interface shows the address instead.
    pub name: String,
    pub email: String,
}

/// What a person is to the meeting: holds it (`CHAIR`), must come, may come, or is only told.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Role {
    Chair,
    Required,
    Optional,
    NonParticipant,
    #[serde(other)]
    Other,
}

/// What a person answered the invitation with (`PARTSTAT`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Participation {
    Accepted,
    Declined,
    Tentative,
    NeedsAction,
    Delegated,
    #[serde(other)]
    Other,
}

/// One of those invited, with what the organizer asked of them and what they answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Attendee {
    pub name: String,
    pub email: String,
    pub role: Option<Role>,
    pub status: Option<Participation>,
}

/// The rule a meeting repeats by (`RRULE`), as far as the card shows it: how often, and on which
/// days. Anything else the rule says is left to the interface to call «repeats».
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Repeat {
    pub freq: Frequency,
    /// `INTERVAL`: every other day, every third week; 1 when the file does not say.
    pub interval: u32,
    /// Days of the week the rule names, 1 is Monday and 7 is Sunday, as RFC 5545 counts them.
    pub days: Vec<u8>,
    /// `BYMONTHDAY`: the day of the month a monthly meeting falls on.
    pub month_day: Option<u32>,
}

/// A meeting of the calendar, as the card shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Meeting {
    pub uid: Option<String>,
    /// The number of the invitation's version (`SEQUENCE`): a larger one is an update.
    pub sequence: u32,
    /// The name of the meeting, without the word the sender's client put in front of it.
    pub title: String,
    /// `STATUS:CANCELLED`: the meeting is off.
    pub cancelled: bool,
    pub start: Wall,
    pub end: Option<Wall>,
    pub all_day: bool,
    pub location: Option<String>,
    /// Where the meeting is held online, from the file or from the first link of its text.
    pub link: Option<String>,
    pub organizer: Option<Party>,
    pub attendees: Vec<Attendee>,
    pub repeat: Option<Repeat>,
    pub description: Option<String>,
}

/// What a calendar part of a letter holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Notice {
    pub method: Method,
    /// `METHOD:CANCEL`, or `STATUS:CANCELLED` in the meeting itself.
    pub cancelled: bool,
    /// `SEQUENCE` of the first meeting: a number above zero is at least an update.
    pub sequence: u32,
    /// The `.ics` attachment the calendar came as, for «Save .ics»; none when the calendar is
    /// one of the letter's alternative forms and there is no file to save.
    pub file: Option<u32>,
    pub problem: Option<Problem>,
    pub events: Vec<Meeting>,
    /// The same meeting in an earlier letter of the conversation, with a smaller `SEQUENCE`:
    /// what the card shows as «was → is». Filled by the caller that can read earlier letters.
    #[serde(default)]
    pub previous: Option<Box<Meeting>>,
}

/// How many meetings of one file the card carries: a file with more is shown by its first and a
/// count, so there is no use in reading all of them.
const MAX_EVENTS: usize = 20;

/// What a calendar part says, or why its card cannot be drawn. `file` is the attachment the
/// calendar is, so that the card can save it.
pub fn read(text: &[u8], file: Option<u32>) -> Notice {
    let lines = logical_lines(text);
    let mut notice = Notice {
        method: Method::Other,
        cancelled: false,
        sequence: 0,
        file,
        problem: None,
        events: Vec::new(),
        previous: None,
    };
    let mut zones: Vec<Zone> = Vec::new();
    let mut calendar = false;
    let mut zone: Option<Zone> = None;
    let mut observance: Option<Observance> = None;
    let mut meeting: Option<Vec<Line<'_>>> = None;
    let mut meetings: Vec<Vec<Line<'_>>> = Vec::new();
    for text in &lines {
        let text = text.trim_end_matches(['\r', '\t']);
        let Some(line) = Line::parse(text) else {
            continue;
        };
        let name = line.name.to_ascii_uppercase();
        match name.as_str() {
            "BEGIN" => match line.value.trim().to_ascii_uppercase().as_str() {
                "VCALENDAR" => calendar = true,
                "VTIMEZONE" => zone = Some(Zone::default()),
                "STANDARD" | "DAYLIGHT" => observance = Some(Observance::new()),
                "VEVENT" => meeting = Some(Vec::new()),
                _ => {}
            },
            "END" => match line.value.trim().to_ascii_uppercase().as_str() {
                "VEVENT" => meetings.extend(meeting.take()),
                "STANDARD" | "DAYLIGHT" => {
                    if let (Some(observance), Some(zone)) = (observance.take(), zone.as_mut()) {
                        zone.observances.push(observance);
                    }
                }
                "VTIMEZONE" => zones.extend(zone.take()),
                _ => {}
            },
            // `METHOD` stands on the calendar itself, not inside a meeting or a zone.
            "METHOD" if meeting.is_none() && observance.is_none() && zone.is_none() => {
                notice.method = method(line.value.trim());
            }
            _ => {
                if let Some(observance) = observance.as_mut() {
                    observance.prop(&line);
                } else if let Some(meeting) = meeting.as_mut() {
                    meeting.push(line);
                } else if let Some(zone) = zone.as_mut()
                    && name == "TZID"
                {
                    zone.id = unescape(line.value.trim());
                }
            }
        }
    }
    // A meeting is read after the walk: the zone it names may stand below it in the file.
    notice.events = meetings
        .iter()
        .take(MAX_EVENTS)
        .filter_map(|props| meeting_of(props, &zones))
        .collect();
    notice.cancelled = notice.method == Method::Cancel || notice.events.iter().any(|m| m.cancelled);
    notice.sequence = notice.events.first().map_or(0, |m| m.sequence);
    if notice.events.is_empty() {
        notice.problem = Some(if calendar {
            Problem::NoEvent
        } else {
            Problem::NotCalendar
        });
    }
    notice
}

/// The calendar of a letter: its `.ics` attachment, or a `text/calendar` part of one of its
/// alternative forms — which is no file, and has nothing to save.
pub fn of_message(msg: &Message<'_>) -> Option<Notice> {
    // The file first: that is what the reader can save, and what the letter's list of files has.
    for (at, &id) in msg.attachments.iter().enumerate() {
        let Some(part) = msg.parts.get(id as usize) else {
            continue;
        };
        if calendar_part(part) == Some(true)
            && let Some(text) = text_of(part)
        {
            return Some(read(text.as_bytes(), Some(at as u32)));
        }
    }
    // A calendar that is one of the letter's alternative forms is no file of it.
    for part in &msg.parts {
        if calendar_part(part) == Some(false)
            && let Some(text) = text_of(part)
        {
            return Some(read(text.as_bytes(), None));
        }
    }
    None
}

/// The calendar of a whole letter, for the earlier letter of a conversation that holds the same
/// meeting.
pub fn from_message(raw: &[u8]) -> Option<Notice> {
    let msg = MessageParser::default().parse(raw)?;
    of_message(&msg)
}

/// Whether the part is a calendar of the letter, and whether it came as a file of it — a name
/// or a disposition to save it — rather than as one of the letter's alternative forms.
pub(crate) fn calendar_part(part: &MessagePart<'_>) -> Option<bool> {
    let calendar = part.content_type().is_some_and(|ct| {
        let subtype = ct.subtype().unwrap_or_default();
        (ct.ctype().eq_ignore_ascii_case("text") && subtype.eq_ignore_ascii_case("calendar"))
            || (ct.ctype().eq_ignore_ascii_case("application") && subtype.eq_ignore_ascii_case("ics"))
    }) || part
        .attachment_name()
        .is_some_and(|name| name.to_ascii_lowercase().ends_with(".ics"));
    if !calendar {
        return None;
    }
    let named = part.attachment_name().is_some();
    let attached = part.content_disposition().is_some_and(|d| d.is_attachment());
    Some(named || attached)
}

fn text_of(part: &MessagePart<'_>) -> Option<String> {
    part.text_contents()
        .map(str::to_owned)
        .or_else(|| Some(String::from_utf8_lossy(part.contents()).into_owned()))
}

fn method(value: &str) -> Method {
    match value.to_ascii_uppercase().as_str() {
        "REQUEST" => Method::Request,
        "REPLY" => Method::Reply,
        "CANCEL" => Method::Cancel,
        "PUBLISH" => Method::Publish,
        _ => Method::Other,
    }
}

/// The lines of the file as RFC 5545 means them: a line that starts with a space or a tab
/// continues the one before, and the two are one line whose bytes are joined before anything
/// reads them as text. A fold may part a letter's UTF-8 bytes or an escape (`\` and `n`), so
/// joining the bytes first is what keeps them whole.
fn logical_lines(raw: &[u8]) -> Vec<String> {
    let mut joined: Vec<Vec<u8>> = Vec::new();
    for physical in raw.split(|&b| b == b'\n') {
        let line = physical.strip_suffix(b"\r").unwrap_or(physical);
        match (line.first(), joined.last_mut()) {
            (Some(b' ' | b'\t'), Some(previous)) => previous.extend_from_slice(&line[1..]),
            _ => joined.push(line.to_vec()),
        }
    }
    joined
        .into_iter()
        .map(|line| String::from_utf8_lossy(&line).into_owned())
        .collect()
}

/// One `NAME;PARAM=VALUE:value` line: the name, its parameters and the value, still escaped.
struct Line<'a> {
    name: &'a str,
    params: Vec<(&'a str, String)>,
    value: &'a str,
}

impl<'a> Line<'a> {
    fn parse(text: &'a str) -> Option<Self> {
        let (head, value) = split_once(text, ':')?;
        let mut parts = split(head, ';');
        let name = parts.next()?.trim();
        if name.is_empty() {
            return None;
        }
        let params = parts
            .filter_map(|part| {
                let (key, value) = split_once(part, '=')?;
                Some((key.trim(), unquote(value.trim())))
            })
            .collect();
        Some(Self { name, params, value })
    }

    fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
            .filter(|value| !value.is_empty())
    }
}

/// Splits at the first `at` that is not inside a quoted parameter value.
fn split_once(text: &str, at: char) -> Option<(&str, &str)> {
    let mut quoted = false;
    for (i, c) in text.char_indices() {
        match c {
            '"' => quoted = !quoted,
            c if c == at && !quoted => return Some((&text[..i], &text[i + c.len_utf8()..])),
            _ => {}
        }
    }
    None
}

/// The parts of `text` between `at`s that are not inside quotes.
fn split(text: &str, at: char) -> impl Iterator<Item = &str> {
    let mut rest = text;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let (head, tail) = split_once(rest, at).unwrap_or((rest, ""));
        rest = tail;
        Some(head)
    })
}

fn unquote(value: &str) -> String {
    value.trim_matches('"').to_owned()
}

/// The value of a property as RFC 5545 escapes it: `\,`, `\;` and `\n` are characters of the
/// text, not parts of it.
fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(next) => out.push(next),
            None => out.push('\\'),
        }
    }
    out
}

/// The name of the meeting without the word the sender's client wrote in front of it: Exchange
/// puts «Canceled:» and «Updated:» into `SUMMARY`, and the subject of the letter has it too.
fn title(value: &str) -> String {
    const WORDS: [&str; 9] = [
        "canceled:",
        "cancelled:",
        "updated:",
        "accepted:",
        "declined:",
        "tentative:",
        "re:",
        "fw:",
        "fwd:",
    ];
    let mut text = value.trim();
    loop {
        let lower = text.to_ascii_lowercase();
        let Some(word) = WORDS.iter().find(|w| lower.starts_with(*w)) else {
            break;
        };
        text = text[word.len()..].trim_start();
    }
    text.to_owned()
}

/// A `VTIMEZONE` of the file: what daylight saving does to the meeting's own zone there.
#[derive(Debug, Default, Clone)]
struct Zone {
    id: String,
    observances: Vec<Observance>,
}

/// One `STANDARD` or `DAYLIGHT` block of a `VTIMEZONE`: an offset and, when the file says so, the
/// rule that puts the zone into it each year.
#[derive(Debug, Clone)]
struct Observance {
    offset_to: Option<i32>,
    by_month: Option<u32>,
    by_day: Option<(i8, u8)>,
    by_month_day: Option<u32>,
}

impl Observance {
    fn new() -> Self {
        Self {
            offset_to: None,
            by_month: None,
            by_day: None,
            by_month_day: None,
        }
    }

    fn prop(&mut self, line: &Line<'_>) {
        for (key, value) in rule_parts(line.value) {
            match key.as_str() {
                "BYMONTH" => self.by_month = value.parse().ok(),
                "BYMONTHDAY" => self.by_month_day = value.parse().ok(),
                "BYDAY" => self.by_day = by_day(&value),
                _ => {}
            }
        }
        if line.name.eq_ignore_ascii_case("TZOFFSETTO") {
            self.offset_to = offset(&unescape(line.value));
        }
    }

    /// The day of `year` the zone changes on, when the rule says it in the way the card reads.
    fn transition(&self, year: i32) -> Option<(u32, u32)> {
        let month = self.by_month?;
        if let Some(day) = self.by_month_day {
            return Some((month, day));
        }
        let (ordinal, weekday) = self.by_day?;
        nth_weekday(year, month, weekday, ordinal)
    }

    fn offset(&self) -> Option<i32> {
        self.offset_to
    }
}

/// `+0300` and `-0430` as seconds east of UTC.
fn offset(value: &str) -> Option<i32> {
    let text = value.trim().trim_start_matches("GMT").trim_matches('"');
    let sign = match text.chars().next()? {
        '+' => 1,
        '-' => -1,
        _ => return None,
    };
    let rest = &text[1..];
    let (hours, minutes) = match rest.len() {
        4 => (rest[..2].parse::<i32>().ok()?, rest[2..].parse::<i32>().ok()?),
        6 => (rest[..2].parse::<i32>().ok()?, rest[2..4].parse::<i32>().ok()?),
        _ => return None,
    };
    Some(sign * (hours * 3600 + minutes * 60))
}

/// The day of a month that falls on `weekday` (1 is Monday) for the `ordinal`th time: 2 is the
/// second one, -1 the last.
fn nth_weekday(year: i32, month: u32, weekday: u8, ordinal: i8) -> Option<(u32, u32)> {
    let first = NaiveDate::from_ymd_opt(year, month, 1)?;
    let target = chrono::Weekday::try_from(weekday.saturating_sub(1)).ok()?;
    let shift =
        (i64::from(target.num_days_from_monday()) - i64::from(first.weekday().num_days_from_monday())).rem_euclid(7);
    let first_day = 1 + shift as u32;
    let days = days_in_month(year, month)?;
    let day = if ordinal > 0 {
        first_day + (ordinal.unsigned_abs() as u32 - 1) * 7
    } else {
        days - (days - first_day) % 7 - (ordinal.unsigned_abs() as u32 - 1) * 7
    };
    (1..=days).contains(&day).then_some((month, day))
}

fn days_in_month(year: i32, month: u32) -> Option<u32> {
    let (year, month) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    let first = NaiveDate::from_ymd_opt(year, month, 1)?;
    Some((first - chrono::Days::new(1)).day())
}

/// `FREQ=WEEKLY;BYDAY=TU` as its parts of upper case names and their values.
fn rule_parts(value: &str) -> Vec<(String, String)> {
    value
        .split(';')
        .filter_map(|part| {
            let (key, value) = part.split_once('=')?;
            Some((key.trim().to_ascii_uppercase(), value.trim().to_owned()))
        })
        .collect()
}

/// `TU` and `-1SU` as a day of the week (1 is Monday) and, when the file gives one, its ordinal.
fn by_day(value: &str) -> Option<(i8, u8)> {
    let name = value.trim();
    let letters = name.len();
    let days = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
    let at = days
        .iter()
        .position(|d| d.eq_ignore_ascii_case(&name[letters.saturating_sub(2)..]))?;
    let ordinal = name[..letters.saturating_sub(2)].parse().unwrap_or(0);
    Some((ordinal, at as u8 + 1))
}

fn repeat(value: &str) -> Option<Repeat> {
    let mut repeat = Repeat {
        freq: Frequency::Other,
        interval: 1,
        days: Vec::new(),
        month_day: None,
    };
    for (key, value) in rule_parts(value) {
        match key.as_str() {
            "FREQ" => {
                repeat.freq = match value.to_ascii_uppercase().as_str() {
                    "DAILY" => Frequency::Daily,
                    "WEEKLY" => Frequency::Weekly,
                    "MONTHLY" => Frequency::Monthly,
                    "YEARLY" => Frequency::Yearly,
                    _ => Frequency::Other,
                }
            }
            "INTERVAL" => repeat.interval = value.parse().unwrap_or(1).max(1),
            "BYMONTHDAY" => repeat.month_day = value.parse().ok(),
            "BYDAY" => repeat.days = value.split(',').filter_map(|d| by_day(d).map(|(_, day)| day)).collect(),
            _ => {}
        }
    }
    Some(repeat)
}

/// The wall clock a `DTSTART`, `DTEND` or `DTSTAMP`-like property holds.
fn wall(line: &Line<'_>, zones: &[Zone]) -> Option<Wall> {
    let value = line.value.trim();
    let digits = |from: usize, to: usize| value.get(from..to)?.parse::<u32>().ok();
    let year = i32::try_from(digits(0, 4)?).ok()?;
    let month = digits(4, 6)?;
    let day = digits(6, 8)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let all_day = value.len() == 8;
    let (hour, minute) = if all_day {
        (0, 0)
    } else {
        if value.as_bytes().get(8).is_none_or(|b| *b != b'T') {
            return None;
        }
        (digits(9, 11)?, digits(11, 13)?)
    };
    let mut wall = Wall {
        year,
        month,
        day,
        hour,
        minute,
        all_day,
        zone: None,
        offset: None,
    };
    if value.len() > 15 && value.as_bytes().get(15) == Some(&b'Z') {
        wall.zone = Some("UTC".to_owned());
        wall.offset = Some(0);
        return Some(wall);
    }
    let Some(tzid) = line.param("TZID") else {
        return Some(wall);
    };
    let tzid = unescape(tzid);
    wall.zone = zone_name(&tzid);
    wall.offset = zones
        .iter()
        .find(|zone| zone.id.eq_ignore_ascii_case(&tzid))
        .and_then(|zone| zone_offset(zone, &wall));
    Some(wall)
}

/// The IANA name a `TZID` stands for: itself when it is one, else the name Windows gives it.
fn zone_name(tzid: &str) -> Option<String> {
    let name = tzid.trim();
    if name.is_empty() {
        return None;
    }
    if name.eq_ignore_ascii_case("UTC") || name.eq_ignore_ascii_case("GMT") || name.eq_ignore_ascii_case("Z") {
        return Some("UTC".to_owned());
    }
    if let Some(iana) = windows_zones::iana(name) {
        return Some(iana.to_owned());
    }
    Some(name.to_owned())
}

/// The offset the file's own `VTIMEZONE` puts this zone into at the meeting's wall clock.
fn zone_offset(zone: &Zone, at: &Wall) -> Option<i32> {
    let offsets: Vec<i32> = zone.observances.iter().filter_map(Observance::offset).collect();
    let first = *offsets.first()?;
    if offsets.iter().all(|o| *o == first) {
        return Some(first);
    }
    // The last change this year that the meeting comes after; before the year's first one the
    // zone is still in the offset of last year's last change.
    let mut before: Option<(u32, u32, i32)> = None;
    let mut any: Option<(u32, u32, i32)> = None;
    for observance in &zone.observances {
        let (Some(offset), Some((month, day))) = (observance.offset(), observance.transition(at.year)) else {
            continue;
        };
        if any.is_none_or(|(m, d, _)| (month, day) > (m, d)) {
            any = Some((month, day, offset));
        }
        if (month, day) <= (at.month, at.day) && before.is_none_or(|(m, d, _)| (month, day) > (m, d)) {
            before = Some((month, day, offset));
        }
    }
    before.or(any).map(|(_, _, offset)| offset)
}

/// The meeting of one `VEVENT`, when it has a start the card can show.
fn meeting_of(props: &[Line<'_>], zones: &[Zone]) -> Option<Meeting> {
    let get = |name: &str| props.iter().find(|line| line.name.eq_ignore_ascii_case(name));
    let text = |line: &Line<'_>| unescape(line.value).trim().to_owned();
    let start = get("DTSTART").and_then(|line| wall(line, zones))?;
    let end = get("DTEND").and_then(|line| wall(line, zones));
    let all_day = start.all_day
        || get("X-MICROSOFT-CDO-ALLDAYEVENT").is_some_and(|line| line.value.trim().eq_ignore_ascii_case("TRUE"));
    let description = get("DESCRIPTION").map(text).filter(|t| !t.is_empty());
    let link = [
        "X-MICROSOFT-SKYPETEAMSMEETINGURL",
        "X-MICROSOFT-ONLINEMEETINGCONFLINK",
        "X-GOOGLE-CONFERENCE",
        "URL",
    ]
    .iter()
    .find_map(|name| get(name).map(text))
    .filter(|value| value.starts_with("http"))
    .or_else(|| description.as_deref().and_then(first_link));
    Some(Meeting {
        uid: get("UID").map(text).filter(|uid| !uid.is_empty()),
        sequence: get("SEQUENCE")
            .and_then(|line| line.value.trim().parse().ok())
            .unwrap_or(0),
        title: get("SUMMARY").map(|line| title(&text(line))).unwrap_or_default(),
        cancelled: get("STATUS").is_some_and(|line| line.value.trim().eq_ignore_ascii_case("CANCELLED")),
        start,
        end,
        all_day,
        location: get("LOCATION").map(text).filter(|place| !place.is_empty()),
        link,
        organizer: get("ORGANIZER").map(|line| party(line, line.param("CN"))),
        attendees: props
            .iter()
            .filter(|line| line.name.eq_ignore_ascii_case("ATTENDEE"))
            .map(|line| {
                let role = line.param("ROLE").map(role);
                let status = line.param("PARTSTAT").map(participation);
                let party = party(line, line.param("CN"));
                Attendee {
                    name: party.name,
                    email: party.email,
                    role,
                    status,
                }
            })
            .collect(),
        repeat: get("RRULE").and_then(|line| repeat(line.value)),
        description,
    })
}

/// The person a `ORGANIZER` or `ATTENDEE` line names: the `CN` when the file gives one.
fn party(line: &Line<'_>, name: Option<&str>) -> Party {
    let address = unescape(line.value);
    let email = address
        .trim()
        .strip_prefix("mailto:")
        .or_else(|| address.trim().strip_prefix("MAILTO:"))
        .unwrap_or(address.trim())
        .to_owned();
    Party {
        name: name.map(unescape).unwrap_or_default().trim().to_owned(),
        email,
    }
}

fn role(value: &str) -> Role {
    match value.trim().to_ascii_uppercase().as_str() {
        "CHAIR" => Role::Chair,
        "REQ-PARTICIPANT" => Role::Required,
        "OPT-PARTICIPANT" => Role::Optional,
        "NON-PARTICIPANT" => Role::NonParticipant,
        _ => Role::Other,
    }
}

fn participation(value: &str) -> Participation {
    match value.trim().to_ascii_uppercase().as_str() {
        "ACCEPTED" => Participation::Accepted,
        "DECLINED" => Participation::Declined,
        "TENTATIVE" => Participation::Tentative,
        "NEEDS-ACTION" => Participation::NeedsAction,
        "DELEGATED" => Participation::Delegated,
        _ => Participation::Other,
    }
}

/// The first web address of a meeting's text: the way into it online, when the file names no
/// property for one.
fn first_link(text: &str) -> Option<String> {
    let start = text.find("http").filter(|at| {
        let rest = &text[*at..];
        rest.starts_with("http://") || rest.starts_with("https://")
    })?;
    let rest = &text[start..];
    let end = rest.find([' ', '\n', '\t', '<', '>', '"', ')']).unwrap_or(rest.len());
    Some(rest[..end].trim_end_matches(['.', ',', ';']).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CRLF: &[u8] = b"\r\n";
    const LF: &[u8] = b"\n";

    fn push(raw: &mut Vec<u8>, line: &str, eol: &[u8]) {
        raw.extend_from_slice(line.as_bytes());
        raw.extend_from_slice(eol);
    }

    /// A line parted in two by RFC 5545's fold, at the byte `at`: the reader must join the bytes
    /// before it decodes them, because the cut may fall inside a letter.
    fn push_folded(raw: &mut Vec<u8>, line: &str, at: usize, eol: &[u8]) {
        raw.extend_from_slice(line.as_bytes().get(..at).unwrap_or_default());
        raw.extend_from_slice(CRLF);
        raw.push(b' ');
        raw.extend_from_slice(line.as_bytes().get(at..).unwrap_or_default());
        raw.extend_from_slice(eol);
    }

    /// The invitation of the tests: the shape Exchange sends, with every awkwardness of it —
    /// CRLF and bare LF, folds inside a letter and inside an escape, parameters in quotes and
    /// without, a Windows zone name with its `VTIMEZONE`, and no empty line at the end.
    fn invitation() -> Vec<u8> {
        let mut raw = Vec::new();
        push(&mut raw, "BEGIN:VCALENDAR", CRLF);
        push(&mut raw, "METHOD:REQUEST", CRLF);
        push(&mut raw, "PRODID:-//Example Org//Example Mailer 1.0//EN", LF);
        push(&mut raw, "VERSION:2.0", CRLF);
        push(&mut raw, "BEGIN:VTIMEZONE", CRLF);
        push(&mut raw, "TZID:Russian Standard Time", CRLF);
        push(&mut raw, "BEGIN:STANDARD", CRLF);
        push(&mut raw, "DTSTART:16010101T000000", CRLF);
        push(&mut raw, "TZOFFSETFROM:+0300", CRLF);
        push(&mut raw, "TZOFFSETTO:+0300", CRLF);
        push(&mut raw, "END:STANDARD", CRLF);
        push(&mut raw, "BEGIN:DAYLIGHT", CRLF);
        push(&mut raw, "DTSTART:16010101T000000", CRLF);
        push(&mut raw, "TZOFFSETFROM:+0300", CRLF);
        push(&mut raw, "TZOFFSETTO:+0300", CRLF);
        push(&mut raw, "END:DAYLIGHT", CRLF);
        push(&mut raw, "END:VTIMEZONE", CRLF);
        push(&mut raw, "BEGIN:VEVENT", CRLF);
        // The name of the organizer is cut inside a Cyrillic letter.
        let organizer = "ORGANIZER;CN=Марина Ковалёва:MAILTO:marina@example.org";
        let inside = organizer.char_indices().map(|(i, _)| i).find(|i| *i > 20).unwrap_or(21) + 1;
        push_folded(&mut raw, organizer, inside, CRLF);
        // One of those invited has a comma in the name: the parameter is quoted because of it.
        push_folded(
            &mut raw,
            "ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE;CN=\"Иванов, Пётр\":MAILTO:petr@example.org",
            62,
            CRLF,
        );
        push_folded(
            &mut raw,
            "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Ольга Тестова:MAILTO:olga@example.org",
            70,
            LF,
        );
        // The escape `\n` is parted by the fold: `\` ends one line, `n` starts the next.
        let description = "DESCRIPTION;LANGUAGE=ru-RU:Повестка:\\nПервое\\, второе\\; третье\\nПодключиться: https://meet.example.org/room-1";
        let at = description.find("\\nПервое").unwrap_or(20) + 1;
        push_folded(&mut raw, description, at, CRLF);
        push_folded(
            &mut raw,
            "UID:040000008200E00074C5B7101A82E0080000-7A1B-4C2D-9E3F-EXAMPLE-0001",
            60,
            CRLF,
        );
        push_folded(
            &mut raw,
            "SUMMARY;LANGUAGE=ru-RU:Canceled: Заседание рабочей группы: отчётность, заявки",
            74,
            LF,
        );
        push(&mut raw, "DTSTART;TZID=Russian Standard Time:20261106T150000", CRLF);
        push(&mut raw, "DTEND;TZID=Russian Standard Time:20261106T160000", CRLF);
        push(&mut raw, "LOCATION;LANGUAGE=ru-RU:Переговорная 4", CRLF);
        push(&mut raw, "STATUS:CONFIRMED", CRLF);
        push(&mut raw, "SEQUENCE:2", CRLF);
        push(&mut raw, "X-MICROSOFT-CDO-ALLDAYEVENT:FALSE", CRLF);
        push(&mut raw, "END:VEVENT", CRLF);
        push(&mut raw, "END:VCALENDAR", CRLF);
        while raw.last() == Some(&b'\n') || raw.last() == Some(&b'\r') {
            raw.pop();
        }
        raw
    }

    fn read_invitation() -> Notice {
        read(&invitation(), Some(0))
    }

    #[test]
    fn a_folded_invitation_reads_whole() {
        let notice = read_invitation();
        assert_eq!(notice.method, Method::Request);
        assert!(!notice.cancelled);
        assert_eq!(notice.sequence, 2);
        assert_eq!(notice.file, Some(0));
        assert_eq!(notice.problem, None);
        let [meeting] = notice.events.as_slice() else {
            panic!("one meeting expected, got {:?}", notice.events);
        };
        // The fold inside a letter and the word Exchange puts in front of the name.
        assert_eq!(meeting.title, "Заседание рабочей группы: отчётность, заявки");
        assert_eq!(meeting.start.year, 2026);
        assert_eq!((meeting.start.month, meeting.start.day), (11, 6));
        assert_eq!((meeting.start.hour, meeting.start.minute), (15, 0));
        assert_eq!((meeting.end.as_ref().map(|e| e.hour)), Some(16));
        // The Windows name is the reader's «Москва»; the file's own zone says what it is off UTC.
        assert_eq!(meeting.start.zone.as_deref(), Some("Europe/Moscow"));
        assert_eq!(meeting.start.offset, Some(3 * 3600));
        assert!(!meeting.all_day);
        assert_eq!(meeting.location.as_deref(), Some("Переговорная 4"));
        assert_eq!(meeting.link.as_deref(), Some("https://meet.example.org/room-1"));
        let organizer = meeting.organizer.as_ref().expect("an organizer");
        assert_eq!(organizer.name, "Марина Ковалёва");
        assert_eq!(organizer.email, "marina@example.org");
        assert_eq!(meeting.attendees.len(), 2);
        // The quoted name keeps its comma; the fold inside the name is joined.
        assert_eq!(meeting.attendees[0].name, "Иванов, Пётр");
        assert_eq!(meeting.attendees[0].email, "petr@example.org");
        assert_eq!(meeting.attendees[0].role, Some(Role::Optional));
        assert_eq!(meeting.attendees[0].status, Some(Participation::Accepted));
        assert_eq!(meeting.attendees[1].name, "Ольга Тестова");
        assert_eq!(meeting.attendees[1].role, Some(Role::Required));
        assert_eq!(meeting.attendees[1].status, Some(Participation::NeedsAction));
        // `\n` parted by a fold is a line break; `\,` and `\;` are the characters themselves.
        let description = meeting.description.as_deref().expect("a description");
        assert!(
            description.starts_with("Повестка:\nПервое, второе; третье\n"),
            "{description}"
        );
    }

    /// A calendar of one meeting, for the states the card tells apart.
    fn calendar(method: &str, body: &[&str]) -> Vec<u8> {
        let mut raw = String::from("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n");
        raw.push_str(&format!("METHOD:{method}\r\nBEGIN:VEVENT\r\n"));
        for line in body {
            raw.push_str(line);
            raw.push_str("\r\n");
        }
        raw.push_str("END:VEVENT\r\nEND:VCALENDAR\r\n");
        raw.into_bytes()
    }

    const WHEN: [&str; 2] = [
        "DTSTART;TZID=Europe/Moscow:20261106T150000",
        "DTEND;TZID=Europe/Moscow:20261106T160000",
    ];

    #[test]
    fn a_cancellation_is_told_by_the_method_and_by_the_status() {
        let mut body = WHEN.to_vec();
        body.extend(["SUMMARY:Встреча", "STATUS:CANCELLED", "SEQUENCE:3"]);
        let notice = read(&calendar("CANCEL", &body), None);
        assert_eq!(notice.method, Method::Cancel);
        assert!(notice.cancelled);
        assert!(notice.events[0].cancelled);

        // The same meeting cancelled in a letter sent as a request: STATUS alone says it.
        let mut body = WHEN.to_vec();
        body.extend(["SUMMARY:Встреча", "STATUS:CANCELLED"]);
        assert!(read(&calendar("REQUEST", &body), None).cancelled);
    }

    #[test]
    fn an_answer_of_one_participant_is_a_reply() {
        let mut body = WHEN.to_vec();
        body.extend([
            "SUMMARY:Встреча",
            "ATTENDEE;PARTSTAT=DECLINED;CN=Пётр Примеров:MAILTO:petr@example.org",
        ]);
        let notice = read(&calendar("REPLY", &body), None);
        assert_eq!(notice.method, Method::Reply);
        assert_eq!(notice.events[0].attendees[0].status, Some(Participation::Declined));
    }

    #[test]
    fn a_date_without_a_time_is_the_whole_day() {
        let notice = read(
            &calendar(
                "REQUEST",
                &[
                    "SUMMARY:День без встреч",
                    "DTSTART;VALUE=DATE:20261106",
                    "DTEND;VALUE=DATE:20261107",
                ],
            ),
            None,
        );
        let meeting = &notice.events[0];
        assert!(meeting.all_day);
        assert!(meeting.start.all_day);
        assert_eq!(meeting.start.hour, 0);
        // No `Z` and no `TZID`: the date is the same wherever the reader is.
        assert_eq!(meeting.start.zone, None);
    }

    #[test]
    fn an_all_day_flag_marks_the_meeting_too() {
        let mut body = WHEN.to_vec();
        body.extend(["SUMMARY:День без встреч", "X-MICROSOFT-CDO-ALLDAYEVENT:TRUE"]);
        assert!(read(&calendar("REQUEST", &body), None).events[0].all_day);
    }

    #[test]
    fn a_zone_with_daylight_saving_takes_the_offset_of_the_meeting_s_date() {
        let mut text = String::from(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VTIMEZONE\r\n\
             TZID:W. Europe Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16010101T030000\r\n\
             TZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\n\
             END:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:16010101T020000\r\nTZOFFSETFROM:+0100\r\n\
             TZOFFSETTO:+0200\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\nEND:DAYLIGHT\r\n\
             END:VTIMEZONE\r\nBEGIN:VEVENT\r\nSUMMARY:Встреча\r\n\
             DTSTART;TZID=W. Europe Standard Time:20260714T100000\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nSUMMARY:Встреча\r\n\
             DTSTART;TZID=W. Europe Standard Time:20260114T100000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        );
        text.push_str("");
        let notice = read(text.as_bytes(), None);
        assert_eq!(notice.events[0].start.zone.as_deref(), Some("Europe/Berlin"));
        // The last Sunday of March has passed by July, and of October has not.
        assert_eq!(notice.events[0].start.offset, Some(2 * 3600));
        // January is after the last Sunday of October and before the one of March.
        assert_eq!(notice.events[1].start.offset, Some(3600));
        assert_eq!(nth_weekday(2026, 3, 7, -1), Some((3, 29)));
        assert_eq!(nth_weekday(2026, 10, 7, -1), Some((10, 25)));
        assert_eq!(nth_weekday(2026, 11, 2, 1), Some((11, 3)));
    }

    #[test]
    fn a_time_in_utc_stands_as_utc() {
        let notice = read(
            &calendar(
                "REQUEST",
                &["SUMMARY:Встреча", "DTSTART:20261106T120000Z", "DTEND:20261106T130000Z"],
            ),
            None,
        );
        let meeting = &notice.events[0];
        assert_eq!(meeting.start.zone.as_deref(), Some("UTC"));
        assert_eq!(meeting.start.offset, Some(0));
        assert_eq!(meeting.start.hour, 12);
    }

    #[test]
    fn a_file_of_several_meetings_holds_them_all() {
        let mut raw = String::from("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\n");
        for (title, day) in [("Первая", 9), ("Вторая", 16), ("Третья", 23)] {
            raw.push_str("BEGIN:VEVENT\r\n");
            raw.push_str(&format!("SUMMARY:{title}\r\n"));
            raw.push_str(&format!("DTSTART;TZID=Europe/Moscow:202611{day:02}T110000\r\n"));
            raw.push_str("END:VEVENT\r\n");
        }
        raw.push_str("END:VCALENDAR\r\n");
        let notice = read(raw.as_bytes(), None);
        assert_eq!(notice.events.len(), 3);
        assert_eq!(notice.events[2].start.day, 23);
        assert_eq!(notice.events[2].title, "Третья");
    }

    #[test]
    fn a_file_that_is_no_calendar_says_so_and_keeps_its_place() {
        let notice = read(b"\x00\x01not a calendar", Some(3));
        assert_eq!(notice.problem, Some(Problem::NotCalendar));
        assert!(notice.events.is_empty());
        assert_eq!(notice.file, Some(3));

        let notice = read(b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n", None);
        assert_eq!(notice.problem, Some(Problem::NoEvent));

        // A meeting without a start cannot be put into a day: it is no meeting for the card.
        let notice = read(&calendar("REQUEST", &["SUMMARY:Без начала"]), None);
        assert_eq!(notice.problem, Some(Problem::NoEvent));
    }

    #[test]
    fn a_repeating_meeting_says_how_often_and_which_days() {
        let weekly = read(
            &calendar(
                "REQUEST",
                &[
                    "SUMMARY:Встреча",
                    "DTSTART;TZID=Europe/Moscow:20261103T100000",
                    "RRULE:FREQ=WEEKLY;BYDAY=TU",
                ],
            ),
            None,
        );
        assert_eq!(
            weekly.events[0].repeat,
            Some(Repeat {
                freq: Frequency::Weekly,
                interval: 1,
                days: vec![2],
                month_day: None
            })
        );
        let other_week = read(
            &calendar(
                "REQUEST",
                &[
                    "SUMMARY:Встреча",
                    "DTSTART;TZID=Europe/Moscow:20261103T100000",
                    "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH",
                ],
            ),
            None,
        );
        let repeat = other_week.events[0].repeat.clone().expect("a rule");
        assert_eq!(repeat.interval, 2);
        assert_eq!(repeat.days, vec![1, 4]);
        let monthly = read(
            &calendar(
                "REQUEST",
                &[
                    "SUMMARY:Встреча",
                    "DTSTART;TZID=Europe/Moscow:20261109T110000",
                    "RRULE:FREQ=MONTHLY;BYMONTHDAY=9",
                ],
            ),
            None,
        );
        let repeat = monthly.events[0].repeat.clone().expect("a rule");
        assert_eq!(repeat.freq, Frequency::Monthly);
        assert_eq!(repeat.month_day, Some(9));
    }

    #[test]
    fn a_letter_carries_the_calendar_of_its_alternative_and_of_its_file() {
        let alternative = concat!(
            "From: a@example.org\r\nTo: b@example.org\r\nSubject: s\r\nMIME-Version: 1.0\r\n",
            "Content-Type: multipart/alternative; boundary=\"b\"\r\n\r\n",
            "--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee the invitation.\r\n",
            "--b\r\nContent-Type: text/calendar; charset=utf-8; method=REQUEST\r\n\r\n",
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\n",
            "SUMMARY:Встреча\r\nDTSTART:20261106T120000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n--b--\r\n",
        );
        let notice = of_message(
            &MessageParser::default()
                .parse(alternative.as_bytes())
                .expect("a letter"),
        )
        .expect("a calendar");
        // No file to save: the calendar is the letter's other form, not an attachment of it.
        assert_eq!(notice.file, None);
        assert_eq!(notice.events[0].title, "Встреча");

        let attached = concat!(
            "From: a@example.org\r\nTo: b@example.org\r\nSubject: s\r\nMIME-Version: 1.0\r\n",
            "Content-Type: multipart/mixed; boundary=\"m\"\r\n\r\n--m\r\nContent-Type: text/plain\r\n\r\nHi\r\n",
            "--m\r\nContent-Type: text/calendar; name=\"invite.ics\"\r\n",
            "Content-Disposition: attachment; filename=\"invite.ics\"\r\n\r\n",
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:CANCEL\r\nBEGIN:VEVENT\r\n",
            "SUMMARY:Canceled: Встреча\r\nSTATUS:CANCELLED\r\nDTSTART:20261106T120000Z\r\n",
            "END:VEVENT\r\nEND:VCALENDAR\r\n--m--\r\n",
        );
        let notice =
            of_message(&MessageParser::default().parse(attached.as_bytes()).expect("a letter")).expect("a calendar");
        assert_eq!(notice.file, Some(0));
        assert!(notice.cancelled);
        assert_eq!(notice.events[0].title, "Встреча");

        let plain = "From: a@example.org\r\nTo: b@example.org\r\nSubject: s\r\n\r\nHello\r\n";
        assert!(of_message(&MessageParser::default().parse(plain.as_bytes()).expect("a letter")).is_none());
    }

    #[test]
    fn the_names_windows_gives_a_zone_are_the_ones_of_the_table() {
        assert_eq!(windows_zones::iana("Russian Standard Time"), Some("Europe/Moscow"));
        assert_eq!(windows_zones::iana("w. europe standard time"), Some("Europe/Berlin"));
        assert_eq!(windows_zones::iana("Nowhere Standard Time"), None);
    }

    #[test]
    fn the_word_a_client_puts_before_the_name_is_not_part_of_it() {
        assert_eq!(title("Canceled: Встреча"), "Встреча");
        assert_eq!(title("Updated: Re: Встреча"), "Встреча");
        assert_eq!(title("Встреча: Canceled"), "Встреча: Canceled");
    }
}
