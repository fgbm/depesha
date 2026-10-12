// Guards of the demo backend. The command list is compared with `generate_handler![…]` of the
// real backend, as `scripts/ipc-callers.mjs` does for the callers: every command must be
// either implemented for real or explicitly stubbed, and nothing else.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { IMPLEMENTED, STUBS, backend } from "./backend";
import { listen } from "./tauri/event";
import type { FolderCount, MessageRow, MessageView, OpenedMessage } from "../lib/types";

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

const rowsOf = async (query: Record<string, unknown>): Promise<MessageRow[]> =>
  (await backend.invoke("messages", { query })) as MessageRow[];
const byId = async (id: number): Promise<MessageRow | undefined> =>
  ((await backend.invoke("messages_by_id", { ids: [id] })) as MessageRow[]).find((r) => r.id === id);

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
    const rows = await rowsOf({ account_id: "w", folder: "INBOX", threads: true, limit: 200, offset: 0 });
    expect(rows.length).toBeGreaterThan(0);
    const opened = (await backend.invoke("message_open", { id: rows[0].id, allowRemote: false, seq: 1 })) as OpenedMessage;
    expect(opened.row.id).toBe(rows[0].id);
    expect((opened.view.text ?? "").length).toBeGreaterThan(0);
  });

  it("счётчик рассылок отвечает числом по списку", async () => {
    const n = (await backend.invoke("count_messages", {
      query: { account_id: "w", folder: "INBOX", bulk: true, unread_only: true },
    })) as number;
    expect(n).toBeGreaterThan(0);
    // Every newsletter of the list, read or not, is what the option itself shows.
    const all = (await backend.invoke("count_messages", { query: { account_id: "w", folder: "INBOX", bulk: true } })) as number;
    expect(all).toBeGreaterThanOrEqual(n);
  });

  it("действие шлёт mail-changed", async () => {
    const seen: string[] = [];
    const off = await listen("mail-changed", () => seen.push("changed"));
    const rows = await rowsOf({ account_id: "w", folder: "INBOX", threads: false });
    await backend.invoke("set_flag", { ids: [rows[0].id], change: { flag: "flagged", value: true } });
    off();
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe("цепочка не считает Корзину и Спам", () => {
  it("thread не включает удалённое письмо, счётчик строки списка тоже", async () => {
    const inbox = await rowsOf({ account_id: "w", folder: "INBOX", threads: false, limit: 500 });
    const chain = inbox.filter((r) => r.thread === "priemka");
    expect(chain.length).toBe(3);
    const victim = chain[chain.length - 1].id;

    const grouped = await rowsOf({ account_id: "w", folder: "INBOX", threads: true, limit: 500 });
    const row = grouped.find((r) => r.thread === "priemka");
    expect(row?.thread_count).toBe(5);

    const before = (await backend.invoke("thread", { id: victim })) as MessageRow[];
    expect(before.some((r) => r.id === victim)).toBe(true);

    await backend.invoke("delete_messages", { ids: [victim] });

    const after = (await backend.invoke("thread", { id: victim })) as MessageRow[];
    expect(after.some((r) => r.id === victim)).toBe(false);
    expect(after.length).toBe(before.length - 1);

    const groupedAfter = await rowsOf({ account_id: "w", folder: "INBOX", threads: true, limit: 500 });
    const rowAfter = groupedAfter.find((r) => r.thread === "priemka");
    expect(rowAfter?.thread_count).toBe(4);
  });
});

describe("действия с письмами", () => {
  it("перенос не помечает прочитанным, «Готово» — помечает", async () => {
    const inbox = await rowsOf({ account_id: "w", folder: "INBOX", threads: false, limit: 500 });
    const unread = inbox.filter((r) => !r.flags.seen);
    expect(unread.length).toBeGreaterThanOrEqual(2);
    const [moved, archived] = unread;

    await backend.invoke("move_messages", { ids: [moved.id], to: "Archive" });
    expect((await byId(moved.id))?.flags.seen).toBe(false);

    await backend.invoke("archive", { ids: [archived.id] });
    expect((await byId(archived.id))?.flags.seen).toBe(true);
  });
});

describe("мелкие команды", () => {
  it("letter_view отдаёт MessageView, не OpenedMessage", async () => {
    const view = (await backend.invoke("letter_view", { bytes: new Uint8Array([1, 2, 3]) })) as MessageView;
    expect(view.summary).toBeDefined();
    expect(typeof view.text).toBe("string");
  });

  it("folder_total считает в пределах ящика", async () => {
    const countFor = async (account: string) => (await rowsOf({ account_id: account, folder: "INBOX", threads: false, limit: 500 })).length;
    const work = (await backend.invoke("folder_total", { accountId: "w", folder: "INBOX" })) as FolderCount;
    const home = (await backend.invoke("folder_total", { accountId: "p", folder: "INBOX" })) as FolderCount;
    expect(work.total).toBe(await countFor("w"));
    expect(home.total).toBe(await countFor("p"));
  });

  it("окно письма сохраняет ?v= в ссылке", async () => {
    const assigned: string[] = [];
    vi.stubGlobal("location", { href: "http://demo/index.html?v=1.1:V", assign: (u: string) => assigned.push(String(u)) });
    await backend.invoke("message_window", { id: 1001, title: "письмо" });
    vi.unstubAllGlobals();
    const url = new URL(assigned[0]);
    expect(url.searchParams.get("message")).toBe("1001");
    expect(url.searchParams.get("v")).toBe("1.1:V");
  });
});
