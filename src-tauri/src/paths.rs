//! Files and folders the backend reads or writes on the interface's word: only the ones
//! the user chose (a dialog, a drop on the window) or the backend handed out itself.
//! A page that runs foreign code still cannot name a file of its own.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use depesha_core::tr;

use crate::error::{CmdError, CmdResult};

/// What a path was chosen for: a file picked to attach is not a place to save into.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Use {
    /// A file to attach: picked, dropped on the window, or made by the backend.
    Attach,
    /// Where one attachment is saved: picked in the save dialog, good for one write.
    SaveFile,
    /// A folder attachments are saved into.
    SaveFolder,
    /// A plugin folder to install from.
    Plugin,
}

#[derive(Default)]
pub struct Paths {
    granted: Mutex<HashSet<(Use, PathBuf)>>,
    /// Test builds only (`e2e` feature): folders whose contents count as chosen,
    /// for a run that cannot click through system dialogs.
    trusted: Vec<PathBuf>,
}

impl Paths {
    pub fn new() -> Self {
        Self {
            granted: Default::default(),
            trusted: trusted_roots(),
        }
    }

    pub fn allow(&self, to: Use, path: PathBuf) {
        self.lock().insert((to, key(&path)));
    }

    /// The path, if the user chose it for this use; a save target is used up by the check.
    pub fn check(&self, to: Use, path: &str) -> CmdResult<PathBuf> {
        let path = PathBuf::from(path);
        let granted = if to == Use::SaveFile {
            self.lock().remove(&(to, key(&path)))
        } else {
            self.lock().contains(&(to, key(&path)))
        };
        if granted || self.trusted.iter().any(|root| within(root, &path)) {
            return Ok(path);
        }
        // The file name only: the folders of a path are personal data.
        let (same_name, same_spelling) = self.lookalikes(to, &path);
        tracing::warn!(
            ?to,
            file = %path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
            same_name,
            same_spelling,
            "a path was refused: it was not chosen for this use"
        );
        Err(not_chosen(to))
    }

