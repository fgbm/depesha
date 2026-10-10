import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// The eslint guards of plugin imports (eslint.config.js) against the ways round them. The same
// holds for files in src/plugin-api/boundary.test.ts; this is the part that works while typing.
const eslint = new ESLint({ cwd: fileURLToPath(new URL("..", import.meta.url)) });

// One instance serves every case, but its first lintText loads the config and the plugins of
// the whole repository (about 2 s alone, over 5 s while cargo and the other checks run), which
// the 5 s limit of the first case could not take. The cost is paid here, once, under a limit
// of its own; the cases themselves take milliseconds and keep the default.
beforeAll(async () => {
  await eslint.lintText("export {};\n", { filePath: "plugins/snooze/zz.ts" });
}, 60_000);

async function rules(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map((m) => m.ruleId);
}

const IMPORTS = "no-restricted-imports";
const SYNTAX = "no-restricted-syntax";
const plugin = "plugins/snooze/zz.ts";
const test = "plugins/snooze/zz.test.ts";

describe("plugin imports, eslint", () => {
  it.each([
    ['import { t } from "../../src/lib/i18n.svelte";', plugin, IMPORTS],
    ['import "../../src/lib/i18n.svelte";', plugin, IMPORTS],
    ['import "./../../src/lib/i18n.svelte";', plugin, IMPORTS],
    ['import { x } from "../followups/due";', plugin, IMPORTS],
    ['export { x } from "../followups/due";', plugin, IMPORTS],
    ['import x from "lodash";', plugin, IMPORTS],
    ['export const f = () => import("../../src/lib/format");', plugin, SYNTAX],
    ['export const f = () => import("../followups/due");', plugin, SYNTAX],
    ['export const f = () => import("lodash");', plugin, SYNTAX],
    ["export const f = (name: string) => import(name);", plugin, SYNTAX],
    ["export const f = (name: string) => import(`./${name}`);", plugin, SYNTAX],
    ['import { x } from "../followups/due";', test, IMPORTS],
    ['import { f } from "../../src/lib/format";', test, IMPORTS],
    ['import "../../src/lib/format";', test, IMPORTS],
  ])("rejects %s (%s)", async (code, file, rule) => {
    expect(await rules(`${code}\n`, file)).toContain(rule);
  });

  it.each([
    ['import { when } from "@depesha/plugin-api";\nexport const w = when;', plugin],
    ['import Icon from "@lucide/svelte/icons/x";\nexport const i = Icon;', plugin],
    ['import "./styles";', plugin],
    ['export const f = () => import("./later");', plugin],
    ['import { row } from "../../src/lib/testing";\nexport const r = row;', test],
    ['import { i18n } from "../../src/lib/i18n.svelte";\nexport const i = i18n;', test],
    ['import { it } from "vitest";\nexport const i = it;', test],
  ])("lets through %s", async (code, file) => {
    const found = await rules(`${code}\n`, file);
    expect(found).not.toContain(IMPORTS);
    expect(found).not.toContain(SYNTAX);
  });
});
