//! Extensions: a folder with `manifest.json` and one script. The script runs in a
//! worker inside a sandboxed frame served from the `ext:` scheme, with a CSP that allows
//! no network except the hosts the manifest names. It reaches Depesha only through
//! messages, and the host checks every request against the declared permissions.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use depesha_core::tr;
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::error::{CmdError, CmdResult};

const MAX_SCRIPT: u64 = 512 * 1024;
const MAX_STORAGE: usize = 1024 * 1024;

/// Text in the interface languages; English is required.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Text {
    pub en: String,
    #[serde(default)]
    pub ru: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Command {
    pub id: String,
    pub title: Text,
    /// Shown in the message menu and given the open message (needs `messages.read`).
    #[serde(default)]
    pub message: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Contributes {
    #[serde(default)]
    pub commands: Vec<Command>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub id: String,
    pub name: Text,
    #[serde(default)]
    pub description: Option<Text>,
    pub version: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default = "default_main")]
    pub main: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    /// Events the extension handles; it is started only when one of them happens.
    #[serde(default)]
    pub hooks: Vec<String>,
    #[serde(default)]
    pub contributes: Contributes,
}

fn default_main() -> String {
    "main.js".into()
}

const PERMISSIONS: &[&str] = &["messages.read", "messages.modify", "storage"];
const HOOKS: &[&str] = &["messageOpen", "newMail", "beforeSend"];

/// What the user agreed to when installing, kept beside the copy (not taken from the folder).
const GRANT_FILE: &str = "granted.json";

/// Zones that resolve only inside a network or are reserved: a plugin must not reach them.
const INTERNAL_ZONES: &[&str] = &[
    "localhost",
    "local",
    "localdomain",
    "internal",
    "intranet",
    "corp",
    "lan",
    "home",
    "private",
    "home.arpa",
    "arpa",
    "test",
    "invalid",
    "example",
    "onion",
    "alt",
];

/// Names Windows keeps for devices whatever the extension: `con.js` is not a file there.
const DEVICES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2",
    "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-'))
        && !id.starts_with('.')
        && !id.contains("..")
}

/// A public internet host by name. No IP address in any form the URL parser reads as one
/// (`127.1`, `0x7f.0.0.1`: a last label of digits or `0x…` makes it IPv4), no `localhost`,
/// no internal or reserved zone, no trailing dot.
fn public_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    let labels: Vec<&str> = host.split('.').collect();
    host.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                && !l.starts_with('-')
                && !l.ends_with('-')
        })
        && labels
            .last()
            .is_some_and(|tld| tld.starts_with(|c: char| c.is_ascii_alphabetic()))
        && !INTERNAL_ZONES
            .iter()
            .any(|z| host == *z || host.ends_with(&format!(".{z}")))
}

/// A plain file name on every system: letters, digits, `-`, `_` and inner dots, ending in
/// `.js`. No separators, drive prefixes (`C:x.js`), streams (`a.js:b.js`) or device names.
fn valid_main(main: &str) -> bool {
    let Some(stem) = main.strip_suffix(".js") else {
        return false;
    };
    let base = stem.split('.').next().unwrap_or_default().to_ascii_lowercase();
    !stem.is_empty()
        && main.len() <= 64
        && stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !stem.starts_with('.')
        && !stem.ends_with('.')
        && !stem.contains("..")
        && !DEVICES.contains(&base.as_str())
}

/// The script inside an extension folder; `None` for a name that could lead out of it.
fn script_path(dir: &Path, main: &str) -> Option<PathBuf> {
    if !valid_main(main) {
        return None;
    }
    let mut parts = Path::new(main).components();
    let (Some(std::path::Component::Normal(_)), None) = (parts.next(), parts.next()) else {
        return None;
    };
    let path = dir.join(main);
    (path.parent() == Some(dir)).then_some(path)
}

/// Permissions and hooks, the set a user agrees to.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    pub permissions: Vec<String>,
    pub hooks: Vec<String>,
}

impl Grant {
    fn of(m: &Manifest) -> Self {
        Self {
            permissions: m.permissions.clone(),
            hooks: m.hooks.clone(),
        }
        .normalized()
    }

