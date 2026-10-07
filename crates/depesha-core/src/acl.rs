//! What the user may do in a folder, in words rather than ACL letters (#42). IMAP
//! answers MYRIGHTS with letters (`lrswipkxtea`, RFC 4314); Exchange answers with the
//! `EffectiveRights` child elements ([MS-OXWSCORE]). Both are mapped here onto the
//! handful of actions the folder card shows, so the GUI never spells a letter at the
//! user. The server's NAMESPACE answer (RFC 2342) is parsed here too: it says which
//! folders belong to someone else and names their owner.

use serde::{Deserialize, Serialize};

/// The actions the folder card offers. A right the server names that is not in this
/// list is kept in `Rights::other` and shown only in the technical details.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    /// Open the folder and read its letters (`r`).
    Read,
    /// Keep the read/unread mark — for the user alone in a shared folder (`s`).
    MarkSeen,
    /// Set flags and own labels (`w`).
    Write,
    /// Put letters here: APPEND, COPY into (`i`).
    Insert,
    /// Delete and move letters out of here (`t`, and `e` for good).
    Delete,
    /// Make subfolders inside (`k`).
    CreateChild,
    /// Delete the folder itself (`x`).
    DeleteFolder,
    /// Change the folder's rights (`a`).
    Administer,
}

/// A folder's rights, one flag per RFC 4314 right plus a catch-all for what Depesha
/// does not know. `Default` is no right at all.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rights {
    pub lookup: bool,
    pub read: bool,
    pub seen: bool,
    pub write: bool,
    pub insert: bool,
    pub post: bool,
    pub create_child: bool,
    pub delete_folder: bool,
    pub delete_messages: bool,
    pub expunge: bool,
    pub administer: bool,
    /// A right the server named that Depesha does not know (shown in the details only).
    pub other: bool,
}

impl Rights {
    /// The rights of an IMAP rights string (`lrswipkxtea`). Unknown letters are kept
    /// as `other` instead of dropped: the details can show them as the server named them.
    pub fn from_letters(letters: &str) -> Self {
        let mut r = Self::default();
        for ch in letters.chars() {
            match ch {
                'l' => r.lookup = true,
                'r' => r.read = true,
                's' => r.seen = true,
                'w' => r.write = true,
                'i' => r.insert = true,
                'p' => r.post = true,
                'k' => r.create_child = true,
                'x' => r.delete_folder = true,
                't' => r.delete_messages = true,
                'e' => r.expunge = true,
                'a' => r.administer = true,
                c if c.is_ascii_alphabetic() => r.other = true,
                _ => {}
            }
        }
        r
    }

    /// The letters of the set rights, in RFC 4314 order: what MYRIGHTS prints.
    pub fn letters(&self) -> String {
        [
            ('l', self.lookup),
            ('r', self.read),
            ('s', self.seen),
            ('w', self.write),
            ('i', self.insert),
            ('p', self.post),
            ('k', self.create_child),
            ('x', self.delete_folder),
            ('t', self.delete_messages),
            ('e', self.expunge),
            ('a', self.administer),
        ]
        .iter()
        .filter(|(_, on)| *on)
        .map(|(c, _)| *c)
        .collect()
    }

    /// Whether `action` is allowed. `Delete` asks for both `t` and `e`: a move out of a
    /// folder is a delete plus an expunge on a server without MOVE, which is the
    /// fallback here.
    pub fn allows(&self, action: Action) -> bool {
        match action {
            Action::Read => self.read,
            Action::MarkSeen => self.seen,
            Action::Write => self.write,
            Action::Insert => self.insert,
            Action::Delete => self.delete_messages && self.expunge,
            Action::CreateChild => self.create_child,
            Action::DeleteFolder => self.delete_folder,
            Action::Administer => self.administer,
        }
    }

    /// What Exchange's `EffectiveRights` child elements mean ([MS-OXWSCORE]).
    pub fn from_effective(
        read: bool,
        create_contents: bool,
        create_hierarchy: bool,
        delete: bool,
        modify: bool,
    ) -> Self {
        Self {
            lookup: read,
            read,
            // Exchange has no separate right to keep \Seen: whoever may modify may mark.
            seen: modify,
            write: modify,
            insert: create_contents,
            post: false,
            create_child: create_hierarchy,
            delete_folder: delete,
            delete_messages: delete,
            expunge: delete,
            administer: false,
            other: false,
        }
    }

    /// The folder can be read but nothing shared can be changed in it: the list says
    /// "only read". The per-user `\Seen` right (`s`) does not count: marking a letter
    /// read for oneself is not writing to a shared folder.
    pub fn read_only(&self) -> bool {
        self.read
            && !self.other
            && !(self.write
                || self.insert
                || self.delete_messages
                || self.expunge
                || self.create_child
                || self.delete_folder
                || self.administer)
    }
}

