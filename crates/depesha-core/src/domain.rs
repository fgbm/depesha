//! Domain types of the mail client: folders, flag changes, drafts and the acts that
//! make a letter out of another one. They know nothing of IMAP, EWS, SMTP or the
//! cache; the transports and the commands import them from here.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FolderRole {
    Inbox,
    Sent,
    Drafts,
    Trash,
    Junk,
    Archive,
    /// Not in RFC 6154: where Depesha keeps snoozed mail until it is due.
    Snoozed,
}

impl FolderRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inbox => "inbox",
            Self::Sent => "sent",
            Self::Drafts => "drafts",
            Self::Trash => "trash",
            Self::Junk => "junk",
            Self::Archive => "archive",
            Self::Snoozed => "snoozed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "inbox" => Self::Inbox,
            "sent" => Self::Sent,
            "drafts" => Self::Drafts,
            "trash" => Self::Trash,
            "junk" => Self::Junk,
            "archive" => Self::Archive,
            "snoozed" => Self::Snoozed,
            _ => return None,
        })
    }

    /// Fallback for servers without SPECIAL-USE (RFC 6154), Exchange included.
    pub(crate) fn guess(leaf: &str) -> Option<Self> {
        Some(match leaf.to_lowercase().as_str() {
            "inbox" | "входящие" => Self::Inbox,
            "sent" | "sent items" | "sent messages" | "sent mail" | "отправленные" | "отправленные элементы" => {
                Self::Sent
            }
            "drafts" | "draft" | "черновики" => Self::Drafts,
            "trash"
            | "deleted"
            | "deleted items"
            | "deleted messages"
            | "корзина"
            | "удаленные"
            | "удалённые"
            | "удаленные элементы" => Self::Trash,
            "junk" | "spam" | "junk e-mail" | "junk email" | "спам" | "нежелательная почта" => {
                Self::Junk
            }
            "archive" | "archives" | "архив" => Self::Archive,
            "snoozed" | "отложенные" => Self::Snoozed,
            _ => return None,
        })
    }
}

/// Exchange shows calendars, contacts and other non-mail stores as IMAP folders.
pub(crate) fn is_non_mail(leaf: &str) -> bool {
    matches!(
        leaf.to_lowercase().as_str(),
        "calendar"
            | "календарь"
            | "contacts"
            | "контакты"
            | "tasks"
            | "задачи"
            | "notes"
            | "заметки"
            | "journal"
            | "журнал"
            | "sync issues"
            | "проблемы синхронизации"
            | "outbox"
            | "исходящие"
            | "rss feeds"
            | "rss-каналы"
            | "rss-подписки"
            | "conversation history"
            | "журнал бесед"
            | "conversation action settings"
            | "quick step settings"
            | "social activity notifications"
            | "yammer root"
            | "files"
            | "external contacts"
            | "personmetadata"
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Folder {
    /// Name as the server knows it (modified UTF-7); used in IMAP commands.
    pub name: String,
    pub display_name: String,
    pub delimiter: Option<String>,
    pub role: Option<FolderRole>,
    pub selectable: bool,
    /// Not a mail folder (Exchange calendar, contacts...): hidden and never synced.
    #[serde(default)]
    pub hidden: bool,
}

impl Folder {
    pub fn leaf(&self) -> &str {
        match self.delimiter.as_deref().filter(|d| !d.is_empty()) {
            Some(d) => self.display_name.rsplit(d).next().unwrap_or(&self.display_name),
            None => &self.display_name,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Flags {
    pub seen: bool,
    pub answered: bool,
    pub flagged: bool,
    pub draft: bool,
    pub deleted: bool,
    /// Forwarded: the `$Forwarded` keyword of IMAP, the last verb of Exchange.
    #[serde(default)]
    pub forwarded: bool,
    /// Answered to all: only Exchange tells it apart; IMAP has `\Answered` for both.
    #[serde(default)]
    pub answered_all: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "flag", content = "value", rename_all = "snake_case")]
pub enum FlagChange {
    Seen(bool),
    Flagged(bool),
    Answered(bool),
    /// Answered to all: `\Answered` on IMAP, its own verb on Exchange.
    AnsweredAll(bool),
    Forwarded(bool),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Addr {
    pub name: Option<String>,
    pub email: String,
}

/// How much the sender wants the letter read first (#72). Only the high one is shown; the
/// low one is kept in the cache, so it can be shown later without a new migration.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Importance {
    Low,
    #[default]
    Normal,
    High,
}

impl Importance {
    /// The cache keeps it as -1, 0 or 1.
    pub fn to_db(self) -> i64 {
        match self {
            Self::Low => -1,
            Self::Normal => 0,
            Self::High => 1,
        }
    }

    pub fn from_db(n: i64) -> Self {
        match n {
            1.. => Self::High,
            0 => Self::Normal,
            _ => Self::Low,
        }
    }

    /// Exchange's `Importance` property: `High`, `Normal` or `Low`.
    pub fn from_word(word: &str) -> Self {
        match word.trim().to_ascii_lowercase().as_str() {
            "high" | "urgent" => Self::High,
            "low" | "non-urgent" => Self::Low,
            _ => Self::Normal,
        }
    }
}

/// How a letter is written. It decides the parts that go out: plain text alone, or
/// plain text with HTML of the same content.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BodyFormat {
    #[default]
    Plain,
    /// Formatted in the visual editor: `Draft::html` is the letter, `Draft::text` its plain version.
    Html,
    /// `Draft::text` is Markdown: it goes out as is for plain-text readers and rendered as HTML.
    Markdown,
}

impl BodyFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plain => "plain",
            Self::Html => "html",
            Self::Markdown => "markdown",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "plain" => Some(Self::Plain),
            "html" => Some(Self::Html),
            "markdown" => Some(Self::Markdown),
            _ => None,
        }
    }
}

