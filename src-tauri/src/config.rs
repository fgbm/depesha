use std::path::Path;

use crate::lang::{self, Lang};
use depesha_core::account::{Account, OAuthProvider};
use depesha_core::domain::BodyFormat;
use depesha_core::oauth::OAuthClient;
use depesha_core::store::SortKey;
use serde::{Deserialize, Serialize};

/// Account settings without passwords; those live in the OS keyring.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub accounts: Vec<Account>,
    #[serde(default)]
    pub settings: Settings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Settings {
    /// A sent message waits this long in the outbox so it can be taken back.
    pub undo_send_secs: u32,
    /// `people` (default), `all` or `none`.
    #[cfg_attr(test, ts(type = "\"people\" | \"all\" | \"none\""))]
    pub notify: String,
    /// Do not disturb until this Unix time; 0 when off.
    pub dnd_until: i64,
    /// Group the list into conversations.
    pub threads: bool,
    /// A round picture of the sender at the left of every row of the list (#108): a logo, a
    /// photo or initials. Only the look of the list; the letter has its own always.
    pub list_avatars: bool,
    pub templates: Vec<Template>,
    /// `auto` (default), `notify` or `off`, like OpenCode's `autoupdate`.
    #[cfg_attr(test, ts(type = "\"auto\" | \"notify\" | \"off\""))]
    pub updates: String,
    /// `auto` (from the system locale, default), `en` or `ru`.
    #[cfg_attr(test, ts(type = "\"auto\" | \"en\" | \"ru\""))]
    pub language: String,
    /// `system` (light or dark as the system says, default), `paper`, `night`,
    /// `snow` or `graphite`.
    #[cfg_attr(test, ts(type = "\"system\" | \"paper\" | \"night\" | \"snow\" | \"graphite\""))]
    pub theme: String,
    /// Built-in plugins switched off, by id (`plugins/<id>`).
    #[serde(alias = "disabled_modules")]
    pub disabled_plugins: Vec<String>,
    /// Built-in plugins the user switched on, by id; only those off by default
    /// (`PluginManifest::default_off`) use it.
    pub enabled_plugins: Vec<String>,
    /// Settings of built-in plugins, by plugin id; each plugin owns its object.
    #[cfg_attr(test, ts(type = "Record<string, Record<string, unknown>>"))]
    pub plugin_settings: std::collections::BTreeMap<String, serde_json::Value>,
    /// The user's keys of commands (Settings → Keys); only what differs from the defaults.
    pub keybindings: Keybindings,
    /// Installed extensions switched off, by id.
    pub disabled_extensions: Vec<String>,
    /// The user's own OAuth clients; they win over the ones built into the app.
    pub oauth_clients: std::collections::BTreeMap<OAuthProvider, OAuthClient>,
    /// Mail downloaded whole for reading without a network and for searching its
    /// text: `off`, the last `30` (default), `90` or `365` days, or `all`.
    #[cfg_attr(test, ts(type = "\"off\" | \"30\" | \"90\" | \"365\" | \"all\""))]
    pub offline: String,
    /// Offline download takes messages with attachments too.
    pub offline_attachments: bool,
    /// Brand logos published with BIMI next to mail that passed DMARC: a DNS
    /// lookup and a download from the brand's site, once a week per domain, in the list
    /// and in the letter. Off, no lookup is made anywhere (#108).
    pub sender_logos: bool,
    /// Where attachments are saved without asking; empty asks every time.
    /// A mailbox may have its own (`Account::attachments_dir`).
    pub attachments_dir: String,
    /// The order of lists without one of their own; newest first when empty.
    pub list_sort: Vec<SortKey>,
    /// Lists ordered their own way, by view key (`folder:<account>:<name>`, `unified:inbox`…).
    pub view_sorts: std::collections::BTreeMap<String, Vec<SortKey>>,
    /// What counts as a large letter in the ready-made searches (Settings → General → Search), megabytes.
    pub large_mb: u32,
    /// A picture put into a letter's text (HTML or Markdown) is drawn no wider than this on
    /// its long side, pixels (decision on #45): a 4K photo is megabytes otherwise.
    #[serde(default = "image_max_px")]
    pub image_max_px: u32,
    /// How new letters are written; a mailbox may have its own (`Account::compose_format`).
    /// A new install writes HTML; one set up before the choice existed goes on with plain text.
    #[serde(default = "plain")]
    pub compose_format: BodyFormat,
    /// Which form of a letter the reader shows: `sender` (the one the sender put last,
    /// default), `markdown` or `text` when the letter has it. A letter's switch overrides it.
    #[cfg_attr(test, ts(type = "\"sender\" | \"html\" | \"markdown\" | \"text\""))]
    pub letter_view: String,
    /// Which mailbox new letters are written from; none follows the context (the open
    /// folder or letter, else the first mailbox). Answers and forwards are unaffected.
    pub default_account_id: Option<String>,
    /// Warn when a mailbox fills up: at the two levels, in percent, and when full.
    /// The same for every mailbox; a mailbox may set its own limit (`Account::quota_limit_mb`).
    pub quota_warn: bool,
    pub quota_levels: [u8; 2],
    /// `threshold`: once per level crossed (default); `daily`: again every day while above.
    #[cfg_attr(test, ts(type = "\"threshold\" | \"daily\""))]
    pub quota_repeat: String,
    /// What closing the main window does: `ask` (default, every install asks once),
    /// `background` (the window hides, mail keeps coming) or `quit`.
    #[cfg_attr(test, ts(type = "\"ask\" | \"background\" | \"quit\""))]
    pub close_action: String,
    /// The user agreed to work in the background with no tray icon to come back by.
    pub background_without_tray: bool,
    /// Start at login: `off` (default), `window` or `background` (only the tray icon).
    #[cfg_attr(test, ts(type = "\"off\" | \"window\" | \"background\""))]
    pub autostart: String,
    /// The number of unread letters in the inboxes drawn on the tray icon.
    pub tray_count: bool,
    /// The tray icon stays while the window is open; otherwise it shows only in the background.
    pub tray_always: bool,
    /// The suggestions of 0.7 (#69): the one switch that turns every one of them off.
    pub hints: bool,
    /// The note about the three parts of a Markdown letter in the format menu (#103): `false`
    /// once the user closed it; Settings → Look → Hints brings it back.
    pub markdown_parts_note: bool,
    /// When the day begins for «Snooze» (#95), `H:MM`: «Tomorrow» and the working days point here.
    pub day_start: String,
    /// When the evening begins for «Snooze», `H:MM`: «This evening» points here.
    pub evening_start: String,
    /// Working days for «Snooze», ISO: 1 Monday … 7 Sunday. Empty means none.
    pub work_days: Vec<u8>,
}

