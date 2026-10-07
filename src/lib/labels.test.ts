// Тесты чистых решений #42: права — действиями, группировка общих папок по владельцу,
// ключи и ярлыки меток. Слой без сети и DOM; покрывает src/lib/labels.ts.

import { describe, expect, it } from "vitest";
import { actionsOf, groupFolders, keywordForName, labelChips, labelNames, readOnly } from "./labels";
import type { FolderInfo, Label, NamespaceInfo, Rights } from "./types";

function rights(letters: string): Rights {
  const on = (c: string) => letters.includes(c);
  const known = "lrswipkxtea";
  return {
    lookup: on("l"),
    read: on("r"),
    seen: on("s"),
    write: on("w"),
    insert: on("i"),
    post: on("p"),
    create_child: on("k"),
    delete_folder: on("x"),
    delete_messages: on("t"),
    expunge: on("e"),
    administer: on("a"),
    other: [...letters].some((c) => !known.includes(c)),
  };
}

function folder(account: string, name: string, display = name): FolderInfo {
  return {
    account_id: account,
    name,
    display_name: display,
    delimiter: "/",
    role: null,
    selectable: true,
    hidden: false,
    total: 0,
    unread: 0,
  };
}

describe("права в действия", () => {
  it("полные права разрешают всё, кроме ничего", () => {
    const all = actionsOf(rights("lrswipkxtea"));
    expect(all.every((a) => a.allowed)).toBe(true);
    expect(all.map((a) => a.action)).toEqual([
      "read",
      "mark_seen",
      "write",
      "insert",
      "delete",
      "create_child",
      "delete_folder",
      "administer",
    ]);
    expect(readOnly(rights("lrswipkxtea"))).toBe(false);
  });

  it("общая папка только для чтения: чтение и отметка прочитанного", () => {
    const r = rights("rs");
    const by = Object.fromEntries(actionsOf(r).map((a) => [a.action, a.allowed]));
    expect(by.read).toBe(true);
    expect(by.mark_seen).toBe(true);
    expect(by.write).toBe(false);
    expect(by.insert).toBe(false);
    expect(by.delete).toBe(false);
    expect(readOnly(r)).toBe(true);
  });

  it("«без удаления»: всё, кроме удаления, и это не только чтение", () => {
    const r = rights("lrswik");
    const by = Object.fromEntries(actionsOf(r).map((a) => [a.action, a.allowed]));
    expect(by.delete).toBe(false);
    expect(by.write).toBe(true);
    expect(readOnly(r)).toBe(false);
  });

  it("неизвестные права не считаются разрешением и не ломают раскладку", () => {
    const r = rights("lrZ");
    expect(readOnly(r)).toBe(false);
    expect(actionsOf(r).find((a) => a.action === "delete")?.allowed).toBe(false);
  });
});

describe("группировка общих папок по владельцу", () => {
  const namespaces: NamespaceInfo = {
    personal: [{ prefix: "", delimiter: "/" }],
    other_users: [{ prefix: "Other Users/", delimiter: "/" }],
    shared: [{ prefix: "shared/", delimiter: "/" }],
  };

  it("свои, общие и чужие папки — по NAMESPACE", () => {
    const folders = [
      folder("a", "INBOX"),
      folder("a", "shared/Бухгалтерия"),
      folder("a", "Other Users/maria/Проекты"),
    ];
    const g = groupFolders(folders, namespaces);
    expect(g.mine.map((f) => f.name)).toEqual(["INBOX"]);
    expect(g.shared.map((f) => f.name)).toEqual(["shared/Бухгалтерия"]);
    expect(g.others).toEqual([{ owner: "maria", folders: [folder("a", "Other Users/maria/Проекты")] }]);
  });

  it("без NAMESPACE всё остаётся в общем списке", () => {
    const folders = [folder("a", "INBOX"), folder("a", "shared/Бухгалтерия")];
    const g = groupFolders(folders, null);
    expect(g.shared).toEqual([]);
    expect(g.others).toEqual([]);
    expect(g.mine.map((f) => f.name)).toEqual(["INBOX", "shared/Бухгалтерия"]);
  });
});

describe("метки: ключи и ярлыки", () => {
  it("ключ метки из имени: латиница — слаг, кириллица — устойчивый хеш", () => {
    expect(keywordForName("Client North")).toBe("depesha-client-north");
    expect(keywordForName("Счета")).toBe(keywordForName("Счета"));
    expect(keywordForName("Счета")).toMatch(/^depesha-[0-9a-f]{8}$/);
    expect(keywordForName("Счета")).not.toBe(keywordForName("Счёты"));
  });

  it("ключ — атом, без пробелов и кавычек", () => {
    for (const n of ["Счета", "Client North", "Клиент Север"]) {
      expect(keywordForName(n)).toMatch(/^[A-Za-z0-9-]+$/);
    }
  });

  it("ключи письма превращаются в названия меток; незнакомые ключи остаются как есть", () => {
    const labels: Label[] = [
      { name: "Счета", keyword: keywordForName("Счета"), color: "#d0573f" },
      { name: "Клиент Север", keyword: keywordForName("Клиент Север"), color: "#3f7fd0" },
    ];
    const chips = labelChips([keywordForName("Счета"), "$Forwarded"], labels, false);
    expect(chips).toEqual([{ name: "Счета", color: "#d0573f", local: false }]);
  });

  it("локальная метка помечена, даже когда ключ совпадает с серверным", () => {
    const labels: Label[] = [{ name: "Личное", keyword: keywordForName("Личное"), color: "#8a5ad0" }];
    const chips = labelChips([keywordForName("Личное")], labels, true);
    expect(chips).toEqual([{ name: "Личное", color: "#8a5ad0", local: true }]);
  });

  it("labelNames отдаёт названия без дублей", () => {
    const labels: Label[] = [
      { name: "Счета", keyword: keywordForName("Счета"), color: "#d0573f" },
      { name: "Счета", keyword: keywordForName("Счета"), color: "#d0573f" },
    ];
    expect(labelNames(["$Forwarded"], labels)).toEqual([]);
    expect(labelNames([keywordForName("Счета")], labels)).toEqual(["Счета"]);
  });
});
