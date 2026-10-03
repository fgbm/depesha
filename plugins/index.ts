// Built-in plugins, in the order they start. Each lives in its own folder and sees the
// core only through @depesha/plugin-api, so it can move to its own repository later.
import type { Plugin } from "@depesha/plugin-api";
import commandPalette from "./command-palette";
import followups from "./followups";
import newsletters from "./newsletters";
import preflight from "./preflight";
import sendLater from "./send-later";
import snooze from "./snooze";
import templates from "./templates";

export const BUILTIN: Plugin[] = [commandPalette, snooze, followups, newsletters, sendLater, templates, preflight];