fn plain() -> BodyFormat {
    BodyFormat::Plain
}

fn image_max_px() -> u32 {
    1600
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            undo_send_secs: 10,
            notify: "people".into(),
            dnd_until: 0,
            threads: true,
            list_avatars: true,
            templates: Vec::new(),
            updates: "auto".into(),
            language: "auto".into(),
            theme: "system".into(),
            disabled_plugins: Vec::new(),
            enabled_plugins: Vec::new(),
            plugin_settings: Default::default(),
            keybindings: Keybindings::default(),
            disabled_extensions: Vec::new(),
            oauth_clients: Default::default(),
            offline: "30".into(),
            offline_attachments: false,
            sender_logos: true,
            attachments_dir: String::new(),
            list_sort: Vec::new(),
            view_sorts: Default::default(),
            large_mb: 25,
            image_max_px: 1600,
            compose_format: BodyFormat::Html,
            letter_view: "sender".into(),
            default_account_id: None,
            quota_warn: true,
            quota_levels: [90, 95],
            quota_repeat: "threshold".into(),
            close_action: "ask".into(),
            background_without_tray: false,
            autostart: "off".into(),
            tray_count: true,
            tray_always: true,
            hints: true,
            markdown_parts_note: true,
            day_start: "9:00".into(),
            evening_start: "18:00".into(),
            work_days: vec![1, 2, 3, 4, 5],
        }
    }
}