/// One namespace prefix and its hierarchy delimiter (RFC 2342).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamespaceFolder {
    pub prefix: String,
    pub delimiter: String,
}

/// The three NAMESPACE groups; empty vectors mean the server named none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Namespace {
    pub personal: Vec<NamespaceFolder>,
    pub other_users: Vec<NamespaceFolder>,
    pub shared: Vec<NamespaceFolder>,
}

/// Who a folder belongs to, as the sidebar groups it (#42, frame 6B).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "name")]
pub enum Owner {
    /// The user's own mailbox folders.
    Mine,
    /// A folder from the shared namespace (`shared/`).
    Shared,
    /// Someone else's folder, named by the account (namespace `Other Users/`).
    Other(String),
}

impl Namespace {
    /// Parses the namespaces out of the raw text of an untagged NAMESPACE answer (the
    /// part after `* NAMESPACE `). imap-proto does not parse this response, so the
    /// connection reads it raw and this turns it into prefixes. A malformed answer is
    /// an empty namespace, not an error: without it the folders simply stay ungrouped.
    pub fn parse(raw: &str) -> Self {
        let mut it = Lexer {
            chars: raw.trim().chars().peekable(),
        };
        let personal = it.group();
        let other_users = it.group();
        let shared = it.group();
        Self {
            personal,
            other_users,
            shared,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.personal.is_empty() && self.other_users.is_empty() && self.shared.is_empty()
    }

    /// Who owns the folder named `name`, from the namespaces: `Shared` for the shared
    /// group, `Other(owner)` for the "other users" one, `None` when it is the user's own
    /// or no namespace says otherwise.
    pub fn owner_of(&self, name: &str) -> Option<Owner> {
        for ns in &self.shared {
            if !ns.prefix.is_empty() && name.starts_with(&ns.prefix) {
                return Some(Owner::Shared);
            }
        }
        for ns in &self.other_users {
            if let Some(owner) = owner_in(name, ns) {
                return Some(Owner::Other(owner));
            }
        }
        None
    }
}

/// The owner's name in an "other users" folder: the first path segment after the
/// namespace prefix (`Other Users/maria/Проекты` names `maria`).
fn owner_in(name: &str, ns: &NamespaceFolder) -> Option<String> {
    if ns.prefix.is_empty() {
        return None;
    }
    let rest = name.strip_prefix(&ns.prefix)?;
    let leaf = rest.split(&ns.delimiter).next().unwrap_or_default();
    (!leaf.is_empty()).then(|| leaf.to_owned())
}

/// A tiny reader for the NAMESPACE grammar: quoted strings, `(` `)` grouping, `NIL`.
struct Lexer<'a> {
    chars: std::iter::Peekable<std::str::Chars<'a>>,
}

impl Lexer<'_> {
    fn skip(&mut self) {
        while matches!(self.chars.peek(), Some(c) if c.is_whitespace()) {
            self.chars.next();
        }
    }

    fn nil(&mut self) -> bool {
        self.skip();
        let mut peek = self.chars.clone();
        let word: String = peek.by_ref().take(3).collect();
        if word.eq_ignore_ascii_case("nil")
            && !matches!(peek.peek(), Some(c) if c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        {
            for _ in 0..3 {
                self.chars.next();
            }
            return true;
        }
        false
    }

    fn string(&mut self) -> Option<String> {
        self.skip();
        self.chars.next_if_eq(&'"')?;
        let mut out = String::new();
        while let Some(c) = self.chars.next() {
            match c {
                '"' => return Some(out),
                '\\' => {
                    if let Some(n) = self.chars.next() {
                        out.push(n);
                    }
                }
                _ => out.push(c),
            }
        }
        Some(out)
    }

    /// One `namespace-desc` list: `NIL`, or `(("prefix" "delim") ...)`.
    fn group(&mut self) -> Vec<NamespaceFolder> {
        self.skip();
        if self.nil() || self.chars.next_if_eq(&'(').is_none() {
            return Vec::new();
        }
        let mut out = Vec::new();
        loop {
            self.skip();
            match self.chars.peek() {
                Some(')') => {
                    self.chars.next();
                    break;
                }
                Some('(') => {
                    self.chars.next();
                    let prefix = self.string().unwrap_or_default();
                    let delimiter = self.string().unwrap_or_default();
                    self.skip();
                    self.chars.next_if_eq(&')');
                    out.push(NamespaceFolder { prefix, delimiter });
                }
                Some(_) => {
                    self.chars.next();
                }
                None => break,
            }
        }
        out
    }
}

