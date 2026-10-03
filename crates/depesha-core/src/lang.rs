//! Language of user-facing text from the core: English or Russian. Errors are worded
//! when displayed, so switching the language applies to the next message at once.

use std::cell::Cell;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    En,
    Ru,
}

static RU: AtomicBool = AtomicBool::new(false);

thread_local! {
    /// Tests run in parallel threads of one process: each can pin its own language.
    static PINNED: Cell<Option<Lang>> = const { Cell::new(None) };
}

pub fn set(lang: Lang) {
    RU.store(lang == Lang::Ru, Ordering::Relaxed);
}

pub fn current() -> Lang {
    PINNED
        .with(Cell::get)
        .unwrap_or(if RU.load(Ordering::Relaxed) { Lang::Ru } else { Lang::En })
}

pub fn is_ru() -> bool {
    current() == Lang::Ru
}

/// Pins the language for the current thread (tests).
pub fn pin(lang: Lang) {
    PINNED.with(|p| p.set(Some(lang)));
}

/// `ru`, `ru_RU.UTF-8`, `ru-RU` → Russian; anything else → English.
pub fn from_locale(tag: &str) -> Lang {
    if tag.trim().to_ascii_lowercase().starts_with("ru") {
        Lang::Ru
    } else {
        Lang::En
    }
}

/// One of two fixed strings.
pub fn pick(en: &'static str, ru: &'static str) -> &'static str {
    if is_ru() { ru } else { en }
}

/// `tr!("English {x}", "Русский {x}")`: a formatted string in the current language.
#[macro_export]
macro_rules! tr {
    ($en:literal, $ru:literal $(,)?) => {
        if $crate::lang::is_ru() { format!($ru) } else { format!($en) }
    };
    ($en:literal, $ru:literal, $($arg:tt)*) => {
        if $crate::lang::is_ru() { format!($ru, $($arg)*) } else { format!($en, $($arg)*) }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_tags() {
        assert_eq!(from_locale("ru_RU.UTF-8"), Lang::Ru);
        assert_eq!(from_locale("ru-RU"), Lang::Ru);
        assert_eq!(from_locale("en-US"), Lang::En);
        assert_eq!(from_locale("uk-UA"), Lang::En);
        assert_eq!(from_locale(""), Lang::En);
    }

    #[test]
    fn pinned_per_thread() {
        pin(Lang::Ru);
        let n = 3;
        assert_eq!(tr!("{n} messages", "писем: {n}"), "писем: 3");
        std::thread::spawn(|| {
            pin(Lang::En);
            assert_eq!(pick("hi", "привет"), "hi");
        })
        .join()
        .unwrap();
        assert_eq!(pick("hi", "привет"), "привет");
    }
}
