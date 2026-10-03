# Changelog

## 0.1.0 — 2026-10-03

First public release.

- Multiple IMAP/SMTP accounts, unified inbox, folders with modified UTF-7 names. Non-mail Exchange folders are hidden.
- Settings discovery: known providers, autoconfig, MX, SRV, probing.
- IMAP IDLE with reconnects after network loss, server restarts and sleep. Pauses after rejected logins to avoid AD lockouts.
- Local cache in SQLite with Russian full-text search; server-side search for uncached mail; newest-first sync for large mailboxes.
- Outbox with retries for transient SMTP errors, including Exchange rate limits. Sent copy without duplicates; drafts saved on the server.
- Sanitized HTML in a sandboxed iframe, remote content blocked by default, trusted senders, safe attachment handling.
- Certificate fingerprint pinning, STARTTLS enforcement, OS keyring for passwords.
- Reply, reply all, forward with attachments, signatures, address completion, bulk actions, keyboard shortcuts, resizable panes.
- Packages: `.deb`, `.rpm`, AppImage, `.msi`, `.dmg`.