/// What a folder's PERMANENTFLAGS allow (RFC 3501, 7.1): whether own keywords (labels)
/// can be stored here, and which standard flags the server keeps.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermanentFlags {
    /// The server listed `\*`: a keyword may be created by storing it.
    pub may_create: bool,
    /// The standard flags as the server named them (without the backslash).
    pub standard: Vec<String>,
}

impl PermanentFlags {
    /// From the names of `* OK [PERMANENTFLAGS (...)]`; `\*` becomes `may_create`.
    pub fn from_names(names: impl Iterator<Item = String>) -> Self {
        let mut out = Self::default();
        for name in names {
            let flag = name.trim();
            if flag == "\\*" || flag == "*" {
                out.may_create = true;
            } else if let Some(rest) = flag.strip_prefix('\\') {
                out.standard.push(rest.to_owned());
            } else if !flag.is_empty() {
                out.standard.push(flag.to_owned());
            }
        }
        out.standard.sort();
        out.standard.dedup();
        out
    }

    /// The folder takes own labels on the server: only when the server promised `\*`.
    pub fn labels_on_server(&self) -> bool {
        self.may_create
    }
}

/// The props the cache keeps and the folder card shows. `rights` and `labels_on_server`
/// may be unknown (a server without ACL); `refused` is the last refusal remembered here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderProps {
    pub folder: String,
    pub display_name: String,
    /// The folder is not the user's: shared or another person's (from NAMESPACE).
    pub owner: Owner,
    pub rights: Option<Rights>,
    /// Whether own labels can be stored here, from PERMANENTFLAGS; None when unknown.
    pub labels_on_server: Option<bool>,
    /// The PERMANENTFLAGS the server listed, for the details.
    pub permanent: Vec<String>,
    /// The remembered refusal in this folder (`no-rights`), if any.
    pub refused: Option<String>,
    /// When the props were read, Unix time; 0 when never.
    pub checked: i64,
}

impl Default for FolderProps {
    fn default() -> Self {
        Self {
            folder: String::new(),
            display_name: String::new(),
            owner: Owner::Mine,
            rights: None,
            labels_on_server: None,
            permanent: Vec::new(),
            refused: None,
            checked: 0,
        }
    }
}

impl FolderProps {
    /// The folder can be read but nothing shared can be changed in it.
    pub fn read_only(&self) -> bool {
        self.rights.is_some_and(|r| r.read_only())
    }
}

/// A label: what the user calls it, the keyword that goes on the server and its colour.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Label {
    pub name: String,
    /// The IMAP keyword (an atom) or the Exchange category name.
    pub keyword: String,
    /// `#rrggbb`, chosen in Depesha; not synced.
    pub color: String,
}

/// The keyword that carries a label on IMAP. An ASCII name becomes `depesha-<slug>`,
/// anything else (Cyrillic) a stable `depesha-<hash>`: the keyword is an atom and the
/// server cares only that it is stable, while the name stays with the label.
pub fn keyword_of(name: &str) -> String {
    let ascii = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ' '));
    if ascii {
        let mut out = String::new();
        let mut dash = false;
        for c in name.chars() {
            if c.is_ascii_alphanumeric() {
                if dash && !out.is_empty() {
                    out.push('-');
                }
                dash = false;
                out.push(c.to_ascii_lowercase());
            } else {
                dash = true;
            }
        }
        if !out.is_empty() && out.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
            return format!("depesha-{out}");
        }
    }
    // Cyrillic and anything else: a short stable hash of the whole name (FNV-1a).
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in name.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    format!("depesha-{hash:08x}")
}

