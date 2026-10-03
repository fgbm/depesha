# Changelog

## Unreleased

- Sender pictures: a colleague's photo from the account's Exchange (`GetUserPhoto`, Exchange 2013 and later), and a company's logo published with BIMI next to mail that passed DMARC. The verdict is taken from the topmost `Authentication-Results`, the one the receiving server added; the domain must enforce DMARC (`p=quarantine` or `reject`), the logo is an HTTPS SVG of at most 32 KB shown as an image. Pictures are cached for a week, missing ones for a day; logos can be switched off in Settings → Message list. Yandex's own sender portraits are not available to other clients.
- Exchange with Windows login (NTLM) no longer answers HTTP 411: the first, empty step of the handshake now carries `Content-Length: 0`, which IIS requires for every POST.
- Archiving, deleting or moving several messages in a row no longer makes them flash back into the list: a message taken out stays out while the server is moving it, even when a sync or the previous action reloads the list meanwhile, and the cursor no longer jumps. It comes back only if the server refuses.
- Mailboxes window (account menu → "Mailboxes…"): the order of mailboxes, their names in the app and their colours, which mark them in the sidebar and as the stripe in shared lists; Alt+↑/↓ in a name moves the mailbox. The sidebar dot shows the mailbox's colour, its connection shows as a ring. A folded mailbox takes one line without a gap under it, and stays folded after a restart.
- A snoozed conversation is one row in "Snoozed" and counts once, as in the folders; plugin views are grouped like folders unless they ask otherwise ("Awaiting reply" lists each letter).
- "z" undoes on Yandex too: the message is found where the action put it by the cache, not by the server's search, which on Yandex sees moved mail only after a delay. An undo that finds nothing says so instead of "Undone"; a snoozed message comes back unread by marking it before the move.
- The `<title>` of an HTML message no longer shows as a line of text above it, and neither `<title>` nor `<style>` leak into previews.

## 0.5.2 — 2026-10-03

Conversations that hold together, a composer that steps aside, offline reading with a background tasks window, context menus for messages and folders, Windows login to Exchange, and a visible response to every click.