/// What a letter does with the one it was written from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Act {
    Reply,
    ReplyAll,
    Forward,
}

impl Act {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reply => "reply",
            Self::ReplyAll => "reply_all",
            Self::Forward => "forward",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "reply" => Self::Reply,
            "reply_all" => Self::ReplyAll,
            "forward" => Self::Forward,
            _ => return None,
        })
    }

    /// An answer, of either kind: what takes a letter of the inbox to wait.
    pub fn answers(self) -> bool {
        self != Self::Forward
    }
}

/// The letter an answer or a forward was written from: it is marked when this one goes,
/// and an answer may take it to wait for the reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActsOn {
    pub account_id: String,
    pub message_id: String,
    /// Where it was when the answer was written, as the cache names the folder.
    pub folder: String,
    pub act: Act,
    /// It waits for a reply in the folder already: the answer leaves it there.
    #[serde(default)]
    pub waiting: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Draft {
    pub from: Option<Addr>,
    pub to: Vec<Addr>,
    pub cc: Vec<Addr>,
    pub bcc: Vec<Addr>,
    pub subject: String,
    /// The plain-text version; for Markdown, the Markdown itself.
    pub text: String,
    /// The letter as HTML, when it was written formatted.
    pub html: Option<String>,
    /// The HTML of the signature a Markdown letter carries (#67): the window shows it
    /// formatted, and the parts it goes out in — HTML, Markdown and text — are built here.
    /// An HTML letter keeps its signature inside `html`, a plain one its text inside `text`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// Outbox entries saved before formats existed are plain text.
    #[serde(default)]
    pub format: BodyFormat,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub attachments: Vec<OutgoingAttachment>,
    /// The letter this one answers or forwards; none for a new one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acts_on: Option<ActsOn>,
    /// The sender asks to read the letter first (#72): `Importance: high` and `X-Priority: 1`.
    /// The window offers high only; a normal letter says nothing.
    #[serde(default, skip_serializing_if = "is_normal")]
    pub importance: Importance,
}

fn is_normal(i: &Importance) -> bool {
    *i == Importance::Normal
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutgoingAttachment {
    pub name: String,
    pub mime: String,
    #[serde(with = "serde_bytes_b64")]
    pub data: Vec<u8>,
}

/// Attachments travel to and from the GUI as base64 strings, not JSON arrays of numbers.
mod serde_bytes_b64 {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(data: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(data))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        STANDARD.decode(s).map_err(serde::de::Error::custom)
    }
}

