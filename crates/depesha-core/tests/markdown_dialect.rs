//! The Markdown a letter is written in, as the backend reads it: the editor's parser
//! (src/lib/markdown/dialect.ts) is checked against the same examples, so what the
//! editor draws is what the recipient gets.

#![cfg(test)]
#![allow(
    clippy::too_many_lines,
    reason = "a scenario test reads from the first line to the last: its steps are its length"
)]

use depesha_core::message::markdown_html;

/// The elements of the HTML in order of their opening tags; a task's box as `task`.
fn tags(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(i) = rest.find(['<', '☐', '☑']) {
        let after = &rest[i..];
        let ch = after.chars().next().unwrap();
        rest = &after[ch.len_utf8()..];
        match ch {
            '☐' => out.push("task".to_owned()),
            '☑' => out.push("task-done".to_owned()),
            _ => {
                let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
                if !name.is_empty() {
                    out.push(name.to_ascii_lowercase());
                }
            }
        }
    }
    out
}

#[test]
fn the_examples_render_as_the_editor_expects() {
    let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!("markdown_dialect.json")).unwrap();
    let mut wrong = Vec::new();
    for case in &cases {
        let md = case["md"].as_str().unwrap();
        let expected: Vec<String> = case["tags"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t.as_str().unwrap().to_owned())
            .collect();
        let got = tags(&markdown_html(md));
        if got != expected {
            wrong.push(format!("{md:?}: ждали {expected:?}, вышло {got:?}"));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