impl Settings {
    /// The OAuth client to sign in with: the user's own, or the built-in one.
    pub fn oauth_client(&self, provider: OAuthProvider) -> Option<OAuthClient> {
        self.oauth_clients
            .get(&provider)
            .filter(|c| c.is_set())
            .cloned()
            .or_else(|| OAuthClient::builtin(provider))
    }

    /// The interface language: the chosen one, or Russian for a Russian system locale
    /// and English otherwise.
    pub fn lang(&self) -> Lang {
        match self.language.as_str() {
            "ru" => Lang::Ru,
            "en" => Lang::En,
            _ => sys_locale::get_locale()
                .map(|l| lang::from_locale(&l))
                .unwrap_or(Lang::En),
        }
    }

    /// Since when mail is kept for offline reading, Unix time; `None` when it is off.
    pub fn offline_since(&self) -> Option<i64> {
        match self.offline.as_str() {
            "off" => None,
            "all" => Some(0),
            days => {
                let days: i64 = days.parse().unwrap_or(30);
                Some(chrono::Utc::now().timestamp() - days * 86_400)
            }
        }
    }

    /// Whether a notification about this kind of mail may be shown now.
    pub fn may_notify(&self, bulk: bool) -> bool {
        if self.dnd_until > chrono::Utc::now().timestamp() {
            return false;
        }
        match self.notify.as_str() {
            "none" => false,
            "all" => true,
            _ => !bulk,
        }
    }
}

/// Keys the user changed, by command id (`core.reply`, `snooze.open`); the defaults live
/// in the frontend (`src/lib/keyCommands.ts` and the plugins).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
#[cfg_attr(test, derive(ts_rs::TS), ts(rename = "KeySettings"))]
pub struct Keybindings {
    /// An empty list is a command left without a key.
    pub custom: std::collections::BTreeMap<String, Vec<String>>,
    /// Plugins' keys taken by someone else, `<command>:<key>`, whose notice was seen.
    pub dismissed: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Template {
    pub name: String,
    pub text: String,
}

pub fn load(path: &Path) -> Config {
    let mut config = match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|err| {
            tracing::error!(%err, "accounts.json is broken, starting without accounts");
            Config::default()
        }),
        Err(_) => Config::default(),
    };
    // Templates moved into the templates plugin (0.5.0).
    let s = &mut config.settings;
    if !s.templates.is_empty() && !s.plugin_settings.contains_key("templates") {
        let list = std::mem::take(&mut s.templates);
        s.plugin_settings
            .insert("templates".into(), serde_json::json!({ "list": list }));
    }
    config
}

/// Moves the one plain-text signature of a mailbox from before 0.6.0 into its list of
/// signatures, as the default one (#25). Run once the language is set: the name is worded in it.
pub fn adopt_old_signatures(config: &mut Config) {
    let name = lang::pick("Signature", "Подпись");
    for account in &mut config.accounts {
        account.adopt_old_signature(name);
    }
}

/// Applies a patch over a JSON value: every key the patch names is replaced by what it
/// carries, the rest is left as it is. A patch over the settings changes only what one page
/// or one control owns, so what another window or the tray wrote meanwhile is not rolled back.
pub fn merge(base: &mut serde_json::Value, patch: serde_json::Value) {
    let serde_json::Value::Object(patch) = patch else {
        *base = patch;
        return;
    };
    let Some(obj) = base.as_object_mut() else {
        *base = serde_json::Value::Object(patch);
        return;
    };
    for (key, value) in patch {
        obj.insert(key, value);
    }
}

