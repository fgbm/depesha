<p align="center"><img src="src-tauri/icons/128x128.png" width="96" alt=""></p>

<h1 align="center">Depesha</h1>

<p align="center">A fast, private desktop mail client for any IMAP/SMTP server — built for Exchange 2019 as much as for Gmail.<br>Rust · Tauri 2 · Svelte 5. <a href="README.ru.md">Читать по-русски</a>.</p>

<p align="center"><img src="docs/screenshots/main.png" width="860" alt="Depesha main window"></p>

> The interface is in Russian for now; English is on the roadmap.

## Why

Webmail you have to host (PHP, a database, a web server) is a lot of moving parts for reading mail. Desktop clients either drag decades of baggage or quietly assume Gmail. Depesha is a single native app that speaks plain IMAP and SMTP and behaves well with corporate Exchange: Russian folder names, non-mail folders, rate limits, internal certificates and all.

## Features

- **Any server.** Multiple accounts, unified inbox, folders with non-ASCII names. Exchange calendars, contacts and tasks are hidden.
- **Finds your settings.** Known providers, Mozilla autoconfig, MX (Yandex 360, VK WorkMail, Google Workspace), SRV records, then probing `mail.` / `imap.` / `smtp.` with TLS checks.
- **Live.** New mail arrives by IMAP IDLE. Reconnects after network loss, server restarts and sleep.
- **Big mailboxes.** The newest 500 messages show up in under a second; older ones load as you scroll. Server-side search finds what is not cached yet.
- **Offline reading and search.** Opened messages are cached in SQLite with full-text search (FTS5) that understands Russian.
- **Reliable sending.** An outbox retries transient failures (no network, Exchange's 5-messages-per-minute limit, SMTP 4xx). A copy goes to Sent exactly once. Closing the composer saves a draft on the server.
- **Everyday tools.** Reply, reply all, forward with attachments, signatures, address completion, bulk actions, keyboard shortcuts (`j`/`k`, `r`, `a`, `f`, `c`, `/`, `Delete`).

<p align="center"><img src="docs/screenshots/compose.png" width="420" alt=""> <img src="docs/screenshots/certificate.png" width="420" alt=""></p>

## Security

- Passwords live only in the OS keyring (Secret Service, Keychain, Credential Manager). They never touch files or logs.
- After a rejected login the account pauses instead of retrying, so a wrong password cannot lock out an Active Directory account.
- Certificates are verified against the system trust store. A self-signed or internal certificate is accepted only when you explicitly trust its SHA-256 fingerprint, and you are asked again if it changes.
- No password is sent over a connection without TLS. Plaintext connections need an explicit opt-in with a warning.
- Message HTML is sanitized (`ammonia`) and rendered in a script-less sandboxed iframe. Remote images and tracking pixels are blocked by default. Links open only after a confirmation that shows the real address, and executable attachments are never opened.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Install

Grab a build from [Releases](../../releases): `.deb`, `.rpm` and AppImage for Linux, `.msi` for Windows, `.dmg` for macOS. Builds are not code-signed yet, so Windows SmartScreen and macOS Gatekeeper will warn on first launch.

On Linux you need a Secret Service provider (GNOME Keyring, KWallet or KeePassXC), which most desktops already run.

## Tested against

| Server | How |
| --- | --- |
| Dovecot 2.4 | integration tests: STARTTLS, MOVE, fallbacks without MOVE/UIDPLUS, IDLE, Russian server search |
| GreenMail | integration tests and a 31-step end-to-end GUI run |
| Exchange 2019 (behaviour) | a scripted SMTP server with Exchange replies; Russian Exchange folder layout |
| 50 000-message mailbox | first sync 0.4 s, re-sync 0.4 s, full header load 17 s, search 3–7 ms |

Validation against a live Exchange 2019 mailbox is still pending. If you run one, an issue with your results is very welcome.

## Build from source

```
npm install
npx tauri dev          # development
npx tauri build        # packages in target/release/bundle/
```

Linux build dependencies:

```
sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev build-essential
```

## Architecture

- `crates/depesha-core` — the engine, no GUI. IMAP (`async-imap`); its own SMTP client (EHLO, STARTTLS, AUTH PLAIN/LOGIN, SIZE, Exchange status codes); SQLite cache with FTS5; MIME parsing (`mail-parser`); TLS (`rustls`, platform verifier, fingerprint pinning); settings discovery.
- `src-tauri` — the app. Each account runs two IMAP connections (operations and IDLE), and an outbox task sends mail.
- `src` — the Svelte 5 interface.

## Development

```
scripts/check.sh --fast   # rustfmt, clippy, svelte-check, vitest, unit tests
scripts/check.sh          # plus GreenMail/Dovecot integration and the GUI end-to-end run
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [e2e/README.md](e2e/README.md).

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
