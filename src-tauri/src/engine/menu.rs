//! The menu of the right button that WebView2 opens in a field of a letter. Next to the edits it
//! offers the emoji keyboard, the writing direction, an import of passwords and tools of its own —
//! none of which a letter has. The engine lets its host take items out of that menu before it is
//! shown; this is that list. A debug build keeps the whole menu, for the inspector and the reload
//! there are worth more than a short one.

use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
    ICoreWebView2ContextMenuItemCollection, ICoreWebView2ContextMenuRequestedEventArgs,
};
use webview2_com::take_pwstr;
use windows::core::PWSTR;

/// The items a field of a letter is about. A name is the engine's own word for the item, not its
/// label: the labels are translated into the language of Windows, the names are not.
const EDITS: &[&str] = &[
    "cut",
    "copy",
    "paste",
    "pasteAndMatchStyle",
    "selectAll",
    "undo",
    "redo",
    "addToDictionary",
    "addToDictionaryAndIgnore",
];

/// The name the engine gives an item it has none for: one of Chromium's own, newer than this list.
/// It stays, for there is no telling what it is; the suggestions of the spelling are among them.
const NAMELESS: &str = "unknown";

/// The kind and the name of the item at `index`, or nothing when the engine will not say.
fn read(
    items: &ICoreWebView2ContextMenuItemCollection,
    index: u32,
) -> Option<(COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND, String)> {
    // SAFETY: the items belong to the arguments of the event, which live while the handler runs;
    // `take_pwstr` frees the buffer the engine hands over for the name.
    unsafe {
        let item = items.GetValueAtIndex(index).ok()?;
        let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();
        item.Kind(&mut kind).ok()?;
        let mut name = PWSTR::null();
        item.Name(&mut name).ok()?;
        Some((kind, take_pwstr(name)))
    }
}

/// The kinds and the names of every item of the menu, top to bottom.
fn items_of(items: &ICoreWebView2ContextMenuItemCollection) -> Vec<(COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND, String)> {
    let mut count = 0;
    // SAFETY: as in `read`; the count is the engine's own answer for the collection it owns.
    if unsafe { items.Count(&mut count) }.is_err() {
        return Vec::new();
    }
    (0..count).filter_map(|index| read(items, index)).collect()
}

/// Takes the engine's own items out of the menu, leaving the edits, the spelling and their
/// separators.
pub fn edits_only(args: &ICoreWebView2ContextMenuRequestedEventArgs) {
    // SAFETY: the items belong to the arguments of the event, which live while the handler runs.
    let Ok(items) = (unsafe { args.MenuItems() }) else {
        return;
    };
    let all = items_of(&items);
    let mut kept = Vec::new();
    let mut gone = Vec::new();
    // Downwards: a removal shifts every item above it.
    for (index, (kind, name)) in all.iter().enumerate().rev() {
        let ours = *kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR
            || name == NAMELESS
            || EDITS.contains(&name.as_str());
        if ours {
            kept.push(name.clone());
            continue;
        }
        gone.push(name.clone());
        // SAFETY: the index is one of the items counted a line above.
        depesha_core::best_effort("take an item out of the engine's menu", unsafe {
            items.RemoveValueAtIndex(index as u32)
        });
    }
    tracing::debug!("engine menu: kept {} / taken out {}", kept.join(", "), gone.join(", "));
    tidy_separators(&items);
}

/// Drops the separators the removals left: none at either end, and none twice in a row.
fn tidy_separators(items: &ICoreWebView2ContextMenuItemCollection) {
    let all = items_of(items);
    for index in (0..all.len()).rev() {
        let separator = all[index].0 == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR;
        if !separator {
            continue;
        }
        let edge = index == 0 || index + 1 == all.len();
        let double = index + 1 < all.len() && all[index + 1].0 == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR;
        if edge || double {
            // SAFETY: the index is one of the items read a line above.
            depesha_core::best_effort("take a stray separator out of the engine's menu", unsafe {
                items.RemoveValueAtIndex(index as u32)
            });
        }
    }
}
