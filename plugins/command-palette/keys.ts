// Alt+Enter on the highlighted command of the palette (#46): it does not run the command,
// it opens Settings → «Keys» at it. The core carries out the jump; the palette only says
// which command and what to search for. Covered by keys.test.ts.

import type { Command } from "@depesha/plugin-api";

/**
 * The command this press edits, if it is Alt+Enter. The command itself is not run:
 * Settings → «Keys» opens at it instead.
 */
export function editTarget(e: { key: string; altKey: boolean }, commands: Command[], active: number): Command | undefined {
  return e.key === "Enter" && e.altKey ? commands[active] : undefined;
}
