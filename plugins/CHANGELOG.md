# Plugin API changelog

Changes of `@depesha/plugin-api`, the contract plugins live by. The exact surface is `docs/plugin-api.snapshot.d.ts`; CI fails when the API differs from it. After a deliberate change run `npm run plugin-api:update` and add a line here.

## 0.8.12

- `OpenedMessage` has `why_unverified` (#167): why a trusted sender is not confirmed (`server`, `checking`, `unsigned`, `signature`, `unchecked`), `null` when `sender_unverified` is false. `checking` means the app checks the letter's DKIM signature in the background; the open letter is updated when the answer comes. A plugin that only reads the message is unaffected; one that builds it (a test fixture) must give the field.

## 0.8.3

- `ListFilter` has an optional `count` (#182): extra conditions for a count over the list's own scope, so a filter option can show how many letters it would show (e.g. unread newsletters in the open list). The core shows the number beside the option; a plugin that gives none is unaffected.
- `MessageRow` has an optional `snippet` (#177): the beginning of the letter's text, read by the sync for the list's preview and empty when none was read yet. A plugin that only reads rows is unaffected.

## 0.8.2

- `ctx.ui.settingsSection`: the optional `page` (added in 0.8.0, #102, `6b7e440`) is now deprecated and ignored. Every group of a plugin, built-in or not, stands on the «Plugins» page, as before 0.8.0. The type is unchanged, so a plugin that passes `page` still compiles and works; the snapshot is the same.

## 0.8.1

- `Command` has an optional `synonyms` (#153): a function returning words the command palette also matches on, space-separated, so a command is found by a name the interface no longer uses (the old word «Люди» finds «Контакты»).
- `activate` of a plugin is called after the first read of the settings (#158), not on the defaults: a plugin the user switched off is not activated at start (and deactivated a moment later) any more, so it cannot draw anything for that moment. A plugin that is on is activated a little later than before, with its settings already read.
- The built-in plugins `followups` and `snooze` keep the counters of the last run in `localStorage`, so the sidebar rows do not jump after the load (#158, #162). This is temporary and not part of the contract: it stays until a plugin has `ctx.storage` to keep them in, and a third-party plugin must not rely on `localStorage`.
- The types a plugin reads from the backend (`MessageRow`, `MessageView`, `Summary`, `Flags`, `Moved`, `OpenedMessage`, `ComposeDraft`, `FollowupPlan`, `ListQuery`, …) are now generated from the Rust structs (#143) and say what the backend really sends. Fields that were typed optional and are always present are required: `MessageRow.thread_size`, `followup`, `marks`, `my_answer`, `outgoing`, `answer_came`, `dmarc`, `importance`, `thread_voices`; `MessageView.send_at`, `format`, `acts_on`, `markdown`, `views`; `Summary.importance`; `Flags.forwarded`, `answered_all`; `Moved.unseen`; `OpenedMessage.sender_unverified`. A plugin that only reads them is unaffected; one that builds such values (a test fixture) must give them. Added: `Summary.thread_index`, `Summary.dmarc`, `Moved.waits`; `Moved.snoozed` is `Snooze[]` (the whole record, not `{ subject }`); `ListQuery.followup_status` is `FollowupFilter`. `ComposeDraft`, `FollowupPlan` and `ListQuery` keep the shape they had (fields Rust takes missing stay optional); the generated file says it with the Rust types, so the snapshot shows plain object types.
- The components `Popover`, `Select`, `Keys` and `LaterMenu` are typed by their own contract (`PopoverProps`, `SelectProps`, `KeysProps`, `LaterMenuProps`) and not by the core's component. Props that only the core uses (`Popover` `at`, `beside`, `tone`; `Select` `tabindex`; `Keys` `cap`) are no longer part of the API. `Select` is not generic for a plugin: `value` and the `options` are `any`.
- Removed `keyAnchor` and `size`: no plugin used them.
- The «when» menu (`openWhenMenu`, `closeWhenMenu`, `provideWhenMenu`, `whenMenuAvailable`, `whenMenuRequest`) moved from the core's `src/lib` into `src/plugin-api`; its signatures are unchanged. **It is experimental and not part of the v1 contract (#82):** it lends a service from one built-in plugin to another, and it goes when plugins can offer each other services in a way the contract describes.
- First snapshot of the API: `docs/plugin-api.snapshot.d.ts`.
