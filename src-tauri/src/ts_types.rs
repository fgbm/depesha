//! The TypeScript types of the interface, written from the Rust structs they travel as (#143).
//! One file, `src/lib/generated/types.ts`, so the interface imports its types from one place and
//! a plugin API can later be built on the same source (#155). Run
//! `scripts/gen-types.sh` after a type changes; the test below fails when the file is stale.

use ts_rs::{Config, TS};

/// The types of the list by their TypeScript name, with their declarations, and the names they use.
#[derive(Default)]
struct Decls {
    declared: std::collections::BTreeMap<String, String>,
    used: std::collections::BTreeSet<String>,
}

fn decl<T: TS + 'static + ?Sized>(cfg: &Config, out: &mut Decls) {
    let name = T::name(cfg);
    let was = out.declared.insert(name.clone(), format!("export {}", T::decl(cfg)));
    assert!(was.is_none(), "два типа с именем {name}: переименуй один (ts(rename))");
    out.used.extend(T::dependencies(cfg).into_iter().map(|d| d.ts_name));
}

/// Every type the interface gets, by name. A type used inside one of these must be here too.
#[allow(
    clippy::too_many_lines,
    reason = "a list of declarations, one line each: the list is the function"
)]
fn all(cfg: &Config) -> Decls {
    let mut out = Decls::default();
    decl::<crate::tasks::TaskKind>(cfg, &mut out);
    decl::<crate::tasks::TaskState>(cfg, &mut out);
    decl::<crate::updater::UpdateState>(cfg, &mut out);
    decl::<crate::state::AccountState>(cfg, &mut out);
    decl::<serde_json::Value>(cfg, &mut out);
    decl::<depesha_core::account::Security>(cfg, &mut out);
    decl::<depesha_core::account::ServerConfig>(cfg, &mut out);
    decl::<depesha_core::account::Account>(cfg, &mut out);
    decl::<depesha_core::account::Waiting>(cfg, &mut out);
    decl::<depesha_core::account::Signature>(cfg, &mut out);
    decl::<depesha_core::account::AuthMethod>(cfg, &mut out);
    decl::<depesha_core::account::OAuthProvider>(cfg, &mut out);
    decl::<depesha_core::account::EwsConfig>(cfg, &mut out);
    decl::<depesha_core::acl::Rights>(cfg, &mut out);
    decl::<depesha_core::acl::NamespaceFolder>(cfg, &mut out);
    decl::<depesha_core::acl::Namespace>(cfg, &mut out);
    decl::<depesha_core::acl::Owner>(cfg, &mut out);
    decl::<depesha_core::acl::LabelCheck>(cfg, &mut out);
    decl::<depesha_core::acl::FolderProps>(cfg, &mut out);
    decl::<depesha_core::acl::Label>(cfg, &mut out);
    decl::<depesha_core::clear::Emptied>(cfg, &mut out);
    decl::<depesha_core::domain::FolderRole>(cfg, &mut out);
    decl::<depesha_core::domain::Folder>(cfg, &mut out);
    decl::<depesha_core::domain::Flags>(cfg, &mut out);
    decl::<depesha_core::domain::FlagChange>(cfg, &mut out);
    decl::<depesha_core::domain::Addr>(cfg, &mut out);
    decl::<depesha_core::domain::Importance>(cfg, &mut out);
    decl::<depesha_core::domain::BodyFormat>(cfg, &mut out);
    decl::<depesha_core::domain::Act>(cfg, &mut out);
    decl::<depesha_core::domain::ActsOn>(cfg, &mut out);
    decl::<depesha_core::domain::Draft>(cfg, &mut out);
    decl::<depesha_core::domain::OutgoingAttachment>(cfg, &mut out);
    decl::<depesha_core::domain::CachedDraft>(cfg, &mut out);
    decl::<depesha_core::ErrorKind>(cfg, &mut out);
    decl::<depesha_core::message::Summary>(cfg, &mut out);
    decl::<depesha_core::message::Unsubscribe>(cfg, &mut out);
    decl::<depesha_core::message::AttachmentInfo>(cfg, &mut out);
    decl::<depesha_core::message::MessageView>(cfg, &mut out);
    decl::<depesha_core::message::BodyView>(cfg, &mut out);
    decl::<depesha_core::oauth::OAuthClient>(cfg, &mut out);
    decl::<depesha_core::quota::Quota>(cfg, &mut out);
    decl::<depesha_core::quota::FolderSize>(cfg, &mut out);
    decl::<depesha_core::quota::SizeMethod>(cfg, &mut out);
    decl::<depesha_core::store::OutboxItem>(cfg, &mut out);
    decl::<depesha_core::store::Snooze>(cfg, &mut out);
    decl::<depesha_core::store::FolderInfo>(cfg, &mut out);
    decl::<depesha_core::store::MessageRow>(cfg, &mut out);
    decl::<depesha_core::store::Voice>(cfg, &mut out);
    decl::<depesha_core::store::SortField>(cfg, &mut out);
    decl::<depesha_core::store::SortKey>(cfg, &mut out);
    decl::<depesha_core::store::Pin>(cfg, &mut out);
    decl::<depesha_core::store::SearchTotals>(cfg, &mut out);
    decl::<depesha_core::store::ListQuery>(cfg, &mut out);
    decl::<depesha_core::store::FollowupPlan>(cfg, &mut out);
    decl::<depesha_core::store::FollowupStatus>(cfg, &mut out);
    decl::<depesha_core::store::FollowupFilter>(cfg, &mut out);
    decl::<depesha_core::store::FollowupInfo>(cfg, &mut out);
    decl::<depesha_core::store::Mark>(cfg, &mut out);
    decl::<depesha_core::store::Outgoing>(cfg, &mut out);
    decl::<depesha_core::store::StuckCopy>(cfg, &mut out);
    decl::<depesha_core::store::ServerCaps>(cfg, &mut out);
    decl::<depesha_core::store::EnableAnswer>(cfg, &mut out);
    decl::<depesha_core::store::QuotaSeen>(cfg, &mut out);
    decl::<depesha_core::store::FolderSizes>(cfg, &mut out);
    decl::<depesha_core::store::ServerInfo>(cfg, &mut out);
    decl::<depesha_core::tls::CertWhy>(cfg, &mut out);
    decl::<depesha_core::tls::CertProblem>(cfg, &mut out);
    decl::<depesha_core::unsubscribe::Way>(cfg, &mut out);
    decl::<crate::commands::AccountView>(cfg, &mut out);
    decl::<crate::commands::DetectionView>(cfg, &mut out);
    decl::<crate::commands::EwsDetectionView>(cfg, &mut out);
    decl::<crate::commands::OAuthProviderView>(cfg, &mut out);
    decl::<crate::commands::OpenedMessage>(cfg, &mut out);
    decl::<crate::commands::Moved>(cfg, &mut out);
    decl::<crate::commands::LabelCount>(cfg, &mut out);
    decl::<crate::commands::Counters>(cfg, &mut out);
    decl::<crate::commands::UnsubscribePlan>(cfg, &mut out);
    decl::<crate::commands::Unsubscribed>(cfg, &mut out);
    decl::<crate::commands::AttachmentSource>(cfg, &mut out);
    decl::<crate::commands::ComposeDraft>(cfg, &mut out);
    decl::<crate::config::Settings>(cfg, &mut out);
    decl::<crate::config::Keybindings>(cfg, &mut out);
    decl::<crate::config::Template>(cfg, &mut out);
    decl::<crate::empty::FolderCount>(cfg, &mut out);
    decl::<crate::error::CmdError>(cfg, &mut out);
    decl::<crate::server::ServerView>(cfg, &mut out);
    decl::<crate::server::QuotaView>(cfg, &mut out);
    decl::<crate::server::Estimate>(cfg, &mut out);
    decl::<crate::state::AccountStatus>(cfg, &mut out);
    decl::<crate::tasks::Task>(cfg, &mut out);
    decl::<crate::tasks::AccountSync>(cfg, &mut out);
    decl::<crate::updater::Install>(cfg, &mut out);
    decl::<crate::updater::UpdateStatus>(cfg, &mut out);
    decl::<crate::extensions::Text>(cfg, &mut out);
    decl::<crate::extensions::Command>(cfg, &mut out);
    decl::<crate::extensions::Contributes>(cfg, &mut out);
    decl::<crate::extensions::Manifest>(cfg, &mut out);
    decl::<crate::extensions::Installed>(cfg, &mut out);
    decl::<crate::extensions::Grant>(cfg, &mut out);
    decl::<crate::extensions::Preview>(cfg, &mut out);
    decl::<crate::extensions::Previous>(cfg, &mut out);
    decl::<crate::commands::OAuthGrantView>(cfg, &mut out);
    out
}