    fn normalized(mut self) -> Self {
        self.permissions.sort();
        self.permissions.dedup();
        self.hooks.sort();
        self.hooks.dedup();
        self
    }
}

impl Manifest {
    fn has(&self, permission: &str) -> bool {
        self.permissions.iter().any(|p| p == permission)
    }

    /// Hosts the extension may connect to over https.
    pub fn hosts(&self) -> Vec<&str> {
        self.permissions
            .iter()
            .filter_map(|p| p.strip_prefix("network:"))
            .collect()
    }

    /// Reads mail and has a network: the text of messages can leave the computer.
    fn sends_mail_out(&self) -> bool {
        self.has("messages.read") && !self.hosts().is_empty()
    }

    fn validate(&self) -> CmdResult<()> {
        let bad = |what: String| {
            Err(CmdError::new(
                "extension",
                tr!("invalid manifest: {what}", "неверный манифест: {what}"),
            ))
        };
        if !valid_id(&self.id) {
            return bad(format!("id “{}”", self.id));
        }
        if self.name.en.trim().is_empty() {
            return bad("name.en".into());
        }
        if !valid_main(&self.main) {
            return Err(CmdError::new(
                "extension",
                tr!(
                    "invalid manifest: main “{}” must be a plain file name in the plugin's folder, like main.js",
                    "неверный манифест: main «{}» должен быть простым именем файла в папке плагина, например main.js",
                    self.main
                ),
            ));
        }
        for p in &self.permissions {
            if let Some(host) = p.strip_prefix("network:") {
                if !public_host(host) {
                    return Err(CmdError::new(
                        "extension",
                        tr!(
                            "invalid manifest: permission “{p}”: a plugin may reach only public internet hosts by name, not IP addresses, localhost or names of a local network",
                            "неверный манифест: право «{p}»: плагину доступны только публичные хосты интернета по имени, а не IP-адреса, localhost или имена локальной сети"
                        ),
                    ));
                }
            } else if !PERMISSIONS.contains(&p.as_str()) {
                return bad(format!("permission “{p}”"));
            }
        }
        for h in &self.hooks {
            if !HOOKS.contains(&h.as_str()) {
                return bad(format!("hook “{h}”"));
            }
            // Every hook hands over mail.
            if !self.has("messages.read") {
                return bad(format!("hook “{h}” needs messages.read"));
            }
        }
        for c in &self.contributes.commands {
            if !valid_id(&c.id) || c.title.en.trim().is_empty() {
                return bad(format!("command “{}”", c.id));
            }
            if c.message && !self.has("messages.read") {
                return bad(format!("command “{}” needs messages.read", c.id));
            }
        }
        Ok(())
    }
}

fn root(app: &tauri::AppHandle) -> CmdResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CmdError::new("io", e.to_string()))?
        .join("extensions");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// An extension folder: the checked manifest, its text as read, and the script.
struct Loaded {
    manifest: Manifest,
    text: String,
    code: Vec<u8>,
}

fn load(dir: &Path) -> CmdResult<Loaded> {
    let text = std::fs::read_to_string(dir.join("manifest.json"))
        .map_err(|e| CmdError::new("extension", tr!("no manifest.json: {e}", "нет manifest.json: {e}")))?;
    let manifest: Manifest = serde_json::from_str(&text)
        .map_err(|e| CmdError::new("extension", tr!("invalid manifest: {e}", "неверный манифест: {e}")))?;
    manifest.validate()?;
    let no_script = || CmdError::new("extension", tr!("no script {}", "нет скрипта {}", manifest.main));
    let script = script_path(dir, &manifest.main).ok_or_else(no_script)?;
    let size = std::fs::metadata(&script).map_err(|_| no_script())?.len();
    if size > MAX_SCRIPT {
        return Err(CmdError::new(
            "extension",
            tr!("the script is over 512 KB", "скрипт больше 512 КБ"),
        ));
    }
    let code = std::fs::read(&script).map_err(|_| no_script())?;
    if code.len() as u64 > MAX_SCRIPT {
        return Err(CmdError::new(
            "extension",
            tr!("the script is over 512 KB", "скрипт больше 512 КБ"),
        ));
    }
    Ok(Loaded { manifest, text, code })
}

