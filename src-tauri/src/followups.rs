//! Closed waits for an answer are history: forgotten once older than the retention the
//! user set in the "Reminders" plugin's settings.

use crate::state::AppState;

/// Forgets the closed waits past the retention, and waiting ones whose letter is gone from
/// the cache for good; whether any went.
pub fn prune(state: &AppState, now: i64) -> depesha_core::Result<bool> {
    let days = depesha_core::waiting::keep_days(&state.settings().plugin_settings);
    Ok(state.store.followups_prune(now, days)? > 0)
}
