# Plugins

Depesha is built like Obsidian: the core does mail — accounts, sync, the list, the reader, compose, search, the outbox, settings — and everything beyond that is a plugin. Snooze, "Waiting for reply", newsletters, templates, the check before sending, send later and the command palette are plugins too, switched on and off in **Plugins** (the puzzle button at the bottom of the sidebar, or "Plugins" in the palette).

All plugins live in this repository for now. Once the contract settles, they move to repositories of their own.

## Two kinds

| | Built-in | Community |
| --- | --- | --- |
| Where | `plugins/<id>/` | `plugins/community/<id>/`, or any folder installed from the Plugins window |
| Language | TypeScript and Svelte, bundled with the app | plain JavaScript, `main.js` up to 512 KB |
| Runs | in the window, trusted | in a Web Worker inside a sandboxed frame (`ext://`), no access to the app or IPC |
| Sees | `@depesha/plugin-api` | the `depesha` object and the data its permissions allow |
| Can add | buttons, menus, banners, list views, list tabs, row tags, compose controls, send checks, settings sections, keys, overlays | banners, commands, send warnings, actions on new mail |

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

- **Import only `@depesha/plugin-api`**, `svelte`, `@lucide/svelte/icons/*` and files of your own folder. `src/plugin-api/boundary.test.ts` fails on anything else: that is what lets a plugin move out of the repository later.
- **Carry your own strings** as `{ en, ru }` objects and translate them with `ctx.t` and `ctx.plural`. The core's dictionaries are not part of the contract.
- **Everything goes through `ctx`.** What a plugin registers with `ctx.ui.*`, the backend events it subscribes to with `ctx.onBackend`, and the function `activate` returns are undone when the plugin is switched off; nothing has to be cleaned up by hand.
- **Settings are per plugin**: `ctx.settings.get(key, fallback)` and `ctx.settings.set(key, value)` keep a JSON object under the plugin's id in the app settings.
- **Backend services stay in the core.** A plugin calls them with `ctx.backend(command, args)` (the Tauri commands in `src-tauri/src/commands.rs`). Switching a plugin off hides its interface but does not stop the backend: snoozed mail still comes back when the snooze plugin is off.

Extension points (`ctx.ui`), all in [`src/plugin-api/index.ts`](../src/plugin-api/index.ts):

| Point | What it is |
| --- | --- |
| `command` | a command for the palette and other command lists |
| `keybinding` | a key (`h`, `Mod+k`), with an optional condition |
| `readerToolbar`, `bulkToolbar`, `readerHeader` | components in the reader toolbar, in the panel for several selected messages, next to the sender |
| `messageAction` | an item in the reader's "More" menu |
| `banner` | a line above the opened message, with buttons |
| `rowTag` | a tag in a list row |
| `view` | a list of its own with a sidebar entry |
| `listTabs` | tabs above the inbox that narrow its query |
| `composeControl` | a control in the compose window; `slot: "send"` joins it to the Send button |
| `sendCheck` | warnings before sending |
| `settingsSection` | a section in Settings |
| `overlay` | a component on top of the window |

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

Permissions: `messages.read` (the text and headers of messages handed to the hooks), `messages.modify` (actions on new mail: `archive`, `read`, `unread`, `flag`, `delete`, `spam`, `move`), `storage` (`depesha.storage.get/set`), `network:<host>` (requests to that host only; enforced by the frame's CSP).

Hooks, each started only when needed: `messageOpen` returns `{ banner: { text, tone, actions } }`; `newMail` returns `{ actions: [{ id, do, folder? }] }`; `beforeSend` returns `{ warnings: [string] }`. A hook has 1.5 s to answer, loading 5 s, a command 15 s. A plugin that takes longer is stopped and restarted, and the Plugins window counts its timeouts; an endless loop does not slow the window down because it runs on its own thread.