/// The generated file.
pub fn render() -> String {
    // `i64` timestamps travel as JSON numbers: they are far below 2^53.
    let cfg = Config::new().with_large_int("number");
    let decls = all(&cfg).declared;
    let mut text = String::from(
        "// Generated from the Rust structs by `scripts/gen-types.sh` (#143). Do not edit by hand:\n\
         // change the Rust type and run the script; the test `generated_types_are_current` checks it.\n\n",
    );
    for d in decls.values() {
        text.push_str(d);
        text.push_str("\n\n");
    }
    text
}

/// Whether the committed file is what the Rust types give; the error says how to mend it.
pub fn check(have: &str, want: &str) -> Result<(), String> {
    if have == want {
        return Ok(());
    }
    let line = have
        .lines()
        .zip(want.lines())
        .position(|(h, w)| h != w)
        .map_or(have.lines().count().min(want.lines().count()) + 1, |n| n + 1);
    Err(format!(
        "src/lib/generated/types.ts is not what the Rust types give (first difference at line {line}): \
         run scripts/gen-types.sh and commit the file"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/generated/types.ts");

    #[test]
    fn generated_types_are_current() {
        let want = render();
        if std::env::var_os("UPDATE_TYPES").is_some() {
            std::fs::create_dir_all(std::path::Path::new(FILE).parent().unwrap()).unwrap();
            std::fs::write(FILE, &want).unwrap();
            return;
        }
        let have = std::fs::read_to_string(FILE).unwrap_or_default();
        if let Err(why) = check(&have, &want) {
            panic!("{why}");
        }
    }

    /// A field changed in Rust makes the committed file stale, and the check says so.
    #[test]
    fn a_changed_field_fails_the_check() {
        #[derive(TS)]
        #[ts(rename = "Probe")]
        #[allow(dead_code, reason = "a probe: the struct exists for the type generated from it")]
        struct Before {
            subject: String,
        }
        #[derive(TS)]
        #[ts(rename = "Probe")]
        #[allow(dead_code, reason = "a probe: the struct exists for the type generated from it")]
        struct After {
            subject: String,
            sent: Option<i64>,
        }
        let cfg = Config::new().with_large_int("number");
        let mut committed = Decls::default();
        decl::<Before>(&cfg, &mut committed);
        let mut changed = Decls::default();
        decl::<After>(&cfg, &mut changed);
        let have: String = committed.declared.values().cloned().collect();
        let want: String = changed.declared.values().cloned().collect();
        assert!(check(&have, &have).is_ok());
        let why = check(&have, &want).unwrap_err();
        assert!(why.contains("scripts/gen-types.sh") && why.contains("line 1"), "{why}");
    }

    /// Two Rust types that come out under one TypeScript name would overwrite each other in the
    /// file: that is an error, not a quiet loss of one.
    #[test]
    #[should_panic(expected = "два типа с именем Probe")]
    fn two_types_with_one_name_fail() {
        #[derive(TS)]
        #[ts(rename = "Probe")]
        #[allow(dead_code, reason = "a probe: the struct exists for the type generated from it")]
        struct First {
            a: u8,
        }
        #[derive(TS)]
        #[ts(rename = "Probe")]
        #[allow(dead_code, reason = "a probe: the struct exists for the type generated from it")]
        struct Second {
            b: u8,
        }
        let cfg = Config::new();
        let mut out = Decls::default();
        decl::<First>(&cfg, &mut out);
        decl::<Second>(&cfg, &mut out);
    }

    /// A type used inside a listed one is listed too, or the file would name a type it does not declare.
    #[test]
    fn every_type_the_file_uses_is_declared_in_it() {
        let cfg = Config::new().with_large_int("number");
        let all = all(&cfg);
        let missing: Vec<_> = all.used.iter().filter(|n| !all.declared.contains_key(*n)).collect();
        assert!(missing.is_empty(), "add to ts_types::all: {missing:?}");
    }
}
