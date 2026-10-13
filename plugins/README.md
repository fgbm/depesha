# Plugins

Depesha is built like Obsidian: the core does mail — accounts, sync, the list, the reader, compose, search, the outbox, settings. Everything beyond that is a plugin. Snooze, "Waiting for reply", newsletters, templates, the check before sending, send later and the command palette are plugins too. They are switched on and off on the **Plugins** page of the settings. Open it by the gear at the bottom of the sidebar, `Ctrl+,`, or "Plugins" in the palette.

All plugins live in this repository for now. Once the contract settles, they move to repositories of their own.

## Two kinds

| | Built-in | Community |
| --- | --- | --- |
| Where | `plugins/<id>/` | `plugins/community/<id>/`, or any folder installed from the Plugins page of the settings |
| Language | TypeScript and Svelte, bundled with the app | plain JavaScript, `main.js` up to 512 KB |
| Runs | in the window, trusted | in a Web Worker inside a sandboxed frame (`ext://`), no access to the app or IPC |
| Sees | `@depesha/plugin-api` | the `depesha` object and the data its permissions allow |
| Can add | buttons, menus, banners, list views, list tabs, row labels, compose controls, send checks, settings sections, keys, overlays, attachment formats | banners, commands, send warnings, actions on new mail |

## Built-in plugins

A plugin is a folder with an `index.ts` that exports a `Plugin`, and an entry in `plugins/index.ts`:

```ts
import AlarmClock from "@lucide/svelte/icons/alarm-clock";
import type { Plugin } from "@depesha/plugin-api";

export default {
  manifest: {
    id: "hello",
    name: { en: "Hello", ru: "Привет" },
    description: { en: "Says hello.", ru: "Здоровается." },
  },
  activate(ctx) {
    ctx.ui.command({ id: "hello.say", title: () => ctx.t({ en: "Say hello", ru: "Поздороваться" }), run: () => ctx.toast("Hello") });
    ctx.ui.banner((msg) => (msg.row.flags.flagged ? { icon: AlarmClock, text: "Flagged" } : null));
  },
} satisfies Plugin;
```

Rules:

- **Import only `@depesha/plugin-api`**, `svelte`, `@lucide/svelte/icons/*` and files of your own folder. `src/plugin-api/boundary.test.ts` and the eslint rules `no-restricted-imports` and `no-restricted-syntax` (`import()`) fail on anything else, a neighbouring plugin’s files and `../` included. That is what lets a plugin move out of the repository later. (A plugin’s test may also take the core’s test helpers `src/lib/testing`, `i18n.svelte` and `keymap`, because it tests the plugin together with the core.)
- **The API is a snapshot.** `docs/plugin-api.snapshot.d.ts` lists every export of `@depesha/plugin-api` with its signature and the types it uses. CI fails when the API differs from it; after a deliberate change run `npm run plugin-api:update` and note it in [`CHANGELOG.md`](CHANGELOG.md).
- **Carry your own strings** as `{ en, ru }` objects and translate them with `ctx.t` and `ctx.plural`. The core's dictionaries are not part of the contract.
- **Everything goes through `ctx`.** What a plugin registers with `ctx.ui.*`, the backend events it subscribes to with `ctx.onBackend`, and the function `activate` returns are undone when the plugin is switched off. Nothing has to be cleaned up by hand.
- **Settings are per plugin**: `ctx.settings.get(key, fallback)` and `ctx.settings.set(key, value)` keep a JSON object under the plugin's id in the app settings.
- **Backend services stay in the core.** A plugin calls them with `ctx.backend(command, args)` (the Tauri commands in `src-tauri/src/commands.rs`). Switching a plugin off hides its interface but does not stop the backend: snoozed mail still comes back when the snooze plugin is off.

Plugin points (`ctx.ui`), all in [`src/plugin-api/index.ts`](../src/plugin-api/index.ts):

