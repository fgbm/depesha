// The demo stand-in for `@tauri-apps/plugin-dialog`. The demo backend opens its own pickers
// (`pick_files`, `pick_folder`, `pick_save_file` in `src/demo/backend.ts`), so the plugin's
// own entry points answer "nothing picked" rather than opening a browser dialog the app's
// flow would not understand. Aliased in `demo` mode only.

export async function open(): Promise<null> {
  return null;
}

export async function save(): Promise<null> {
  return null;
}

export async function message(): Promise<void> {}

export async function ask(): Promise<boolean> {
  return false;
}

export async function confirm(): Promise<boolean> {
  return false;
}