/// Writes through a temporary file so a crash never leaves half a config.
pub fn save(path: &Path, config: &Config) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(config).map_err(std::io::Error::other)?)?;
    std::fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_installs_write_html_and_old_ones_keep_plain_text() {
        assert_eq!(Settings::default().compose_format, BodyFormat::Html);
        let old: Config = serde_json::from_str(r#"{"accounts":[],"settings":{"undo_send_secs":5}}"#).unwrap();
        assert_eq!(old.settings.compose_format, BodyFormat::Plain);
        assert_eq!(old.settings.undo_send_secs, 5);
        assert_eq!(old.settings.letter_view, "sender");
        // A config from before the choice existed has no default mailbox.
        assert_eq!(old.settings.default_account_id, None);
        assert_eq!(Settings::default().default_account_id, None);
        assert!(old.settings.enabled_plugins.is_empty());
        let chosen: Settings = serde_json::from_str(r#"{"compose_format":"markdown"}"#).unwrap();
        assert_eq!(chosen.compose_format, BodyFormat::Markdown);
    }

    /// Closing the window asks every install once, the old ones too; nothing starts at login.
    #[test]
    fn closing_asks_and_nothing_starts_at_login_by_default() {
        let old: Config = serde_json::from_str(r#"{"accounts":[],"settings":{"undo_send_secs":5}}"#).unwrap();
        for s in [&old.settings, &Settings::default()] {
            assert_eq!(s.close_action, "ask");
            assert!(!s.background_without_tray);
            assert_eq!(s.autostart, "off");
            assert!(s.tray_count && s.tray_always);
        }
    }

    /// The times of «Snooze» (#95): a config from before them reads with the defaults.
    #[test]
    fn snooze_times_default_for_old_configs() {
        let old: Settings = serde_json::from_str(r#"{"undo_send_secs":5}"#).unwrap();
        for s in [&old, &Settings::default()] {
            assert_eq!((s.day_start.as_str(), s.evening_start.as_str()), ("9:00", "18:00"));
            assert_eq!(s.work_days, vec![1, 2, 3, 4, 5]);
        }
        let mine: Settings = serde_json::from_str(r#"{"day_start":"8:30","work_days":[]}"#).unwrap();
        assert_eq!(mine.day_start, "8:30");
        assert!(mine.work_days.is_empty());
        assert_eq!(mine.evening_start, "18:00");
    }

    /// The note about the three parts of a Markdown letter (#103) shows until it is closed: a
    /// config from before the key reads it as shown, and Settings brings a closed one back.
    #[test]
    fn the_markdown_parts_note_shows_until_it_is_closed() {
        let old: Settings = serde_json::from_str(r#"{"undo_send_secs":5}"#).unwrap();
        assert!(old.markdown_parts_note && Settings::default().markdown_parts_note);
        let closed: Settings = serde_json::from_str(r#"{"markdown_parts_note":false}"#).unwrap();
        assert!(!closed.markdown_parts_note);
    }

    #[test]
    fn keys_keep_only_the_users_changes() {
        let old: Settings = serde_json::from_str(r#"{"undo_send_secs":5}"#).unwrap();
        assert!(old.keybindings.custom.is_empty() && old.keybindings.dismissed.is_empty());
        let mine: Settings = serde_json::from_str(
            r#"{"keybindings":{"custom":{"core.reply-all":["Shift+r"],"core.archive":[]},"dismissed":["snooze.open:h"]}}"#,
        )
        .unwrap();
        assert_eq!(mine.keybindings.custom["core.reply-all"], vec!["Shift+r".to_string()]);
        // No key at all is a choice too: kept, not dropped as empty.
        assert!(mine.keybindings.custom["core.archive"].is_empty());
        assert_eq!(mine.keybindings.dismissed, vec!["snooze.open:h".to_string()]);
        let again: Settings = serde_json::from_str(&serde_json::to_string(&mine).unwrap()).unwrap();
        assert_eq!(again, mine);
    }

    #[test]
    fn a_patch_changes_only_the_keys_it_names() {
        let mut base = Settings::default();
        base.keybindings.custom.insert("core.reply".into(), vec!["q".into()]);
        let mut value = serde_json::to_value(&base).unwrap();
        merge(
            &mut value,
            serde_json::json!({ "dnd_until": 123, "keybindings": { "custom": {}, "dismissed": ["snooze.open:h"] } }),
        );
        let merged: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(merged.dnd_until, 123);
        // An empty object is a value like any other: it clears the key it names («Reset»).
        assert!(merged.keybindings.custom.is_empty());
        assert_eq!(merged.keybindings.dismissed, vec!["snooze.open:h".to_string()]);
        // The keys the patch does not name keep what they had.
        assert_eq!(merged.undo_send_secs, Settings::default().undo_send_secs);
        assert_eq!(merged.theme, Settings::default().theme);
    }

    #[test]
    fn a_signature_from_before_becomes_the_default_one() {
        lang::pin(Lang::Ru);
        let dir = std::env::temp_dir().join(format!("depesha-config-{}", std::process::id()));
        let path = dir.join("accounts.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            &path,
            r#"{"accounts":[{"id":"a","display_name":"Иван","email":"ivan@example.com","username":"ivan",
                "imap":{"host":"h","port":993,"security":"tls"},"smtp":{"host":"h","port":465,"security":"tls"},
                "signature":"Иван Петров\nexample.com"},
              {"id":"b","display_name":"B","email":"b@example.com","username":"b",
                "imap":{"host":"h","port":993,"security":"tls"},"smtp":{"host":"h","port":465,"security":"tls"}}],
              "settings":{}}"#,
        )
        .unwrap();
        let mut config = load(&path);
        adopt_old_signatures(&mut config);
        let a = &config.accounts[0];
        assert_eq!(a.signatures.len(), 1);
        assert_eq!(a.signatures[0].name, "Подпись");
        assert_eq!(a.signatures[0].text, "Иван Петров\nexample.com");
        assert_eq!(a.default_signature.as_deref(), Some(a.signatures[0].id.as_str()));
        assert!(config.accounts[1].signatures.is_empty() && config.accounts[1].default_signature.is_none());
        // Saved and read again, it is the same, and the old field is not written back.
        save(&path, &config).unwrap();
        assert!(!std::fs::read_to_string(&path).unwrap().contains("\"signature\""));
        let mut again = load(&path);
        adopt_old_signatures(&mut again);
        assert_eq!(again.accounts[0].signatures, config.accounts[0].signatures);
        assert_eq!(
            again.accounts[0].default_signature,
            config.accounts[0].default_signature
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A value the file has and this version does not know (a setting of a newer version, or a
    /// typo) must not cost the mailboxes: the settings keep strings, so it reads as it is (#143).
    #[test]
    fn an_unknown_setting_value_loses_no_mailbox() {
        let dir = std::env::temp_dir().join(format!("depesha-config-unknown-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("accounts.json");
        std::fs::write(
            &path,
            r#"{"accounts":[{"id":"a","display_name":"A","email":"a@example.org","username":"a@example.org",
                "imap":{"host":"imap.example.org","port":993,"security":"tls"},
                "smtp":{"host":"smtp.example.org","port":465,"security":"tls"},"save_sent_copy":true}],
               "settings":{"theme":"future","notify":"sometimes","offline":"forever","letter_view":"hologram",
                "close_action":"explode","autostart":"maybe","updates":"never-ever","language":"klingon","quota_repeat":"hourly"}}"#,
        )
        .unwrap();
        let config = load(&path);
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(config.accounts.len(), 1, "the mailbox stays");
        assert_eq!(config.accounts[0].email, "a@example.org");
        assert_eq!(config.settings.theme, "future");
        assert_eq!(config.settings.offline, "forever");
    }
}
