// Guards of the demo backend. The command list is compared with `generate_handler![…]` of the
// real backend, as `scripts/ipc-callers.mjs` does for the callers: every command must be
// either implemented for real or explicitly stubbed, and nothing else.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { IMPLEMENTED, STUBS, backend } from "./backend";
import { listen } from "./tauri/event";
import type { MessageRow, OpenedMessage } from "../lib/types";

/** The commands of `generate_handler![…]`, read the way `scripts/ipc-callers.mjs` reads them. */
function handlerCommands(): string[] {
  const source = readFileSync(fileURLToPath(new URL("../../src-tauri/src/lib.rs", import.meta.url)), "utf8");
  const list = source.split("generate_handler![")[1]?.split("])")[0];
  if (list === undefined) throw new Error("generate_handler![…] не найден");
  const bare = list.replace(/\/\/.*$/gm, "");
  return [...bare.matchAll(/((?:#\[[^\]]*\]\s*)*)(?:[A-Za-z_][A-Za-z0-9_]*::)+([A-Za-z0-9_]+)/g)].map((m) => m[2]);
}

const commands = handlerCommands();
const covered = new Set([...IMPLEMENTED, ...Object.keys(STUBS)]);

describe("список команд демо-бэкенда", () => {
  it("каждая команда generate_handler! либо реализована, либо заглушена", () => {
    expect(commands.filter((c) => !covered.has(c))).toEqual([]);
  });

  it("в демо нет команд, которых нет в generate_handler!", () => {
    expect([...covered].filter((c) => !commands.includes(c))).toEqual([]);
  });

  it("одна команда не и реализована, и заглушена", () => {
    expect(IMPLEMENTED.filter((c) => c in STUBS)).toEqual([]);
  });
});

describe("ответы демо-бэкенда", () => {
  it("неизвестная команда — предупреждение один раз и пустой ответ", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await backend.invoke("no_such_command")).toBeUndefined();
    expect(await backend.invoke("no_such_command")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("список писем и открытие письма работают", async () => {
    const rows = (await backend.invoke("messages", { query: { account_id: "w", folder: "INBOX", threads: true, limit: 200, offset: 0 } })) as MessageRow[];
    expect(rows.length).toBeGreaterThan(0);
    const opened = (await backend.invoke("message_open", { id: rows[0].id, allowRemote: false, seq: 1 })) as OpenedMessage;
    expect(opened.row.id).toBe(rows[0].id);
    expect((opened.view.text ?? "").length).toBeGreaterThan(0);
  });

  it("действие шлёт mail-changed", async () => {
    const seen: string[] = [];
    const off = await listen("mail-changed", () => seen.push("changed"));
    const rows = (await backend.invoke("messages", { query: { account_id: "w", folder: "INBOX", threads: false } })) as MessageRow[];
    await backend.invoke("set_flag", { ids: [rows[0].id], change: { flag: "flagged", value: true } });
    off();
    expect(seen.length).toBeGreaterThan(0);
  });
});
