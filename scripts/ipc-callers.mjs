// Guard against dead IPC commands (#148): every command registered in `generate_handler!` has a
// caller in the interface (`src/`), a built-in plugin (`plugins/`) or the e2e harness (`e2e/`).
// A call is the command's name as a string literal in a file that is not a unit test: a test that
// only checks a stub does not keep a command alive. An exception goes in EXCEPTIONS with a reason.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const HANDLER = "src-tauri/src/lib.rs";
const CALLERS = ["src", "plugins", "e2e"];

/** Commands with no caller in the places above. Empty today; add `name: "why it stays"`. */
export const EXCEPTIONS = {};

/** Command names in the `generate_handler![ ... ]` list, including the ones behind `#[cfg]`. */
export function handlerCommands(source) {
  const list = source.split("generate_handler![")[1]?.split("])")[0];
  if (list === undefined) throw new Error("generate_handler![...] not found");
  return [...list.matchAll(/^\s*(?:[a-z_]+::)+([a-z0-9_]+),\s*(?:\/\/.*)?$/gm)].map((m) => m[1]);
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(ts|js|mjs|svelte)$/.test(name) && !/\.test\./.test(name)) yield path;
  }
}

/** The commands without a caller, minus the declared exceptions. */
export function uncalled(commands, texts, exceptions = EXCEPTIONS) {
  const joined = texts.join("\n");
  return commands.filter((c) => !(c in exceptions) && !new RegExp(`["'\`]${c}["'\`]`).test(joined));
}

/** Exceptions that are not commands, or that got a caller: the list must not rot. */
export function staleExceptions(commands, texts, exceptions = EXCEPTIONS) {
  const joined = texts.join("\n");
  return Object.keys(exceptions).filter((c) => !commands.includes(c) || new RegExp(`["'\`]${c}["'\`]`).test(joined));
}

export function check(root = ROOT) {
  const commands = handlerCommands(readFileSync(join(root, HANDLER), "utf8"));
  const texts = CALLERS.flatMap((d) => [...files(join(root, d))]).map((f) => readFileSync(f, "utf8"));
  const problems = [];
  for (const c of uncalled(commands, texts)) problems.push(`${c}: no caller in src/, plugins/ or e2e/ — remove it or list it in EXCEPTIONS with a reason`);
  for (const c of staleExceptions(commands, texts)) problems.push(`${c}: listed in EXCEPTIONS but is not a command or has a caller now — drop the exception`);
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
