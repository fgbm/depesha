# Changelog

## 0.3.0 — 2026-10-03

- Self-updating, modelled on OpenCode's `autoupdate`: `auto` (default), `notify` or `off` in Settings; a check at start and every six hours, "Check now" in Settings.
- AppImage and macOS update in the background and offer a restart; Windows downloads in the background and installs on restart or exit; deb and rpm notify and install on click (pkexec).
- Updates are signed in the release workflow and verified against the public key built into the app; a tampered update is refused (`scripts/test-update.py`).

## 0.2.0 — 2026-10-03

Mail as people actually use it; the research and the choices are in `docs/ux.md`.

- Triage: "Done" (`e`) archives, the archive folder is created when missing; spam (`!`); the next message opens by itself; undo (`z`) for every move.
- Snooze (`h`): presets and any time; snoozed mail waits in a server folder and returns unread.
- Waiting for reply: a reminder chosen when sending, cleared automatically by the answer.
- Undo send (10 s by default, configurable) and scheduled sending.
- Check before sending: missing attachment, colleagues and outsiders together, more than 10 recipients, no subject.
- Conversations: one row per thread, the whole conversation above the opened message.
- People and lists apart (`List-Id`, `List-Unsubscribe`, `Precedence`, `Auto-Submitted`); unsubscribe by RFC 8058 one-click, by mail or via the sender's page.
- Notifications only for mail from people; Do Not Disturb.
- Search operators with Russian synonyms, on the local cache and on the server; "all mail from this sender".
- Command palette (`Ctrl+K`), templates, settings window.
- Vector icons, coloured avatars, account stripes in the unified inbox; the dark theme checked on screen.
- Fixes: a message opened late no longer overrides a flag the user set meanwhile; "z" undoes the latest action, waiting for it if it is still running.

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
