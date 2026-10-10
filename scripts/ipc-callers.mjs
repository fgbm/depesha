// Guard against dead IPC commands (#148): every command registered in `generate_handler!` has a
// caller in the interface (`src/`), a built-in plugin (`plugins/`) or the e2e harness (`e2e/`).
// A call is `invoke(`, `call(` or `backend(` with the name as the first string argument, in a file that
// is not a unit test. A command only e2e calls must stand behind `#[cfg(feature = "e2e")]`. An exception goes in EXCEPTIONS with a reason.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const HANDLER = "src-tauri/src/lib.rs";

/** Commands with no caller in the places above. Empty today; add `name: "why it stays"`. */
export const EXCEPTIONS = {};

/** Commands in the `generate_handler![ ... ]` list: `{ name, e2e }`, `e2e` for those behind `#[cfg(feature = "e2e")]`. */
export function handlerCommands(source) {
  const list = source.split("generate_handler![")[1]?.split("])")[0];
  if (list === undefined) throw new Error("generate_handler![...] not found");
  const bare = list.replace(/\/\/.*$/gm, "");
  return [...bare.matchAll(/((?:#\[[^\]]*\]\s*)*)(?:[A-Za-z_][A-Za-z0-9_]*::)+([A-Za-z0-9_]+)/g)].map((m) => ({
    name: m[2],
    e2e: /feature\s*=\s*"e2e"/.test(m[1]),
  }));
}

/** The names in build.rs `COMMANDS`. */
export function manifestCommands(source) {
  const list = source.split("COMMANDS: &[&str] = &[")[1]?.split("];")[0];
  if (list === undefined) throw new Error("COMMANDS in build.rs not found");
  return [...list.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(ts|js|mjs|svelte)$/.test(name) && !/\.test\./.test(name)) yield path;
  }
}

const STR = (c) => `["'\`]${c}["'\`]`;

/** A call: `invoke(`, `call(`, `backend(` (also `ctx.backend(`), a generic allowed, the name first. */
function calledIn(command, text) {
  return new RegExp(`\\b(?:invoke|call|backend)\\s*(?:<[^()]*>)?\\s*\\(\\s*${STR(command)}`).test(text);
}

/** The e2e harness's own helper: `invoke(driver, "name", ...)`. */
function calledInE2e(command, text) {
  return calledIn(command, text) || new RegExp(`\\binvoke\\s*\\(\\s*[A-Za-z_$][\\w$]*\\s*,\\s*${STR(command)}`).test(text);
}

/**
 * Problems with the commands, given the text of the app (`src/`, `plugins/`) and of the e2e files.
 * `commands` are `{ name, e2e }`.
 */
export function problemsOf(commands, app, e2e, exceptions = EXCEPTIONS) {
  const problems = [];
  const appText = app.join("\n");
  const e2eText = e2e.join("\n");
  for (const { name, e2e: gated } of commands) {
    if (name in exceptions) continue;
    const inApp = calledIn(name, appText);
    const inE2e = calledInE2e(name, e2eText);
    if (!inApp && !inE2e) problems.push(`${name}: no call in src/, plugins/ or e2e/ — remove it or list it in EXCEPTIONS with a reason`);
    else if (!inApp && !gated) problems.push(`${name}: called only from e2e/, so it must stand under #[cfg(feature = "e2e")] in generate_handler!`);
  }
  const names = commands.map((c) => c.name);
  for (const c of Object.keys(exceptions)) {
    if (!names.includes(c) || calledIn(c, appText) || calledInE2e(c, e2eText)) problems.push(`${c}: listed in EXCEPTIONS but is not a command or has a caller now — drop the exception`);
  }
  return problems;
}

/** The `generate_handler!` list against build.rs `COMMANDS`: any difference is a problem. */
export function manifestProblems(commands, manifest) {
  const names = commands.map((c) => c.name);
  const problems = [];
  for (const n of names) if (!manifest.includes(n)) problems.push(`${n}: in generate_handler! but not in build.rs COMMANDS`);
  for (const n of manifest) if (!names.includes(n)) problems.push(`${n}: in build.rs COMMANDS but not in generate_handler!`);
  return problems;
}

export function check(root = ROOT) {
  const commands = handlerCommands(readFileSync(join(root, HANDLER), "utf8"));
  const read = (d) => [...files(join(root, d))].map((f) => readFileSync(f, "utf8"));
  const app = ["src", "plugins"].flatMap(read);
  const problems = [
    ...manifestProblems(commands, manifestCommands(readFileSync(join(root, "src-tauri/build.rs"), "utf8"))),
    ...problemsOf(commands, app, read("e2e")),
  ];
  return { commands, problems };
}

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === "") {
  const { commands, problems } = check();
  if (problems.length) {
    console.error(`IPC commands without a caller (#148):\n${problems.map((p) => `  ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`ipc-callers: ${commands.length} commands, each has a caller`);
}
