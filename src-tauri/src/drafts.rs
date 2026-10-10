//! The local copy of a draft (#71): while the user types, the letter is written here on
//! every pause, so a crash of the app or the computer loses nothing. The server copy still
//! follows at most once a minute and on closing; this file is the fallback in between, and
//! the window offers to restore it when the app starts again.
//!
//! One small JSON file per draft, under `drafts/` in the app data directory: writing one
//! draft does not rewrite the others, and two windows never race over one file. The file
//! goes as soon as the draft reaches the server (or is thrown away).

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use depesha_core::domain::CachedDraft;

use crate::error::{CmdError, CmdResult};

/// The folder the local copies live in.
pub fn dir(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| CmdError::new("io", e.to_string()))?
        .join("drafts"))
}

/// The key as a file name: the window makes a UUID, and nothing else passes.
fn safe_key(key: &str) -> String {
    let cleaned: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(80)
        .collect();
    if cleaned.is_empty() {
        "draft".to_owned()
    } else {
        cleaned
    }
}

/// Writes the draft to the local copy; the previous one under the same key is replaced.
#[tauri::command]
pub async fn draft_cache_put(
    app: AppHandle,
    key: String,
    account_id: String,
    draft: serde_json::Value,
    draft_id: Option<i64>,
    draft_message_id: Option<String>,
) -> CmdResult<()> {
    let entry = CachedDraft {
        key,
        account_id,
        draft,
        draft_id,
        draft_message_id,
        updated: chrono::Utc::now().timestamp(),
    };
    write(&dir(&app)?, &entry).await
}

/// Every draft kept locally, for the window to offer restoring when the app starts.
#[tauri::command]
pub async fn draft_cache_list(app: AppHandle) -> CmdResult<Vec<CachedDraft>> {
    read_all(&dir(&app)?).await
}

/// The draft reached the server (or was thrown away): the local copy goes.
#[tauri::command]
pub async fn draft_cache_drop(app: AppHandle, key: String) -> CmdResult<()> {
    remove(&dir(&app)?, &key).await
}

/// Removes one copy. One that is already gone is fine; any other failure is told: a copy left
/// behind is offered for restore at the next start, and a letter already sent could go twice.
async fn remove(dir: &std::path::Path, key: &str) -> CmdResult<()> {
    match tokio::fs::remove_file(dir.join(safe_key(key))).await {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// Drops the local copies of these keys: their drafts left the Drafts folder with «Clear» (#74).
pub async fn drop_all(app: &AppHandle, keys: &[String]) -> CmdResult<()> {
    let dir = dir(app)?;
    for key in keys {
        let _ = tokio::fs::remove_file(dir.join(safe_key(key))).await;
    }
    Ok(())
}

/// Writes one draft under `dir`, in a file named after its key.
async fn write(dir: &std::path::Path, entry: &CachedDraft) -> CmdResult<()> {
    tokio::fs::create_dir_all(dir).await?;
    let bytes = serde_json::to_vec(entry).map_err(|e| CmdError::new("io", e.to_string()))?;
    // Whole or not at all: a crash mid-write leaves the old file, never a cut one.
    let path = dir.join(safe_key(&entry.key));
    let tmp = dir.join(format!("{}.tmp", safe_key(&entry.key)));
    let written = async {
        let mut file = tokio::fs::File::create(&tmp).await?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &bytes).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&tmp, &path).await
    }
    .await;
    if let Err(e) = written {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e.into());
    }
    Ok(())
}