| Point | What it is |
| --- | --- |
| `command` | a command for the palette and other command lists: `{ id, title, hint?, synonyms?, when?, run }`. `synonyms` is an optional `() => string` of extra words the palette finds the command by besides its title ("people person" for «Contacts»). They count as more words of the title. Community plugins cannot set synonyms yet: a command from the manifest (`contributes.commands`) has no such field. |
| `keybinding` | a command with a key: `{ id, title, key: "h", run, when? }`, listed on Settings → Keys where the user may change the key. Keys are named `Mod+k`, `Shift+r`, `h`, `Delete`; each by its Latin character, so they work on any layout. A key someone took first (the core, the user, an earlier plugin) is not taken from them. The command goes without one and the user is told once. `ctx.keyOf(id)` and `ctx.keyTitle(text, id)` give the key as set now; the `Keys` component shows it with the Russian layout character |
| `readerToolbar`, `bulkToolbar`, `readerHeader` | components in the reader toolbar, in the panel for several selected messages, next to the sender |
| `messageAction` | an item in the reader's "More" menu |
| `rowAction` | an item in the context menu of list rows, or a submenu (`menu`) |
| `banner` | a line above the opened message, with buttons; in a narrow window the first stays and the rest fold into «⋯» (`detailsTitle` folds the details too) |
| `rowTag` | a label in a list row (`alert` red, `good` green, `info` blue), with an optional quiet `note` in the first line |
| `view` | a list of its own with a sidebar entry (shown while `count` or `shown` says so); `tabs` puts a segmented switch over its list |
| `listFilter` | a choice in the list's "View" menu that narrows its query (People / Newsletters); each list keeps its own |
| `composeControl` | a control in the compose window; `slot: "send"` joins it to the Send button, `slot: "line"` makes it a quiet line above the buttons |
| `sendCheck` | warnings before sending |
| `settingsSection` | a group in Settings, marked «plugin», on the «Plugins» page; the old `page` is accepted and ignored |
| `overlay` | a component on top of the window, in the main window and in a window of one message |
| `fileViewer` | a renderer of attachments in the reader: a new format (by `extensions`, `mimes` or `match`), or a better one for a format the core shows (`priority` above 0). The component gets `file` (`ViewedFile`: `bytes()`, `text()`, `openLink()`, `fail()`) besides its `props`; the reader's header, ←/→, Esc, Save and "Open in application" stay the same for every format |

Besides `ctx.ui`:

