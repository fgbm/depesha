# Changelog

## Unreleased

- Sign in with Google, Yandex and Microsoft (Outlook.com, Microsoft 365): OAuth 2.0 with PKCE in the system browser, the answer comes to `http://127.0.0.1:47851–47853/oauth/callback`. IMAP and SMTP log in with SASL XOAUTH2; the refresh token lives in the keyring, access tokens only in memory and are refreshed before they expire or after the server refuses one. A revoked sign-in pauses the account and the wizard offers "Sign in again".
- OAuth clients are built in from `DEPESHA_*_CLIENT_ID`/`_SECRET` at build time; Settings has "Your own OAuth clients" for builds without them.
- Exchange that publishes only OWA: accounts over Exchange Web Services (`depesha-core::ews`). The address comes from the server field, Autodiscover or OWA host names; login with Basic (or a bearer token). Folders keep IMAP-like names (`INBOX/Работа`), calendars and contacts are hidden; the newest 500 messages first and "Load older" by date; flags, moves, deletion, server search (AQS), snooze, sending with Bcc and the copy in Sent Items made by the server; new mail through streaming notifications, polling when they are not available. NTLM and Kerberos are not supported: Exchange must accept Basic on EWS, and the error says so when it does not.
- `depesha-core::mail` puts IMAP and EWS behind one interface for the worker and the outbox.
- New icon: the tile is the back of an envelope with a dark flap and a wax seal with «Д». Sources in `design/logo/`: `build.mjs` draws the SVGs (the master for 48 px and up, simplified versions for 24–32 and 16 px; only `.icns` keeps the Apple grid margin), `icons.sh` rebuilds `src-tauri/icons` and the sidebar logo from them.
- Autodetect no longer suggests a made-up `smtp.<domain>` (#1): a server with a valid certificate wins over one with an untrusted certificate, the outgoing server is looked for on the incoming host first, `mail.`/`imap.`/`smtp.` names that only exist through a wildcard DNS record are skipped, and host names from autoconfig must resolve.
- The signature field in the account wizard grows from 3 to 8 lines and scrolls after that, so its resize handle no longer slides under the buttons (#2).
- Accounts get a name of their own ("Work", "Personal") shown in the sidebar, the list and the From menu; the sender name recipients see is a separate field. Accounts without one show the address, as before.
- Recipient suggestions ignore case in any alphabet: "иван" finds "Иван". SQLite folds only ASCII, so the store registers its own `fold()`.
- Shortcuts work after a click into the message text: keys pressed inside the message frame are passed on to the app; plain arrows still scroll the message.

## 0.5.0 — 2026-10-03

Plugins, the way Obsidian does it: the core does mail, everything else is a plugin.

- The core: accounts, sync, the list and conversations, the reader, compose, search, the outbox, settings.
- Built-in plugins, each in its own folder under `plugins/` and switched on and off in the new Plugins window: command palette, snooze, waiting for reply, people and newsletters, send later, reply templates, check before sending. A plugin that is off takes its buttons, keys, sidebar entries, list tabs and checks with it; the backend keeps working, so snoozed mail still returns.
- `@depesha/plugin-api`: the one contract built-in plugins import; `src/plugin-api/boundary.test.ts` fails on any other import from the app.
- Community plugins: `manifest.json` with permissions (`messages.read`, `messages.modify`, `storage`, `network:<host>`) and hooks (`messageOpen`, `newMail`, `beforeSend`), plus commands. Each runs in a Web Worker inside a sandboxed `ext://` frame with its own CSP, starts when first needed and is stopped after a timeout; the Plugins window shows its run time, calls, errors and timeouts. Examples in `plugins/community`.
- Settings: `disabled_plugins` and per-plugin `plugin_settings`; reply templates move there from the old `templates` field on first start.
- Toasts stay under dialogs and no longer cover their buttons.
- The end-to-end run grows to 45 steps: switching a plugin off, banners and commands of community plugins, a mail rule, six escape attempts from the sandbox, a plugin stuck in an endless loop.

## 0.4.0 — 2026-10-03

- English and Russian. The language follows the system locale (`LANGUAGE`, `LC_ALL`, `LC_MESSAGES`, `LANG`; Russian for `ru*`, English otherwise) and can be set in Settings; switching applies at once, without a restart.
- Translated: the interface, error messages from the mail engine, notifications, date formats, plural forms, reply and forward headers, the names of folders Depesha creates (Archive, Spam, Snoozed). Replies quote in the interface language; quotes and reply prefixes in either language are recognised.

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