/// What the user agreed to for an installed copy. A copy from before consent was asked
/// counts as agreed to unless it can send mail out: that one waits for a fresh approval.
fn granted(dir: &Path, m: &Manifest) -> Option<Grant> {
    match std::fs::read(dir.join(GRANT_FILE)) {
        Ok(bytes) => serde_json::from_slice::<Grant>(&bytes).ok().map(Grant::normalized),
        Err(_) if !m.sends_mail_out() => Some(Grant::of(m)),
        Err(_) => None,
    }
}

fn consented(dir: &Path, m: &Manifest) -> bool {
    granted(dir, m) == Some(Grant::of(m))
}

#[derive(Serialize)]
pub struct Installed {
    #[serde(flatten)]
    manifest: Manifest,
    enabled: bool,
    /// Why it is not loaded: its manifest or script fails the checks.
    problem: Option<String>,
    /// Waits for the user to approve its permissions before it runs.
    review: bool,
}

pub fn list(app: &tauri::AppHandle, disabled: &[String]) -> CmdResult<Vec<Installed>> {
    list_in(&root(app)?, disabled)
}

fn list_in(root: &Path, disabled: &[String]) -> CmdResult<Vec<Installed>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let dir = entry?.path();
        let Some(name) = dir.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };
        // Copies being installed start with a dot.
        if !dir.is_dir() || name.starts_with('.') {
            continue;
        }
        match load(&dir) {
            Ok(Loaded { manifest, .. }) => {
                let review = !consented(&dir, &manifest);
                out.push(Installed {
                    enabled: !review && !disabled.contains(&manifest.id),
                    manifest,
                    problem: None,
                    review,
                })
            }
            // Shown with the reason instead of vanishing, so it can be understood and removed.
            Err(e) if valid_id(&name) => {
                tracing::warn!(dir = %dir.display(), "extension not loaded: {}", e.message);
                out.push(Installed {
                    manifest: refused(&dir, &name),
                    enabled: false,
                    problem: Some(e.message),
                    review: false,
                })
            }
            Err(e) => tracing::warn!(dir = %dir.display(), "skipping extension: {}", e.message),
        }
    }
    out.sort_by(|a, b| a.manifest.name.en.cmp(&b.manifest.name.en));
    Ok(out)
}

