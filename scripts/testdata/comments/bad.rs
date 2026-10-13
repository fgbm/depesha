//! Fixture for scripts/check-comments.sh. Every comment below must be flagged.

/// The user.
pub struct User;

/// The role of the user in the membership.
pub struct Membership;

/// The function returns the number of rows.
fn count_rows() {}

/// The caller opens the file. The caller reads the value. The caller closes the file.
fn load_value() {}

// Now insert the row.
fn third() {}

// A field from the review finding N2.
fn first() {}

// The fix for issue #17.
fn second() {}

// Keeps the fixture honest. // comment-check: allow
fn fourth() {}
