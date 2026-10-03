# Contributing

Thanks for helping. A few things keep the project healthy.

- **Run the checks.** `scripts/check.sh --fast` must pass before a pull request. Changes to sync, IMAP or SMTP also need `scripts/check.sh`, which brings up GreenMail and Dovecot in Docker and runs the GUI end-to-end test (setup in [e2e/README.md](e2e/README.md)).
- **Test against real behaviour.** A server quirk gets a test that reproduces it: an integration test against GreenMail or Dovecot, or a scripted server like `crates/depesha-core/tests/exchange_smtp.rs`.
- **Keep secrets out.** No real addresses, host names, logs or credentials in code, tests or issues. Use `example.com` and `CONTOSO\user`.
- **User-facing text** is Russian for now and goes through `Error`'s `Display` in the core and the Svelte components.
- **Commits** follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`).

- **Updates.** Changes to `src-tauri/src/updater.rs` or the release workflow need `scripts/test-update.py`: it builds two signed AppImages with a throwaway key and checks that a signed update installs and a tampered one is refused. Local release builds (`npx tauri build`) need `TAURI_SIGNING_PRIVATE_KEY`; without it build with `--config '{"bundle":{"createUpdaterArtifacts":false}}'`.

Server compatibility reports are especially welcome: Exchange, Zimbra, Kerio, Yandex 360, VK WorkMail, Mail.ru.