/// What can be shown of an extension that is not loaded; the folder name is its id.
fn refused(dir: &Path, id: &str) -> Manifest {
    let raw = std::fs::read_to_string(dir.join("manifest.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Manifest>(&t).ok());
    let name = Text {
        en: id.to_owned(),
        ru: None,
    };
    match raw {
        Some(m) => Manifest {
            id: id.to_owned(),
            name: if m.name.en.trim().is_empty() { name } else { m.name },
            main: String::new(),
            hooks: Vec::new(),
            contributes: Contributes::default(),
            ..m
        },
        None => Manifest {
            id: id.to_owned(),
            name,
            description: None,
            version: String::new(),
            author: None,
            main: String::new(),
            permissions: Vec::new(),
            hooks: Vec::new(),
            contributes: Contributes::default(),
        },
    }
}

/// An extension folder looked at before installing: nothing is copied.
#[derive(Serialize)]
pub struct Preview {
    manifest: Manifest,
    /// The installed copy with the same id, and what the user agreed to for it.
    previous: Option<Previous>,
}

#[derive(Serialize)]
pub struct Previous {
    version: String,
    /// Empty when nothing was agreed to: every permission then counts as new.
    granted: Grant,
}

pub fn inspect(app: &tauri::AppHandle, from: &Path) -> CmdResult<Preview> {
    inspect_in(&root(app)?, from)
}

fn inspect_in(root: &Path, from: &Path) -> CmdResult<Preview> {
    let manifest = load(from)?.manifest;
    let dir = root.join(&manifest.id);
    let previous = load(&dir).ok().map(|old| Previous {
        granted: granted(&dir, &old.manifest).unwrap_or_default(),
        version: old.manifest.version,
    });
    Ok(Preview { manifest, previous })
}

fn differs() -> CmdError {
    CmdError::new(
        "extension",
        tr!(
            "the plugin's permissions differ from the ones agreed to; look at it again",
            "права плагина отличаются от тех, на которые дано согласие; посмотрите его ещё раз"
        ),
    )
}

/// Copies an extension folder in, replacing an older copy with the same id, only if its
/// permissions and hooks are the ones the user agreed to.
pub fn install(app: &tauri::AppHandle, from: &Path, grant: Grant) -> CmdResult<Manifest> {
    install_into(&root(app)?, from, grant)
}

fn install_into(root: &Path, from: &Path, grant: Grant) -> CmdResult<Manifest> {
    // What was checked is what is written: the folder may change after it was read.
    let Loaded { manifest, text, code } = load(from)?;
    if Grant::of(&manifest) != grant.normalized() {
        return Err(differs());
    }
    let staging = root.join(format!(".{}.new", manifest.id));
    let to = root.join(&manifest.id);
    let script = script_path(&staging, &manifest.main).ok_or_else(differs)?;
    let copy = || -> CmdResult<()> {
        if staging.exists() {
            std::fs::remove_dir_all(&staging)?;
        }
        std::fs::create_dir_all(&staging)?;
        std::fs::write(staging.join("manifest.json"), &text)?;
        std::fs::write(&script, &code)?;
        let grant = serde_json::to_vec(&Grant::of(&manifest)).map_err(|e| CmdError::new("io", e.to_string()))?;
        std::fs::write(staging.join(GRANT_FILE), grant)?;
        if to.exists() {
            std::fs::remove_dir_all(&to)?;
        }
        std::fs::rename(&staging, &to)?;
        Ok(())
    };
    if let Err(e) = copy() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    Ok(manifest)
}

/// Records the user's approval of an installed extension's permissions.
pub fn approve(app: &tauri::AppHandle, id: &str, grant: Grant) -> CmdResult<()> {
    approve_in(&root(app)?, id, grant)
}

fn approve_in(root: &Path, id: &str, grant: Grant) -> CmdResult<()> {
    if !valid_id(id) {
        return Err(CmdError::new("extension", "bad id"));
    }
    let dir = root.join(id);
    let manifest = load(&dir)?.manifest;
    if Grant::of(&manifest) != grant.normalized() {
        return Err(differs());
    }
    let bytes = serde_json::to_vec(&Grant::of(&manifest)).map_err(|e| CmdError::new("io", e.to_string()))?;
    std::fs::write(dir.join(GRANT_FILE), bytes)?;
    Ok(())
}

pub fn remove(app: &tauri::AppHandle, id: &str) -> CmdResult<()> {
    if !valid_id(id) {
        return Err(CmdError::new("extension", "bad id"));
    }
    let dir = root(app)?.join(id);
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    let _ = std::fs::remove_file(storage_path(app, id)?);
    Ok(())
}

fn storage_path(app: &tauri::AppHandle, id: &str) -> CmdResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CmdError::new("io", e.to_string()))?
        .join("extension-data");
    storage_file(&dir, id)
}

/// The file an extension keeps its data in; an id that is not one never leaves the folder.
fn storage_file(dir: &Path, id: &str) -> CmdResult<PathBuf> {
    if !valid_id(id) {
        return Err(CmdError::new("extension", "bad id"));
    }
    std::fs::create_dir_all(dir)?;
    Ok(dir.join(format!("{id}.json")))
}

pub fn storage_get(app: &tauri::AppHandle, id: &str, key: &str) -> CmdResult<serde_json::Value> {
    let map = load_storage(app, id)?;
    Ok(map.get(key).cloned().unwrap_or(serde_json::Value::Null))
}

pub fn storage_set(app: &tauri::AppHandle, id: &str, key: &str, value: serde_json::Value) -> CmdResult<()> {
    let mut map = load_storage(app, id)?;
    if value.is_null() {
        map.remove(key);
    } else {
        map.insert(key.to_owned(), value);
    }
    let bytes = serde_json::to_vec(&map).map_err(|e| CmdError::new("io", e.to_string()))?;
    if bytes.len() > MAX_STORAGE {
        return Err(CmdError::new(
            "extension",
            tr!("extension storage is over 1 MB", "данные расширения больше 1 МБ"),
        ));
    }
    std::fs::write(storage_path(app, id)?, bytes)?;
    Ok(())
}

