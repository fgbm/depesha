//! `commands.rs` allows `let _ =` for the whole module, because `#[tauri::command]` expands to
//! it in its glue (#152). The allowance must not cover a `let _ =` that is written there: such
//! a line throws a result away unseen; `best_effort` and `unheard` (depesha-core) are the ways.

#![cfg(test)]

#[test]
fn commands_has_no_let_underscore_of_its_own() {
    let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/commands.rs")).expect("commands.rs");
    let found: Vec<(usize, &str)> = source
        .lines()
        .enumerate()
        .map(|(i, line)| (i + 1, line.trim_start()))
        .filter(|(_, line)| line.starts_with("let _ =") || line.starts_with("let _:"))
        .collect();
    assert!(
        found.is_empty(),
        "a `let _ =` in commands.rs hides a failure that the module-wide allow lets through; use `depesha_core::best_effort` or `unheard`: {found:?}"
    );
}