- **`ctx.people`** is the address book for a plugin that offers people (the palette does, #104). `find(query)` gives who matches by name, address or note, with all their addresses. `open(email)` shows their card in the book of the main window; `allMail(email)` shows every message from any of their addresses.
- **`ctx.mail`** works with the list: `reload()` reloads it at once. `scheduleReload()` is for backend events that come in bursts (a sync, a resolved wait): it waits the burst out and reloads once.
- **`ComposeContext.options`** are what the core sends with the message, set by a compose control. There is `at` (send later, unix seconds); `followupSecs`, a reminder that long after sending when no answer comes (`followupDays` is its older form). `followup` is a `FollowupPlan` with the rest of that wait. It has `deadline_secs`, or `due_at` and `deadline_at` for a reminder and a deadline at a time of the clock. The times are unix seconds and do not move when the message leaves later than planned. It also has `repeat_secs`, `expect` (whose answer counts) and `kind` (the choice’s name). There is also `park`: whether an answer takes the message it answers to the folder "Waiting for reply" (null: as the account’s `waiting` setting says). The message a reply or forward is written from is `draft.acts_on`. Its fields are `account_id`, `message_id`, `folder` and `act` (`reply`, `reply_all` or `forward`, and `waiting` when it waits in the folder already).
- **`FollowupInfo`** is a sent message’s wait as list rows carry it (`row.followup`). It has `status` (`waiting`, `answered`, `closed`), the next reminder `due`, `deadline`, `ended`, `answered_by`, the `answer`’s row id and the times it `reminded` (the latest 20). For a message an answer took to the folder there are `sent` (when the answer went) and `park` (`pending`, `parked`, `back`, `returned`, `done`). Also `park_folder` and `auto_reply`, the latest auto-reply that did not count. A row also carries `marks` (answered, answered to all, forwarded, with the time or `null` for the server’s mark). It also carries `outgoing` (an answer of it in the outbox) and `answer_came` (back from the folder with the reply, not opened since). `FollowupPlan` and `FollowupInfo` are exported from `@depesha/plugin-api`.

## Community plugins

A folder with `manifest.json` and `main.js`. Examples: `community/external-sender` (a banner for mail from outside), `community/reading-time` (a command), `community/mail-rules` (sorting new mail).

```json
{
  "id": "acme.reading-time",
  "name": { "en": "Reading time", "ru": "Время чтения" },
  "description": { "en": "How long the open message takes to read.", "ru": "Сколько времени займёт чтение открытого письма." },
  "version": "1.0.0",
  "permissions": ["messages.read"],
  "hooks": [],
  "contributes": { "commands": [{ "id": "estimate", "title": { "en": "How long to read", "ru": "Сколько читать" }, "message": true }] }
}
```

```js
depesha.on("command", (id, { message }) => {
  const words = (message?.text ?? "").split(/\s+/).filter(Boolean).length;
  return { toast: `${words} words` };
});
```

Permissions: `messages.read` (the text and headers of messages handed to the hooks), `messages.modify` (actions on new mail: `archive`, `read`, `unread`, `flag`, `delete`, `spam`, `move`). Also `storage` (`depesha.storage.get/set`) and `network:<host>` (requests to that host only; enforced by the frame’s CSP).

`network:<host>` names a public internet host by name. A manifest is refused for an IP address in any form a browser reads as one, or `localhost` or a name under it. It is also refused for a name with a trailing dot, or a name in a local or reserved zone. The refused IP forms include `127.0.0.1`, `127.1`, `0x7f.0.0.1` and any address, not only private ones. The reserved zones are `.local`, `.localdomain`, `.internal`, `.intranet`, `.corp`, `.lan`, `.home`, `.private`, `.arpa` (with `.home.arpa`), `.test`, `.invalid`, `.example`, `.onion`, `.alt`. DNS is not checked when a request is made. The rule keeps a plugin from naming the local network, not a public name from pointing there.

`main` is a plain file name in the plugin’s folder: A–Z, a–z, `0`–`9`, `-`, `_` and inner dots, ending in lowercase `.js` (`main.js`, `plugin-1.js`). No path separators, drive prefixes (`C:x.js`), `:`, `..`, spaces or Windows device names (`con.js`, `nul.js`).

Consent. "Install from folder…" first reads the folder without copying anything. It shows the plugin’s name, version, author, description and every permission and hook in words. Nothing is copied or switched on until the user presses Install. Cancel leaves the disk and the settings as they were. A plugin that reads mail and has a network gets a separate warning naming the hosts the text of messages may go to. Installing over a plugin with the same `id` asks again only when the new version wants a permission or hook the old one was not granted. It marks what is new; otherwise it is updated at once. The backend holds to this too. `extension_inspect` reads a folder, and `extension_install` takes the `permissions` and `hooks` the user agreed to. It refuses a folder whose manifest asks for anything else, so a folder changed after it was shown is not installed. What was agreed to is kept beside the installed copy (`granted.json`).

Installed plugins that fail these checks are not loaded; the Plugins page shows them with the reason and lets them be removed. Plugins installed before consent was asked that read mail and have a network stay off until the user reviews their permissions there.

Hooks, each started only when needed: `messageOpen` returns `{ banner: { text, tone, actions } }`; `newMail` returns `{ actions: [{ id, do, folder? }] }`; `beforeSend` returns `{ warnings: [string] }`. A hook has 1.5 s to answer, loading 5 s, a command 15 s. A plugin that takes longer is stopped and restarted, and the Plugins page of the settings counts its timeouts. An endless loop does not slow the window down because it runs in its own worker.
