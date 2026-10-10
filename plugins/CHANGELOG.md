# Plugin API changelog

Changes of `@depesha/plugin-api`, the contract plugins live by. The exact surface is `docs/plugin-api.snapshot.d.ts`; CI fails when the API differs from it. After a deliberate change run `npm run plugin-api:update` and add a line here.

## Unreleased

- The components `Popover`, `Select`, `Keys` and `LaterMenu` are typed by their own contract (`PopoverProps`, `SelectProps`, `KeysProps`, `LaterMenuProps`) and not by the core's component. Props that only the core uses (`Popover` `at`, `beside`, `tone`; `Select` `tabindex`; `Keys` `cap`) are no longer part of the API.
- Removed `keyAnchor` and `size`: no plugin used them.
- The «when» menu (`openWhenMenu`, `closeWhenMenu`, `provideWhenMenu`, `whenMenuAvailable`, `whenMenuRequest`) moved from the core's `src/lib` into `src/plugin-api`; its signatures are unchanged.
- First snapshot of the API: `docs/plugin-api.snapshot.d.ts`.