/// Every draft under `dir`, oldest first; a file that does not parse is skipped.
pub async fn read_all(dir: &std::path::Path) -> CmdResult<Vec<CachedDraft>> {
    let mut out = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return Ok(out);
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry.path().extension().is_some_and(|e| e != "json") {
            continue;
        }
        if let Ok(bytes) = tokio::fs::read(entry.path()).await
            && let Ok(draft) = serde_json::from_slice::<CachedDraft>(&bytes)
        {
            out.push(draft);
        }
    }
    out.sort_by_key(|d| d.updated);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{CachedDraft, read_all, remove, safe_key, write};
    use serde_json::json;

    fn entry(key: &str, updated: i64) -> CachedDraft {
        CachedDraft {
            key: key.into(),
            account_id: "a".into(),
            draft: json!({ "subject": "Привет", "text": "тело" }),
            draft_id: None,
            draft_message_id: None,
            updated,
        }
    }

    #[test]
    fn a_copy_written_before_the_message_id_was_kept_still_reads() {
        let old = r#"{"key":"k","account_id":"a","draft":{},"draft_id":7,"updated":1}"#;
        let d: CachedDraft = serde_json::from_str(old).unwrap();
        assert_eq!((d.draft_id, d.draft_message_id), (Some(7), None));
        let new =
            r#"{"key":"k","account_id":"a","draft":{},"draft_id":7,"draft_message_id":"x@depesha.local","updated":1}"#;
        let d: CachedDraft = serde_json::from_str(new).unwrap();
        assert_eq!(d.draft_message_id.as_deref(), Some("x@depesha.local"));
    }

    #[test]
    fn a_key_cannot_name_a_path_of_its_own() {
        assert_eq!(safe_key("1a2b-3c4d"), "1a2b-3c4d");
        // No separators and no climbing out of the drafts folder.
        assert_eq!(safe_key("../../etc/passwd"), "....etcpasswd");
        assert_eq!(safe_key("/home/me/x"), "homemex");
        assert_eq!(safe_key(""), "draft");
    }

    #[tokio::test]
    async fn a_draft_is_written_and_found_again_after_a_crash() {
        let dir = std::env::temp_dir().join(format!("depesha-drafts-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        // A draft written on a pause, then another: both survive a restart.
        write(&dir, &entry("one", 10)).await.unwrap();
        write(&dir, &entry("two", 20)).await.unwrap();
        let found = read_all(&dir).await.unwrap();
        assert_eq!(found.len(), 2);
        // Oldest first, and the draft itself came back whole.
        assert_eq!(found[0].key, "one");
        assert_eq!(found[0].draft["subject"], "Привет");
        // Writing the same key again replaces the copy, it does not add one.
        write(&dir, &entry("one", 30)).await.unwrap();
        let found = read_all(&dir).await.unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found.iter().find(|d| d.key == "one").unwrap().updated, 30);
        // The draft reached the server: its file goes, the other stays.
        let _ = tokio::fs::remove_file(dir.join(safe_key("one"))).await;
        let found = read_all(&dir).await.unwrap();
        assert_eq!(found.iter().map(|d| d.key.as_str()).collect::<Vec<_>>(), vec!["two"]);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn a_failed_write_leaves_the_previous_copy_whole() {
        let dir = std::env::temp_dir().join(format!("depesha-drafts-atomic-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        write(&dir, &entry("one", 10)).await.unwrap();
        // The temporary file cannot be created (a folder stands in its place): the write fails.
        tokio::fs::create_dir(dir.join("one.tmp")).await.unwrap();
        assert!(write(&dir, &entry("one", 20)).await.is_err());
        // The old copy is whole, not cut.
        let found = read_all(&dir).await.unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].updated, 10);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn a_copy_that_is_already_gone_drops_quietly() {
        let dir = std::env::temp_dir().join(format!("depesha-drafts-gone-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        remove(&dir, "never-written").await.unwrap();
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// A copy left behind would be offered for restore at the next start, and a letter already
    /// sent could go twice: the failure has to reach the page.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_copy_that_cannot_be_removed_is_an_error() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("depesha-drafts-ro-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        write(&dir, &entry("one", 10)).await.unwrap();
        tokio::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555))
            .await
            .unwrap();
        let dropped = remove(&dir, "one").await;
        tokio::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755))
            .await
            .unwrap();
        assert!(dropped.is_err());
        // Still there: nothing was lost by the failed drop.
        assert_eq!(read_all(&dir).await.unwrap().len(), 1);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