/// The own labels of a letter: the keywords it carries that are Depesha labels, mapped
/// back to their names, in a steady order. Keywords with no label are ignored.
pub fn label_names(keywords: &[String], known: &[Label]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for l in known {
        if keywords.iter().any(|k| k == &l.keyword) && !out.contains(&l.name) {
            out.push(l.name.clone());
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn label(name: &str) -> Label {
        Label {
            name: name.into(),
            keyword: keyword_of(name),
            color: "#000000".into(),
        }
    }

    #[test]
    fn reads_myrights_letters_into_actions() {
        let all = Rights::from_letters("lrswipkxtea");
        for a in [
            Action::Read,
            Action::MarkSeen,
            Action::Write,
            Action::Insert,
            Action::Delete,
            Action::CreateChild,
            Action::DeleteFolder,
            Action::Administer,
        ] {
            assert!(all.allows(a), "{a:?}");
        }
        assert!(!all.read_only());
        // A shared folder opened for reading, as in the mockup's frame 4.
        let ro = Rights::from_letters("rs");
        assert!(ro.read && ro.seen && !ro.write && !ro.insert);
        assert!(ro.allows(Action::Read) && ro.allows(Action::MarkSeen));
        assert!(!ro.allows(Action::Write) && !ro.allows(Action::Insert) && !ro.allows(Action::Delete));
        assert!(ro.read_only());
        // "Without delete": no t/e.
        let some = Rights::from_letters("lrswik");
        assert!(!some.allows(Action::Delete) && !some.read_only());
        // A right Depesha does not know is kept, not dropped.
        let odd = Rights::from_letters("lrZ");
        assert!(odd.other && odd.read && odd.lookup);
        // Round-trip.
        assert_eq!(all.letters(), "lrswipkxtea");
        assert_eq!(ro.letters(), "rs");
        assert_eq!(Rights::default().letters(), "");
    }

    #[test]
    fn exchange_effective_rights_become_actions() {
        // Reader: read only ([MS-OXWSCORE] EffectiveRights).
        let reader = Rights::from_effective(true, false, false, false, false);
        assert!(reader.read && reader.read_only());
        assert!(!reader.allows(Action::Write) && !reader.allows(Action::Delete));
        // Author: read, modify, create contents.
        let author = Rights::from_effective(true, true, false, false, true);
        assert!(author.allows(Action::Write) && author.allows(Action::Insert) && author.allows(Action::MarkSeen));
        assert!(!author.allows(Action::Delete) && !author.read_only());
    }

    #[test]
    fn reads_the_namespace_answer() {
        let ns = Namespace::parse(r#"(("" "/")) (("Other Users/" "/")) (("shared/" "/"))"#);
        assert_eq!(
            ns.personal,
            [NamespaceFolder {
                prefix: "".into(),
                delimiter: "/".into()
            }]
        );
        assert_eq!(ns.other_users[0].prefix, "Other Users/");
        assert_eq!(ns.shared[0].prefix, "shared/");
        // Dovecot's answer to a mailbox without shared namespaces.
        let bare = Namespace::parse(r#"(("" "/")) NIL NIL"#);
        assert!(bare.shared.is_empty() && bare.other_users.is_empty());
        assert_eq!(bare.personal.len(), 1);
        // Garbage is an empty namespace, not a panic.
        assert!(Namespace::parse("(").is_empty());
        assert!(Namespace::parse("").is_empty());
    }

    #[test]
    fn names_the_owner_of_a_shared_folder() {
        let ns = Namespace::parse(r#"(("INBOX." ".")) (("Other Users/" "/")) (("shared/" "/"))"#);
        assert_eq!(ns.owner_of("shared/Бухгалтерия"), Some(Owner::Shared));
        assert_eq!(
            ns.owner_of("Other Users/maria/Проекты"),
            Some(Owner::Other("maria".into()))
        );
        assert_eq!(ns.owner_of("INBOX"), None);
        assert_eq!(ns.owner_of("shared"), None, "the prefix itself is not a folder");
    }

    #[test]
    fn reads_permanent_flags() {
        let p = PermanentFlags::from_names(
            ["\\Seen", "\\Flagged", "\\*", "\\Answered"]
                .into_iter()
                .map(str::to_owned),
        );
        assert!(p.may_create && p.labels_on_server());
        assert_eq!(p.standard, ["Answered", "Flagged", "Seen"]);
        // A folder with only standard flags: no `\*`.
        let no = PermanentFlags::from_names([r#"\Seen"#, r#"\Draft"#].into_iter().map(str::to_owned));
        assert!(!no.labels_on_server() && !no.may_create);
    }

    #[test]
    fn makes_a_label_keyword_from_its_name() {
        assert_eq!(keyword_of("Счета"), keyword_of("Счета"));
        assert!(keyword_of("Счета").starts_with("depesha-"));
        assert_eq!(keyword_of("Client North"), "depesha-client-north");
        assert_eq!(keyword_of("client_north"), "depesha-client-north");
        assert_ne!(keyword_of("Счета"), keyword_of("Счёты"));
        // A keyword is an atom: no spaces, quotes or backslashes.
        for name in ["Счета", "Client North", "Клиент Север"] {
            let k = keyword_of(name);
            assert!(k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'), "{k}");
        }
    }

    #[test]
    fn maps_keywords_back_to_label_names() {
        let known = [label("Счета"), label("Клиент Север")];
        let kw = vec![keyword_of("Счета"), "$Forwarded".into(), keyword_of("Клиент Север")];
        assert_eq!(label_names(&kw, &known), ["Клиент Север", "Счета"]);
        assert!(label_names(&["$Forwarded".into()], &known).is_empty());
    }
}