fn load_storage(app: &tauri::AppHandle, id: &str) -> CmdResult<BTreeMap<String, serde_json::Value>> {
    match std::fs::read(storage_path(app, id)?) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
        Err(_) => Ok(BTreeMap::new()),
    }
}

/// `ext:` scheme: `/<id>/` is the sandbox page of an installed, enabled extension.
pub fn serve(app: &tauri::AppHandle, path: &str, disabled: &[String]) -> tauri::http::Response<Vec<u8>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .expect("static response")
    };
    let id = path.trim_matches('/');
    if !valid_id(id) || disabled.iter().any(|d| d == id) {
        return not_found();
    }
    let Ok(dir) = root(app).map(|r| r.join(id)) else {
        return not_found();
    };
    // Only what passes the checks and was agreed to runs.
    let Ok(Loaded { manifest, code, .. }) = load(&dir) else {
        return not_found();
    };
    if !consented(&dir, &manifest) {
        return not_found();
    }
    let Ok(code) = String::from_utf8(code) else {
        return not_found();
    };
    let lang = if depesha_core::lang::is_ru() {
        "\"ru\""
    } else {
        "\"en\""
    };
    let source = format!(
        "{}\n;(() => {{\n{code}\n}})();\npostMessage({{ type: \"ready\" }});\n",
        include_str!("ext/runtime.js").replace("__DEPESHA_LANG__", lang)
    );
    let nonce = nonce();
    let connect = match manifest.hosts().as_slice() {
        [] => "'none'".to_owned(),
        hosts => hosts
            .iter()
            .map(|h| format!("https://{h}"))
            .collect::<Vec<_>>()
            .join(" "),
    };
    // The worker inherits this policy: no network but the declared hosts, nothing else loads.
    let csp = format!(
        "default-src 'none'; script-src 'nonce-{nonce}'; worker-src blob:; connect-src {connect}; \
         img-src 'none'; style-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"
    );
    let source_json = serde_json::to_string(&source)
        .unwrap_or_default()
        .replace('<', "\\u003c");
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
         <meta http-equiv=\"Content-Security-Policy\" content=\"{csp}\">\
         <script type=\"application/json\" id=\"source\">{source_json}</script>\
         <script nonce=\"{nonce}\">{}</script></head><body></body></html>",
        include_str!("ext/bridge.js")
    );
    tauri::http::Response::builder()
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", csp)
        .body(html.into_bytes())
        .expect("valid response")
}