/// A draft kept locally: the key is the window's own (a fresh one per composition), and
/// `draft` is the letter exactly as the window holds it, stored verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedDraft {
    pub key: String,
    pub account_id: String,
    pub draft: serde_json::Value,
    /// The server copy this one continues, so a restore replaces it instead of adding a twin.
    #[serde(default)]
    pub draft_id: Option<i64>,
    /// The Message-ID of that server copy: the number alone may be handed out again to
    /// another draft, so a delete checks both (#92). Absent in copies written before.
    #[serde(default)]
    pub draft_message_id: Option<String>,
    /// When it was last written, seconds since the epoch.
    pub updated: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn guesses_roles_by_name() {
        assert_eq!(FolderRole::guess("Отправленные"), Some(FolderRole::Sent));
        assert_eq!(FolderRole::guess("Deleted Items"), Some(FolderRole::Trash));
        assert_eq!(FolderRole::guess("Нежелательная почта"), Some(FolderRole::Junk));
        assert_eq!(FolderRole::guess("Работа"), None);
        assert!(is_non_mail("Календарь"));
        assert!(is_non_mail("Sync Issues"));
        assert!(!is_non_mail("Входящие"));
    }

    #[test]
    fn folder_wire_format_is_stable() {
        let folder = Folder {
            name: "INBOX".into(),
            display_name: "Входящие".into(),
            delimiter: Some("/".into()),
            role: Some(FolderRole::Inbox),
            selectable: true,
            hidden: false,
        };
        let value = serde_json::to_value(&folder).unwrap();
        assert_eq!(
            value,
            json!({"name": "INBOX", "display_name": "Входящие", "delimiter": "/", "role": "inbox", "selectable": true, "hidden": false})
        );
        assert_eq!(serde_json::from_value::<Folder>(value).unwrap(), folder);
        let old: Folder = serde_json::from_value(
            json!({"name": "a", "display_name": "a", "delimiter": null, "role": null, "selectable": false}),
        )
        .unwrap();
        assert!(!old.hidden);
    }

    #[test]
    fn flag_change_and_act_wire_format_is_stable() {
        assert_eq!(
            serde_json::to_value(FlagChange::AnsweredAll(true)).unwrap(),
            json!({"flag": "answered_all", "value": true})
        );
        assert_eq!(
            serde_json::to_value(FlagChange::Seen(false)).unwrap(),
            json!({"flag": "seen", "value": false})
        );
        assert_eq!(serde_json::to_value(Act::ReplyAll).unwrap(), json!("reply_all"));
        assert_eq!(serde_json::to_value(BodyFormat::Markdown).unwrap(), json!("markdown"));
        assert_eq!(serde_json::to_value(FolderRole::Snoozed).unwrap(), json!("snoozed"));
    }

    #[test]
    fn draft_wire_format_is_stable() {
        let draft = Draft {
            subject: "Привет".into(),
            attachments: vec![OutgoingAttachment {
                name: "a.txt".into(),
                mime: "text/plain".into(),
                data: b"hi".to_vec(),
            }],
            acts_on: Some(ActsOn {
                account_id: "acc".into(),
                message_id: "<m@x>".into(),
                folder: "INBOX".into(),
                act: Act::Reply,
                waiting: false,
            }),
            ..Draft::default()
        };
        let value = serde_json::to_value(&draft).unwrap();
        assert_eq!(
            value,
            json!({
                "from": null, "to": [], "cc": [], "bcc": [], "subject": "Привет", "text": "", "html": null,
                "format": "plain", "in_reply_to": null, "references": [],
                "attachments": [{"name": "a.txt", "mime": "text/plain", "data": "aGk="}],
                "acts_on": {"account_id": "acc", "message_id": "<m@x>", "folder": "INBOX", "act": "reply", "waiting": false}
            })
        );
        let back: Draft = serde_json::from_value(value).unwrap();
        assert_eq!(back.attachments[0].data, b"hi");
        assert_eq!(back.acts_on, draft.acts_on);
    }

    #[test]
    fn addr_and_importance_wire_format_is_stable() {
        let addr = Addr {
            name: Some("Ольга".into()),
            email: "o@x.ru".into(),
        };
        assert_eq!(
            serde_json::to_value(&addr).unwrap(),
            json!({"name": "Ольга", "email": "o@x.ru"})
        );
        assert_eq!(serde_json::to_value(Importance::High).unwrap(), json!("high"));
        assert_eq!(serde_json::to_value(Importance::Low).unwrap(), json!("low"));
        assert_eq!(
            serde_json::from_value::<Importance>(json!("normal")).unwrap(),
            Importance::Normal
        );
        assert_eq!(
            [Importance::Low, Importance::Normal, Importance::High].map(Importance::to_db),
            [-1, 0, 1]
        );
        assert_eq!(Importance::from_db(5), Importance::High);
        assert_eq!(Importance::from_db(-3), Importance::Low);
    }

    /// A draft as 0.8.0 writes it to the outbox (`git show v0.8.0:crates/depesha-core/src/smtp.rs`).
    const DRAFT_080: &str = r#"{
        "from": {"name": "Ольга", "email": "o@x.ru"},
        "to": [{"name": null, "email": "a@x.ru"}], "cc": [], "bcc": [],
        "subject": "Re: план", "text": "**да**", "html": null,
        "signature": "<p>--<br>Ольга</p>", "format": "markdown",
        "in_reply_to": "<m1@x>", "references": ["<m0@x>", "<m1@x>"],
        "attachments": [{"name": "a.txt", "mime": "text/plain", "data": "aGk="}],
        "acts_on": {"account_id": "acc", "message_id": "<m1@x>", "folder": "INBOX", "act": "reply_all", "waiting": true},
        "importance": "high"
    }"#;

    /// An outbox entry from before formats, signatures, importance and acts existed.
    const DRAFT_OLD: &str = r#"{
        "from": null, "to": [{"name": "Б", "email": "b@x.ru"}], "cc": [], "bcc": [],
        "subject": "s", "text": "t", "html": null,
        "in_reply_to": null, "references": [], "attachments": []
    }"#;

    #[test]
    fn reads_a_draft_as_080_wrote_it() {
        let d: Draft = serde_json::from_str(DRAFT_080).unwrap();
        assert_eq!(d.format, BodyFormat::Markdown);
        assert_eq!(d.signature.as_deref(), Some("<p>--<br>Ольга</p>"));
        assert_eq!(d.importance, Importance::High);
        assert_eq!(d.from.as_ref().unwrap().email, "o@x.ru");
        assert_eq!(d.references, ["<m0@x>", "<m1@x>"]);
        assert_eq!(d.attachments[0].data, b"hi");
        let on = d.acts_on.as_ref().unwrap();
        assert_eq!((on.act, on.waiting, on.folder.as_str()), (Act::ReplyAll, true, "INBOX"));
        // Written back, it is the same JSON.
        assert_eq!(
            serde_json::to_value(&d).unwrap(),
            serde_json::from_str::<serde_json::Value>(DRAFT_080).unwrap()
        );
    }

    #[test]
    fn reads_a_draft_older_than_080() {
        let d: Draft = serde_json::from_str(DRAFT_OLD).unwrap();
        assert_eq!(d.format, BodyFormat::Plain);
        assert_eq!(d.signature, None);
        assert_eq!(d.importance, Importance::Normal);
        assert!(d.acts_on.is_none());
        assert_eq!(d.to[0].name.as_deref(), Some("Б"));
        let on: ActsOn =
            serde_json::from_str(r#"{"account_id":"a","message_id":"m","folder":"f","act":"forward"}"#).unwrap();
        assert!(!on.waiting);
    }

    #[test]
    fn act_names_in_the_cache_and_headers_are_stable() {
        for (act, name) in [
            (Act::Reply, "reply"),
            (Act::ReplyAll, "reply_all"),
            (Act::Forward, "forward"),
        ] {
            assert_eq!(act.as_str(), name);
            assert_eq!(Act::parse(name), Some(act));
        }
        assert_eq!(Act::parse("answer"), None);
    }
}