- Answers join their conversation even without `References`: a new message takes the conversation of any cached message it names (`References`, `In-Reply-To`) or that names it, so Outlook's answers that carry only `In-Reply-To`, and answers that arrive before their original, no longer start conversations of their own. Exchange's `Thread-Index` counts even when the message has a Message-ID. An answer with no headers at all (phones) joins a letter with the same subject without "Re:"/"Отв:"/"AW:" when each side wrote to the other within 30 days. Conversations found to be one are merged. The cache is linked again once on the first start (`PRAGMA user_version` 1).
- A grouped row counts my answers from Sent, shows the date of the newest letter and moves up when I answer, names who wrote ("Ivan, me, Maria") and marks a started answer with a red "Draft".
- The reader shows the conversation as a column: earlier letters fold into cards above the opened one, later ones below it, the middle of a long conversation into "N more". A quick reply box under the conversation sends with Ctrl+Enter or unfolds into a window; an answer left half-written there folds into a window instead of being lost.
- The compose window no longer blocks the mail: it docks in the bottom right corner, folds into a bar (Esc or "—"), opens full screen, and several can be open at once. Drafts save themselves to the server 3 s after the last change ("Saved at 10:00" in the title bar); `draft_save` returns the saved copy so the next save replaces it, and the new `draft_discard` deletes it. Toasts sit left of the windows, so they no longer cover the Send button.
- SMTP introduces itself in EHLO by the computer's full domain name or, without one, by its address (`EHLO [192.168.1.10]`), as Thunderbird does; never as `localhost`. Windows has no `/etc/hostname`, so every check of an account on sendmail servers failed with "550 5.7.1 Sender unknown", explained as a policy on the message. A refused greeting now has its own error naming the EHLO name.
- Exchange with only Windows login on EWS: NTLMv2 (MS-NLMP) when the server offers NTLM or Negotiate and not Basic, also for Autodiscover. The handshake runs once per connection and again when the server forgets it; the Authenticate message carries a MIC and channel bindings to the server certificate (`tls-server-end-point`), which Exchange with Extended Protection requires. Logins `DOMAIN\user` and `user@domain` both work. Kerberos is still not supported.
- Offline reading: whole messages of the last 30 days (90, a year, all, or off in Settings → Offline) are downloaded in the background after each sync, in batches of 25 so user actions never wait long, with `BODY.PEEK[]` so nothing becomes read. Messages with attachments only when asked; Spam and Trash are skipped. Downloaded mail opens without a network and is found by its text.
- Background tasks: syncing (folder by folder), the offline download, loading older mail, server search and sending are tasks with progress in a new window (the button next to Extensions spins while something runs and gets a red dot on a failure). Each account shows when it last synced and how much of the offline window is downloaded, with "Sync now" and pause for the download. Failed tasks stay with their error until they run again or are dismissed.
- A context menu on list rows: reply, reply all, forward, read/unread, flag, snooze, done, move to a folder, spam, delete, all mail from the sender, with their keys. It acts on the selection it falls in or selects its row. Plugins add items with `ui.rowAction`, also as a submenu (snooze does). A context menu on folders and accounts: open, sync, mark all as read, new folder inside, account settings, background tasks.
- Every click shows that it was heard: opening another message replaces the old one with its header from the list, a progress line and a sketch of the text; after 3 s it says the message is being downloaded, after 15 s that the server is slow, with "Retry". Server work after a click (moves, flags, server search, attachments, a folder's sync) runs a progress line over the list, and an empty list still loading says so instead of "No messages". The principles behind it open `docs/ux.md`.
- Read in "Unread" (or unflagged in "Flagged"), a message stays in the list until you leave it, as in Gmail; before, it vanished and closed as soon as it was opened. `ListQuery.keep_ids` carries them.
- Shortcuts work on any keyboard layout: on the Russian one "о" is "j" and "№" is "#"; plugin keys (`Mod+k`) too.
- The attachment chip shortens a long name with an ellipsis and keeps the size on one line.
- The version is shown quietly next to the app name.
- Releases publish themselves once all four builds succeed; a failed build leaves the draft. The notes are the version's CHANGELOG section (with untagged versions before it) and the commits since the previous tag grouped by type, made by `scripts/release-notes.sh`.

## 0.5.1 — 2026-10-03

Sign-in with Google, Yandex and Microsoft, Exchange over EWS, accounts with names of their own, a new icon, and one look for menus, lists and confirmations.

- Sign in with Google, Yandex and Microsoft (Outlook.com, Microsoft 365): OAuth 2.0 with PKCE in the system browser, the answer comes to `http://127.0.0.1:47851–47853/oauth/callback`. IMAP and SMTP log in with SASL XOAUTH2; the refresh token lives in the keyring, access tokens only in memory and are refreshed before they expire or after the server refuses one. A revoked sign-in pauses the account and the wizard offers "Sign in again".
- OAuth clients are built in from `DEPESHA_*_CLIENT_ID`/`_SECRET` at build time; Settings has "Your own OAuth clients" for builds without them.
- Exchange that publishes only OWA: accounts over Exchange Web Services (`depesha-core::ews`). The address comes from the server field, Autodiscover or OWA host names; login with Basic (or a bearer token). Folders keep IMAP-like names (`INBOX/Работа`), calendars and contacts are hidden; the newest 500 messages first and "Load older" by date; flags, moves, deletion, server search (AQS), snooze, sending with Bcc and the copy in Sent Items made by the server; new mail through streaming notifications, polling when they are not available. NTLM and Kerberos are not supported: Exchange must accept Basic on EWS, and the error says so when it does not.
- `depesha-core::mail` puts IMAP and EWS behind one interface for the worker and the outbox.
- New icon: a wax seal with an open «@» ring spiralling around an old-style serif «Д». Sources in `design/logo/`: `build.mjs` draws the SVGs (the master for 48 px and up, a bolder ring for 24–32 px, the seal and «Д» alone at 16 px; `.icns` keeps the Apple grid margin), `icons.sh` rebuilds `src-tauri/icons` and the sidebar logo from them.
- Autodetect no longer suggests a made-up `smtp.<domain>` (#1): a server with a valid certificate wins over one with an untrusted certificate, the outgoing server is looked for on the incoming host first, `mail.`/`imap.`/`smtp.` names that only exist through a wildcard DNS record are skipped, and host names from autoconfig must resolve.
- The signature field in the account wizard grows from 3 to 8 lines and scrolls after that, so its resize handle no longer slides under the buttons (#2).
- Accounts get a name of their own ("Work", "Personal") shown in the sidebar, the list and the From menu; the sender name recipients see is a separate field. Accounts without one show the address, as before.
- Recipient suggestions ignore case in any alphabet: "иван" finds "Иван". SQLite folds only ASCII, so the store registers its own `fold()`.
- Shortcuts work after a click into the message text: keys pressed inside the message frame are passed on to the app; plain arrows still scroll the message.
- One kind of drop-down everywhere. Menus are placed in window coordinates and open upwards when there is no room below, so the "Send later" menu at the bottom of the compose window is no longer cut off. The account and "Do not disturb" menus in the sidebar use the same menu and close on a click outside and on Escape. System `<select>` lists (From, encryption in the wizard, undo send, follow-up reminder) are replaced by `Select`, a list drawn like the menus with arrow keys; plugins get it from `@depesha/plugin-api`. Moving several messages to a folder is a menu too.
- Confirmations (discard a message, remove an account, connect without encryption, open a link) are the app's own dialog instead of the system message box: Escape cancels, a destructive question focuses "Cancel", and a link's address is shown apart from the question.

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
