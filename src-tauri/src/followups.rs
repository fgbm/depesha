//! Closed waits for an answer are history: forgotten once older than the retention the
//! user set in the "Reminders" plugin's settings.

use std::collections::BTreeMap;

use depesha_core::store::DEFAULT_KEEP_DAYS;

use crate::state::AppState;

/// The setting of the followups plugin: days a closed wait is kept.
const KEEP_KEY: &str = "keep_days";

/// Days to keep closed waits, as the plugin's settings say; the default when they say
/// nothing usable. At least a day: zero would forget an answer the moment it came.
pub fn keep_days(plugin_settings: &BTreeMap<String, serde_json::Value>) -> u32 {
    plugin_settings
        .get("followups")
        .and_then(|s| s.get(KEEP_KEY))
        .and_then(serde_json::Value::as_u64)
        .map_or(DEFAULT_KEEP_DAYS, |d| d.clamp(1, 3650) as u32)
}

/// Forgets the closed waits past the retention, and waiting ones whose letter is gone from
/// the cache for good; whether any went.
pub fn prune(state: &AppState, now: i64) -> depesha_core::Result<bool> {
    let days = keep_days(&state.settings().plugin_settings);
    Ok(state.store.followups_prune(now, days)? > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_retention_comes_from_the_plugin_settings() {
        let with = |v: serde_json::Value| BTreeMap::from([("followups".to_owned(), v)]);
        assert_eq!(keep_days(&BTreeMap::new()), 90);
        assert_eq!(keep_days(&with(json!({ "keep_days": 30 }))), 30);
        assert_eq!(keep_days(&with(json!({ "keep_days": "30" }))), 90, "not a number");
        assert_eq!(keep_days(&with(json!({ "keep_days": 0 }))), 1);
        assert_eq!(keep_days(&with(json!({ "presets": [] }))), 90);
    }
}
