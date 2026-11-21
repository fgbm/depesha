# Plugin contract v1: the boundary

This page tells where the plugin contract ends and what happens at that edge. It covers the version, the manifest, the limits with the result of each violation, and what an error of a plugin leaves behind. The how-to is [`README.md`](README.md), and the history is [`CHANGELOG.md`](CHANGELOG.md). Every statement here describes the code as it is. Where the code does not hold a rule of the contract, the difference is in [Known gaps](#known-gaps).

There are two kinds of plugin with two contracts. A **built-in plugin** is TypeScript in `plugins/<id>/`. The types are `@depesha/plugin-api` (`src/plugin-api/index.ts`), and the host in `src/plugin-host/` runs it. A **community plugin** is a folder with `manifest.json` and a script. The backend checks and serves it (`src-tauri/src/extensions.rs`), and the window runs it in a sandbox (`src/lib/extensions.svelte.ts`).

## Version

- **There is no API version number.** Neither manifest has a field for it. A plugin cannot tell which version of the contract it targets.
- **The contract of the built-in plugins is the snapshot** `docs/plugin-api.snapshot.d.ts`. It lists every export of `@depesha/plugin-api` with its signature and its types, and the major version of Svelte. `node scripts/plugin-api-snapshot.mjs` fails in CI and in `scripts/check.sh` on any difference.
- **A change of the contract** is a deliberate update of the snapshot (`npm run plugin-api:update`) and a section in `plugins/CHANGELOG.md`. The section goes under the app version that brings the change.
- **The snapshot compares declarations only.** A change of meaning that keeps a signature does not fail it. The changelog tells such a change.
- **Not part of v1**: exports marked `@experimental` in `src/plugin-api/index.ts`. Today this is the menu of `whenMenu.svelte.ts`.
- **The `version` of a community plugin** is free text. The consent dialog shows it, and the grant keeps it. Nothing compares it, so the app installs an older version too.

## Manifest

### Built-in plugins

The manifest is the type `PluginManifest`. The host does not check it at run time. The list in `plugins/index.ts` gives the plugins and the order in which they start.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | yes | The name of the plugin in the settings, the registry and its own settings |
| `name` | `{ en, ru }` | yes | The Plugins page shows it |
| `description` | `{ en, ru }` | yes | The Plugins page shows it |
| `defaultOff` | boolean | no | Off until the user switches it on |

### Community plugins

The backend reads `manifest.json` (`Manifest` in `extensions.rs`). It checks the manifest on inspect, on install and on each load (`validate`). It ignores unknown fields.

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `id` | string | yes | 1–64 characters of `a-z`, `0-9`, `.` and `-`. Not `.` at the start, no `..` |
| `name` | `{ en, ru? }` | yes | `en` is not empty. `ru` is optional |
| `description` | `{ en, ru? }` | no | — |
| `version` | string | yes | Free text |
| `author` | string | no | — |
| `main` | string | no, `main.js` | A plain file name that ends in `.js`, 64 characters or fewer. No path, no dot at the start or end, no Windows device name |
| `permissions` | string[] | no | Each is `messages.read`, `messages.modify`, `storage`, or `network:<host>` for a public host |
| `hooks` | string[] | no | Each is `messageOpen`, `newMail` or `beforeSend`. Each hook needs `messages.read` |
| `contributes.commands` | `{ id, title, message? }[]` | no | `id` follows the rule of the plugin `id`, and `title.en` is not empty. `message: true` needs `messages.read` |

The app keeps the copy under its `id`, whatever the name of the source folder.

## Permissions and consent

- **Built-in plugins have no permissions.** They are trusted code of the app. `ctx.backend` calls each backend command that the window can call.
- **A community plugin gets the permissions of its manifest after the user agrees to them.** The grant holds its permissions and hooks. The app saves it as `granted.json` next to the copy.
- **The app refuses to install a copy whose manifest asks for other permissions than the grant.** It does not serve a copy without consent.
- **An update that asks for nothing new** installs without a question. Anything new opens the consent dialog. The dialog marks what is new, and it gives a separate warning when mail can go to a host.
- **A copy from before consent existed** has no `granted.json`. It counts as consented, unless it reads mail and also has a network host. Such a copy waits for a review on the Plugins page.
- **Where the app enforces each permission**:
  - `messages.read`: the manifest check. Each hook and each command with `message: true` needs it.
  - `messages.modify`: when `newMail` runs, the app skips a plugin without it.
  - `storage`: the RPC of the host between the sandbox and the app. A community plugin has no other way to the backend.
  - `network:<host>`: the Content Security Policy of the frame. `connect-src` allows only the listed hosts, and it is `'none'` without hosts. The frame has a sandbox without the same origin, and the script runs in a Web Worker in it.

## Limits

### Community plugins

| Limit | Value | Result of a violation |
| --- | --- | --- |
| Script size | 512 KB | The app refuses inspect and install. The list shows an installed copy with the problem, and the copy stays off |
| Storage | 1 MB per plugin, serialized | The app refuses the write and stores nothing. `storage.set` of the plugin rejects |
| Storage file that the app cannot read | — | The app reads it as empty. The next write replaces it |
| `id`, command `id`, `main` | See [Manifest](#community-plugins) | The app refuses inspect and install. The list shows an installed copy with the problem, and the copy stays off |
| Network host | Public internet only: two labels or more, no IP address, no internal zone, 253 characters or fewer | The app refuses inspect and install |
| Start | 5 s | The app stops the run and counts a timeout. The run starts again on the next call |
| Hook | 1.5 s | The app drops the answer, restarts the run and counts a timeout. The app continues without the answer |
| Command | 15 s | The app restarts the run and counts a timeout. An error toast names the plugin |
| Text of a message or a draft that the plugin gets | 200 000 characters | The app cuts it |
| Toast | 300 characters | The app cuts it and shows the name of the plugin first |
| Banner | 500 characters, 3 actions or fewer, action titles of 40 characters, tone `info` or `warn` | The app cuts the text and the titles and drops extra actions. Another tone becomes `info`. The app drops a banner without text |
| Send warnings | 5 per plugin, 300 characters each | The app cuts them |
| Actions on new mail | Only messages of that batch. `archive`, `read`, `unread`, `flag`, `delete`, `spam`, `move` | The app drops other actions. If an action fails, an error toast names the plugin, and the other actions continue |
| Data across the sandbox | Plain JSON | The copy loses all other data |

The app counts calls, errors, timeouts, the last error and the start time per window. The Plugins page shows them.

### Built-in plugins

| Point | Rule | Result of a violation |
| --- | --- | --- |
| `ctx.people.find` | 6 contacts or fewer | The app cuts the list |
| `ctx.backend("counters")` | Calls within 300 ms share one request | — |
| `ctx.ui.rowTag` | One label per row: the first | The app does not show the others |
| `ctx.ui.listFilter` | One filter: the first registered. None in Sent and Drafts | The app does not use the others |
| `ctx.ui.fileViewer` | The highest priority wins. The app never shows dangerous file types | The app does not use that reader |
| `onAction` of a compose control | One owner per action | The app refuses the second owner with a console warning |
| `ctx.ui.keybinding` | A default key that is in use stays unassigned. `Mod+k` belongs to the palette | The user sees the key as lost until they dismiss the notice |
| `ctx.settings` | No size limit | If a save fails, the app shows an error toast |

## Errors of a plugin

### Built-in plugins

- **`activate` throws**: the error goes to the console. The disposers registered so far run, and the app removes all items that the plugin registered with `ctx.ui.*`.
- **After a failed `activate`**, the app shows no toast, and the plugin stays on in the settings. The host starts it again when the user next switches a plugin on or off.
- **A disposer throws**: the error goes to the console, and the other disposers still run.
- **Contained errors** lose only the item of that plugin. This applies to banners, row labels and send checks, where the other checks run. It also applies to `when` of a row action or a message action: the app hides the item.
- **Errors that are not contained** reach the code that called the plugin. This applies to `when` of a command or a key, and to `run` of a command from the palette.
- **Also not contained**: `count`, `shown`, `title` and `query` of a view, and `query` and `options` of a list filter. The components that a plugin adds have no error boundary.
- **What stays after the user switches a plugin off**: its settings (`ctx.settings`) and its data in `localStorage`. The interface goes, but backend services continue (see [`README.md`](README.md)).

### Community plugins

- **A handler throws or the worker fails**: the app counts the error, and the Plugins page shows it as the last error.
- **A hook fails or times out**: the app continues without its answer. A failed `beforeSend` does not stop the message.
- **A command fails**: an error toast names the plugin.
- **The app never switches a plugin off because of its errors or timeouts.**
- **To remove a plugin** deletes its folder and its storage.

## Known gaps

These are places where the code does not hold a rule of the contract. Each is a candidate for an issue. Until a fix comes, a plugin must not rely on the rule.

1. **"Nothing has to be cleaned up by hand" is true only while the plugin is on.** `ctx.ui.*` and `ctx.onBackend` do not check that the plugin is still active (`context` in `src/plugin-host/host.svelte.ts`). If an async callback registers an item after the switch-off, the item stays. Such a backend subscription stays too. The host does not track the timers and promises of a plugin.
2. **The app does not contain an error in `when`, `run`, a view or a list filter** (see [Errors of a plugin](#built-in-plugins-2)). One plugin can break the palette, the keys or the message list.
3. **A plugin that fails in `activate` stays on.** It starts again when the user next switches a plugin on or off, and the user sees nothing.
4. **A community banner stays after its plugin goes off.** It stays on the open message until the reader shows another message. Its actions then do nothing.
5. **`newMail` without `messages.modify` passes the manifest check**, but the app never calls it.
6. **There is no API version.** A plugin for an old contract fails at run time, and the app does not refuse it at install.
