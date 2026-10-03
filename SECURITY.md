# Security policy

Depesha handles passwords and renders untrusted HTML, so security reports are taken seriously.

## Reporting

Please report vulnerabilities privately through GitHub's **Security → Report a vulnerability** on this repository rather than in a public issue. Include steps to reproduce, the affected version and, if possible, a sample message or server transcript with credentials removed.

You can expect an acknowledgement within a week. A fix ships in a patch release, and the advisory is published together with it.

## Updates

Releases are built and signed by GitHub Actions in this repository. The update signing key is stored only as an Actions secret and offline with the maintainer; its public half is in `src-tauri/tauri.conf.json` and is compiled into the app. The app installs an update only when its minisign signature matches that key, whatever server the file came from.

If you suspect the key is compromised, report it as a vulnerability: the fix is a release with a new key that every user installs by hand.

## Scope

In scope: escaping the message sandbox (script execution, network requests the user did not allow), credential exposure (files, logs, IPC), TLS verification bypass, and attachment handling that leads to code execution.

Out of scope: problems that need an already compromised machine or user account, and the behaviour of unsigned builds under SmartScreen or Gatekeeper.
