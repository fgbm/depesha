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

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-'))
        && !id.starts_with('.')
        && !id.contains("..")
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
        && host.contains('.')
        && !host.starts_with(['.', '-'])
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
        if self.main.contains(['/', '\\']) || !self.main.ends_with(".js") {
            return bad(format!("main “{}”", self.main));
        }
        for p in &self.permissions {
            let known = PERMISSIONS.contains(&p.as_str()) || p.strip_prefix("network:").is_some_and(valid_host);
            if !known {
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

fn read_manifest(dir: &Path) -> CmdResult<Manifest> {
    let text = std::fs::read_to_string(dir.join("manifest.json"))
        .map_err(|e| CmdError::new("extension", tr!("no manifest.json: {e}", "нет manifest.json: {e}")))?;
    let m: Manifest = serde_json::from_str(&text)
        .map_err(|e| CmdError::new("extension", tr!("invalid manifest: {e}", "неверный манифест: {e}")))?;
    m.validate()?;
    let script = dir.join(&m.main);
    let size = std::fs::metadata(&script)
        .map_err(|_| CmdError::new("extension", tr!("no script {}", "нет скрипта {}", m.main)))?
        .len();
    if size > MAX_SCRIPT {
        return Err(CmdError::new(
            "extension",
            tr!("the script is over 512 KB", "скрипт больше 512 КБ"),
        ));
    }
    Ok(m)
}

#[derive(Serialize)]
pub struct Installed {
    #[serde(flatten)]
    manifest: Manifest,
    enabled: bool,
}

pub fn list(app: &tauri::AppHandle, disabled: &[String]) -> CmdResult<Vec<Installed>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(root(app)?)? {
        let dir = entry?.path();
        match read_manifest(&dir) {
            Ok(manifest) => out.push(Installed {
                enabled: !disabled.contains(&manifest.id),
                manifest,
            }),
            Err(e) => tracing::warn!(dir = %dir.display(), "skipping extension: {}", e.message),
        }
    }
    out.sort_by(|a, b| a.manifest.name.en.cmp(&b.manifest.name.en));
    Ok(out)
}

/// Copies an extension folder in, replacing an older copy with the same id.
pub fn install(app: &tauri::AppHandle, from: &Path) -> CmdResult<Manifest> {
    let manifest = read_manifest(from)?;
    let to = root(app)?.join(&manifest.id);
    if to.exists() {
        std::fs::remove_dir_all(&to)?;
    }
    std::fs::create_dir_all(&to)?;
    for name in ["manifest.json", manifest.main.as_str()] {
        std::fs::copy(from.join(name), to.join(name))?;
    }
    Ok(manifest)
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
    std::fs::create_dir_all(&dir)?;
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
    if !valid_id(id) {
        return Err(CmdError::new("extension", "bad id"));
    }
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
    let Ok(manifest) = read_manifest(&dir) else {
        return not_found();
    };
    let Ok(code) = std::fs::read_to_string(dir.join(&manifest.main)) else {
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

    fn manifest(json: &str) -> CmdResult<Manifest> {
        let m: Manifest = serde_json::from_str(json).unwrap();
        m.validate().map(|()| m)
    }

    #[test]
    fn validates_manifests() {
        let ok = manifest(
            r#"{"id":"acme.rules","name":{"en":"Rules"},"version":"1.0.0",
               "permissions":["messages.read","messages.modify","network:api.acme.example"],"hooks":["newMail"]}"#,
        )
        .unwrap();
        assert_eq!(ok.hosts(), ["api.acme.example"]);
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
}