fn nonce() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    );
    format!(
        "{:016x}{:016x}",
        h.finish(),
        std::collections::hash_map::RandomState::new().build_hasher().finish()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_data_stays_in_its_folder() {
        let root = std::env::temp_dir().join(format!("depesha-ext-data-{}", std::process::id()));
        let dir = root.join("extension-data");
        assert_eq!(
            storage_file(&dir, "ru.example.rules").unwrap(),
            dir.join("ru.example.rules.json")
        );
        for id in [
            "../../x",
            "..",
            "a/b",
            "a\\b",
            "..\\x",
            "/etc/passwd",
            "",
            ".hidden",
            "A",
        ] {
            assert!(storage_file(&dir, id).is_err(), "{id:?}");
        }
        assert_eq!(
            std::fs::read_dir(&root).unwrap().count(),
            1,
            "only extension-data was made"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn manifest(json: &str) -> CmdResult<Manifest> {
        let m: Manifest = serde_json::from_str(json).unwrap();
        m.validate().map(|()| m)
    }

    fn with_permission(p: &str) -> CmdResult<Manifest> {
        manifest(&format!(
            r#"{{"id":"a","name":{{"en":"x"}},"version":"1","permissions":["{p}"]}}"#
        ))
    }

    fn with_main(main: &str) -> CmdResult<Manifest> {
        let main = serde_json::to_string(main).unwrap();
        manifest(&format!(
            r#"{{"id":"a","name":{{"en":"x"}},"version":"1","main":{main}}}"#
        ))
    }

    /// A fresh folder under the system temp directory, removed when dropped.
    struct Temp(PathBuf);

    impl Temp {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("depesha-ext-{name}-{}", nonce()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn plugin(dir: &Path, json: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("manifest.json"), json).unwrap();
        std::fs::write(dir.join("main.js"), "depesha.on('messageOpen', () => null);").unwrap();
    }

    fn grant(permissions: &[&str], hooks: &[&str]) -> Grant {
        Grant {
            permissions: permissions.iter().map(|s| s.to_string()).collect(),
            hooks: hooks.iter().map(|s| s.to_string()).collect(),
        }
    }

    const READER: &str = r#"{"id":"x.reader","name":{"en":"Reader"},"version":"1",
        "permissions":["messages.read"],"hooks":["messageOpen"]}"#;
    const LEAK: &str = r#"{"id":"x.reader","name":{"en":"Reader"},"version":"2",
        "permissions":["messages.read","network:api.example.com"],"hooks":["messageOpen"]}"#;

    #[test]
    fn validates_manifests() {
        let ok = manifest(
            r#"{"id":"acme.rules","name":{"en":"Rules"},"version":"1.0.0",
               "permissions":["messages.read","messages.modify","network:api.github.com"],"hooks":["newMail"]}"#,
        )
        .unwrap();
        assert_eq!(ok.hosts(), ["api.github.com"]);
        assert_eq!(ok.main, "main.js");

        for bad in [
            r#"{"id":"../evil","name":{"en":"x"},"version":"1"}"#,
            r#"{"id":"Upper","name":{"en":"x"},"version":"1"}"#,
            r#"{"id":"a","name":{"en":"x"},"version":"1","main":"../x.js"}"#,
            r#"{"id":"a","name":{"en":"x"},"version":"1","permissions":["fs.write"]}"#,
            r#"{"id":"a","name":{"en":"x"},"version":"1","permissions":["network:*"]}"#,
            r#"{"id":"a","name":{"en":"x"},"version":"1","hooks":["messageOpen"]}"#,
            r#"{"id":"a","name":{"en":"x"},"version":"1","hooks":["onStartup"],"permissions":["messages.read"]}"#,
        ] {
            assert!(manifest(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn network_only_to_public_hosts() {
        for host in ["api.example.com", "api.github.com", "mail.xn--p1ai", "a-b.co.uk"] {
            assert!(with_permission(&format!("network:{host}")).is_ok(), "{host}");
        }
        for host in [
            "127.0.0.1",
            "127.1",
            "0x7f.0.0.1",
            "0X7F.1",
            "2130706433",
            "10.0.0.5",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "1.1.1.1",
            "localhost",
            "a.localhost",
            "LOCALHOST",
            "localhost.",
            "printer.local",
            "router.lan",
            "svc.internal",
            "x.home.arpa",
            "1.0.0.127.in-addr.arpa",
            "host.corp",
            "wiki.intranet",
            "site.test",
            "x.invalid",
            "api.acme.example",
            "api.example.com.",
            ".example.com",
            "a..example.com",
            "-a.example.com",
            "a-.example.com",
            "[::1]",
            "::1",
            "*",
            "",
        ] {
            let e = with_permission(&format!("network:{host}")).expect_err(host);
            assert!(e.message.contains("network:"), "{host}: {}", e.message);
        }
    }

    #[test]
    fn main_is_a_plain_file_name() {
        for ok in ["main.js", "plugin-1.js", "my_plugin.min.js"] {
            assert!(with_main(ok).is_ok(), "{ok}");
        }
        // Case matters: `x.JS` is refused like any other name not ending in `.js`.
        for bad in [
            "C:x.js",
            "c:x.js",
            "C:\\x.js",
            "a.js:b.js",
            "../x.js",
            "..\\x.js",
            "/x.js",
            "\\\\server\\share\\x.js",
            ".js",
            ".x.js",
            "x..js",
            "x.JS",
            "x y.js",
            "x.js ",
            "con.js",
            "NUL.min.js",
            "lpt1.js",
            "main",
            "",
        ] {
            assert!(with_main(bad).is_err(), "{bad:?}");
            assert!(script_path(Path::new("ext"), bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn script_stays_in_the_extension_folder() {
        let dir = Path::new("extensions").join("acme.rules");
        for name in ["main.js", "plugin-1.js", "a.b.js"] {
            let path = script_path(&dir, name).unwrap();
            assert_eq!(path.parent(), Some(dir.as_path()));
            assert_eq!(path.file_name().and_then(|n| n.to_str()), Some(name));
        }
    }

    #[test]
    fn installs_only_what_was_agreed_to() {
        let root = Temp::new("root");
        let src = Temp::new("src");
        plugin(&src.0, LEAK);

        // A different set, or none, copies nothing.
        for wrong in [
            grant(&[], &[]),
            grant(&["messages.read"], &["messageOpen"]),
            grant(&["messages.read", "network:api.example.com"], &[]),
        ] {
            assert!(install_into(&root.0, &src.0, wrong).is_err());
            assert_eq!(std::fs::read_dir(&root.0).unwrap().count(), 0);
        }

        let m = install_into(
            &root.0,
            &src.0,
            grant(&["network:api.example.com", "messages.read"], &["messageOpen"]),
        )
        .unwrap();
        assert_eq!(m.id, "x.reader");
        let list = list_in(&root.0, &[]).unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].enabled && !list[0].review && list[0].problem.is_none());
    }

    #[test]
    fn an_update_shows_what_was_agreed_to_before() {
        let root = Temp::new("root");
        let src = Temp::new("src");
        plugin(&src.0, READER);
        install_into(&root.0, &src.0, grant(&["messages.read"], &["messageOpen"])).unwrap();

        plugin(&src.0, LEAK);
        let preview = inspect_in(&root.0, &src.0).unwrap();
        assert_eq!(preview.manifest.version, "2");
        let previous = preview.previous.unwrap();
        assert_eq!(previous.version, "1");
        assert_eq!(previous.granted, grant(&["messages.read"], &["messageOpen"]));

        // Refusing the wider set keeps the old copy.
        assert!(install_into(&root.0, &src.0, grant(&["messages.read"], &["messageOpen"])).is_err());
        let list = list_in(&root.0, &[]).unwrap();
        assert_eq!(list[0].manifest.version, "1");
        assert_eq!(list[0].manifest.permissions, ["messages.read"]);
    }

    #[test]
    fn old_copies_that_send_mail_out_wait_for_approval() {
        let root = Temp::new("root");
        // Copied in before consent was asked: no record of it.
        plugin(&root.0.join("x.reader"), LEAK);
        plugin(
            &root.0.join("x.rules"),
            r#"{"id":"x.rules","name":{"en":"Rules"},"version":"1","permissions":["messages.read","messages.modify"],"hooks":["newMail"]}"#,
        );
        let list = list_in(&root.0, &[]).unwrap();
        let reader = list.iter().find(|e| e.manifest.id == "x.reader").unwrap();
        assert!(reader.review && !reader.enabled);
        let rules = list.iter().find(|e| e.manifest.id == "x.rules").unwrap();
        assert!(!rules.review && rules.enabled);

        assert!(approve_in(&root.0, "x.reader", grant(&["messages.read"], &["messageOpen"])).is_err());
        approve_in(
            &root.0,
            "x.reader",
            grant(&["messages.read", "network:api.example.com"], &["messageOpen"]),
        )
        .unwrap();
        let list = list_in(&root.0, &[]).unwrap();
        let reader = list.iter().find(|e| e.manifest.id == "x.reader").unwrap();
        assert!(!reader.review && reader.enabled);
    }

    #[test]
    fn refused_copies_are_listed_with_the_reason() {
        let root = Temp::new("root");
        plugin(
            &root.0.join("x.local"),
            r#"{"id":"x.local","name":{"en":"Local"},"version":"1","permissions":["messages.read","network:127.0.0.1"],"hooks":["messageOpen"]}"#,
        );
        let list = list_in(&root.0, &[]).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].manifest.id, "x.local");
        assert_eq!(list[0].manifest.name.en, "Local");
        assert!(!list[0].enabled);
        assert!(list[0].problem.as_deref().unwrap().contains("127.0.0.1"));
    }
}