    /// For the log of a refusal: how many allowed paths of this use have the same file name,
    /// and whether one of them differs from the asked path only in spelling.
    /// Counts only, the folders of a path are personal data.
    fn lookalikes(&self, to: Use, path: &Path) -> (usize, bool) {
        let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase());
        // Only the spelling folded away: case, `/` for `\`, the `\\?\` prefix.
        let loose = |p: &Path| {
            p.to_string_lossy()
                .replace('/', "\\")
                .replace("\\\\?\\", "")
                .to_lowercase()
        };
        let asked = loose(path);
        let granted = self.lock();
        let mut same_name = 0;
        let mut spelled = false;
        for (_, other) in granted.iter().filter(|(u, _)| *u == to) {
            if other.file_name().map(|n| n.to_string_lossy().to_lowercase()) == name {
                same_name += 1;
                spelled |= loose(other) == asked && other != &key(path);
            }
        }
        (same_name, spelled)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashSet<(Use, PathBuf)>> {
        self.granted.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The form a path is remembered and looked up in: the same file named by the drop event
/// and by the interface gets one key, whatever the system wrote into the path.
fn key(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(windows_key(&path.to_string_lossy()))
    } else {
        path.to_path_buf()
    }
}

/// A Windows path without the spelling differences that name one file: the `\\?\` and
/// `\\?\UNC\` prefixes, `/` for `\`, doubled and trailing separators, letter case
/// (the drive letter too). `..` stays as it is: `check` never trusts a path that climbs.
/// Not `fs::canonicalize`: it adds `\\?\` itself and needs the file to exist.
/// Works on strings, so it is testable on any system.
fn windows_key(path: &str) -> String {
    let path = path.replace('/', "\\");
    let (unc, rest) = if let Some(rest) = path.strip_prefix("\\\\?\\UNC\\") {
        (true, rest)
    } else if let Some(rest) = path.strip_prefix("\\\\?\\") {
        (false, rest)
    } else if let Some(rest) = path.strip_prefix("\\\\") {
        (true, rest)
    } else {
        (false, path.as_str())
    };
    let body = rest
        .split('\\')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\\");
    let body = body.to_lowercase();
    if unc { format!("\\\\{body}") } else { body }
}

#[cfg(feature = "e2e")]
fn trusted_roots() -> Vec<PathBuf> {
    let roots: Vec<PathBuf> = std::env::var_os("DEPESHA_E2E_ROOT")
        .map(|v| std::env::split_paths(&v).filter(|p| p.is_absolute()).collect())
        .unwrap_or_default();
    if !roots.is_empty() {
        tracing::warn!(?roots, "test build: paths under these folders count as chosen");
    }
    roots
}

#[cfg(not(feature = "e2e"))]
fn trusted_roots() -> Vec<PathBuf> {
    Vec::new()
}

/// `path` lies inside `root`, with no `..` to climb back out.
fn within(root: &Path, path: &Path) -> bool {
    path.is_absolute() && !path.components().any(|c| c == Component::ParentDir) && path.starts_with(root)
}

fn not_chosen(to: Use) -> CmdError {
    CmdError::new(
        "not-chosen",
        match to {
            Use::Attach => tr!(
                "this file was not chosen to attach; add it again",
                "этот файл не выбран для вложения; добавьте его ещё раз"
            ),
            Use::SaveFile => tr!(
                "this place was not chosen in the save dialog; save again",
                "это место не выбрано в окне сохранения; сохраните ещё раз"
            ),
            Use::SaveFolder => tr!(
                "this folder was not chosen in a dialog; choose it with “Choose…”",
                "эта папка не выбрана в диалоге; выберите её кнопкой «Выбрать…»"
            ),
            Use::Plugin => tr!(
                "this plugin folder was not chosen in a dialog; choose it again",
                "папка плагина не выбрана в диалоге; выберите её ещё раз"
            ),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn abs(p: &str) -> String {
        if cfg!(windows) {
            format!("C:\\{}", p.replace('/', "\\"))
        } else {
            format!("/{p}")
        }
    }

    #[test]
    fn only_chosen_paths_pass() {
        let paths = Paths::default();
        let doc = abs("home/me/report.pdf");
        assert_eq!(paths.check(Use::Attach, &doc).unwrap_err().kind, "not-chosen");
        paths.allow(Use::Attach, PathBuf::from(&doc));
        assert!(paths.check(Use::Attach, &doc).is_ok());
        // Attaching it again (autosave, sending) keeps working.
        assert!(paths.check(Use::Attach, &doc).is_ok());
        // A file picked to attach is not a folder to save into, nor its neighbour.
        assert!(paths.check(Use::SaveFolder, &doc).is_err());
        assert!(paths.check(Use::Attach, &abs("home/me/.ssh/id_ed25519")).is_err());
        assert!(paths.check(Use::Attach, &abs("home/me/report.pdf/../.bashrc")).is_err());
    }

    #[test]
    fn a_refusal_counts_allowed_paths_of_the_same_name() {
        let paths = Paths::default();
        paths.allow(Use::Attach, PathBuf::from(abs("home/me/report.pdf")));
        paths.allow(Use::Attach, PathBuf::from(abs("home/other/Report.pdf")));
        paths.allow(Use::SaveFile, PathBuf::from(abs("home/me/report.pdf")));
        let asked = PathBuf::from(abs("tmp/report.pdf"));
        assert_eq!(paths.lookalikes(Use::Attach, &asked), (2, false));
        assert_eq!(
            paths.lookalikes(Use::Attach, &PathBuf::from(abs("home/me/notes.pdf"))),
            (0, false)
        );
        assert_eq!(paths.lookalikes(Use::Plugin, &asked), (0, false));
        if !cfg!(windows) {
            // The same path in another case is a different key here: the log tells it apart.
            let cased = PathBuf::from(abs("home/me/REPORT.pdf"));
            assert_eq!(paths.lookalikes(Use::Attach, &cased), (2, true));
        }
    }

    #[test]
    fn windows_spellings_of_one_path_share_a_key() {
        let plain = windows_key(r"C:\Users\Me\Desktop\Report.pdf");
        for same in [
            r"c:\users\me\desktop\report.pdf",
            r"\\?\C:\Users\Me\Desktop\Report.pdf",
            "C:/Users/Me/Desktop/Report.pdf",
            r"C:\Users\\Me\Desktop\Report.pdf",
            r"\\?\c:/Users/Me/Desktop/Report.pdf",
        ] {
            assert_eq!(windows_key(same), plain, "{same}");
        }
        assert_ne!(windows_key(r"C:\Users\Me\Other.pdf"), plain);
        assert_ne!(windows_key(r"D:\Users\Me\Desktop\Report.pdf"), plain);
    }

    #[test]
    fn windows_network_paths_keep_their_two_slashes() {
        let unc = windows_key(r"\\Server\Share\Файл.pdf");
        assert_eq!(unc, r"\\server\share\файл.pdf");
        assert_eq!(windows_key(r"\\?\UNC\Server\Share\Файл.pdf"), unc);
        assert_eq!(windows_key("//Server/Share/Файл.pdf"), unc);
        // Not the same file as a local path of the same words.
        assert_ne!(windows_key(r"C:\Server\Share\Файл.pdf"), unc);
        // `..` is not resolved here, so it cannot turn one file into another.
        assert_ne!(windows_key(r"C:\a\b\..\c.pdf"), windows_key(r"C:\a\c.pdf"));
    }

    /// A real file on a real Windows file system: a spelling of its path other than
    /// the granted one (drive letter, `\\?\` prefix, `/`) is the same file (#79).
    #[cfg(windows)]
    #[test]
    fn a_real_file_is_found_under_another_spelling() {
        let file = std::env::temp_dir().join(format!("depesha-paths-{}.txt", std::process::id()));
        std::fs::write(&file, b"x").unwrap();
        let plain = file.to_string_lossy().into_owned();
        let mut chars = plain.chars();
        let lower_drive = format!("{}{}", chars.next().unwrap().to_ascii_lowercase(), chars.as_str());
        let granted = lower_drive.replace('\\', "/");
        let asked = format!(r"\\?\{}", plain.to_uppercase());

        let paths = Paths::default();
        paths.allow(Use::Attach, PathBuf::from(&granted));
        let found = paths.check(Use::Attach, &asked);
        std::fs::remove_file(&file).unwrap();
        assert!(found.is_ok(), "{asked} was refused after {granted} was chosen");
    }

    #[test]
    fn a_save_target_is_written_once() {
        let paths = Paths::default();
        let target = abs("home/me/Downloads/invoice.pdf");
        paths.allow(Use::SaveFile, PathBuf::from(&target));
        assert!(paths.check(Use::SaveFile, &target).is_ok());
        assert!(paths.check(Use::SaveFile, &target).is_err());
    }

    #[test]
    fn a_trusted_root_covers_only_what_is_inside() {
        let root = PathBuf::from(abs("tmp/e2e"));
        let paths = Paths {
            granted: Default::default(),
            trusted: vec![root],
        };
        assert!(paths.check(Use::SaveFile, &abs("tmp/e2e/report.pdf")).is_ok());
        assert!(paths.check(Use::SaveFile, &abs("tmp/e2e/report.pdf")).is_ok());
        assert!(paths.check(Use::Attach, &abs("tmp/e2e/../etc/passwd")).is_err());
        assert!(paths.check(Use::Attach, &abs("tmp/e2e-other/x")).is_err());
        assert!(paths.check(Use::Attach, "tmp/e2e/relative").is_err());
    }

    #[cfg(not(feature = "e2e"))]
    #[test]
    fn a_release_build_trusts_no_folder() {
        // The variable of a test run means nothing without the `e2e` feature.
        assert!(trusted_roots().is_empty());
    }
}
