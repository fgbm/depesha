// Тесты чистых решений #42: права — действиями, группировка общих папок по владельцу,
// ключи и ярлыки меток. Слой без сети и DOM; покрывает src/lib/labels.ts.

import { describe, expect, it } from "vitest";
import {
  actionsOf,
  canCheckLabels,
  groupFolders,
  keywordForName,
  labelChips,
  labelNames,
  labelState,
  labelStorage,
  pickAccount,
  readOnly,
  refusalOf,
  storageOf,
} from "./labels";
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

  it("проверка меток нужна права класть и удалять письма, а не только читать", () => {
    // `r` alone: reading is not enough — the check writes and deletes a test letter.
    expect(canCheckLabels(rights("lr"))).toBe(false);
    // `i` without `t`/`e`: the test letter could be added but not removed.
    expect(canCheckLabels(rights("lri"))).toBe(false);
    expect(canCheckLabels(rights("lrit"))).toBe(false);
    // Full rights.
    expect(canCheckLabels(rights("lrswipkxtea"))).toBe(true);
    // Rights unknown: do not refuse — the server answers for itself.
    expect(canCheckLabels(null)).toBe(true);
    expect(canCheckLabels(undefined)).toBe(true);
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

  it("корень namespace не остаётся в своих папках, а похожая своя папка — остаётся", () => {
    const folders = [
      folder("a", "INBOX"),
      folder("a", "shared"), // корень общего namespace
      folder("a", "shared/Бухгалтерия"),
      folder("a", "Other Users"), // корень чужого namespace
      folder("a", "Other Users/maria"), // корень чужих папок maria
      folder("a", "Other Users/maria/Проекты"),
      folder("a", "shared-архив"), // своя папка с похожим именем
    ];
    const g = groupFolders(folders, namespaces);
    expect(g.mine.map((f) => f.name)).toEqual(["INBOX", "shared-архив"]);
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
  it("ключ метки из имени: канонический слаг, иначе слаг с хешем, кириллица — хеш", () => {
    expect(keywordForName("client-north")).toBe("depesha-client-north");
    expect(keywordForName("Счета")).toBe(keywordForName("Счета"));
    expect(keywordForName("Счета")).toMatch(/^depesha-[0-9a-f]{8}$/);
    expect(keywordForName("Счета")).not.toBe(keywordForName("Счёты"));
  });

  it("имена, различающиеся лишь регистром или разделителями, получают разные ключи", () => {
    for (const [a, b] of [
      ["Work", "work"],
      ["a b", "a-b"],
      ["Client North", "client_north"],
    ]) {
      expect(keywordForName(a)).not.toBe(keywordForName(b));
    }
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

describe("отказ сервера после попытки (кадр 8)", () => {
  it("три разных причины — три разных уведомления", () => {
    // Нет прав: сервер отказал из-за прав.
    expect(refusalOf("no-rights")).toBe("no-rights");
    // Прочие ошибки сервера: не права.
    expect(refusalOf("other")).toBe("error");
    expect(refusalOf("not-found")).toBe("error");
    expect(refusalOf("folder-changed")).toBe("error");
    // Нет ответа: таймаут или обрыв.
    expect(refusalOf("network")).toBe("no-answer");
  });

  it("ошибки, из которых письмо не вернулось, уведомления не дают", () => {
    expect(refusalOf("auth")).toBeNull();
    expect(refusalOf("paused")).toBeNull();
    expect(refusalOf("cache-too-new")).toBeNull();
  });
});

describe("где хранятся метки (кадр 9)", () => {
  it("итог проверки задаёт строку у выбора меток", () => {
    expect(storageOf("saves")).toBe("server");
    expect(storageOf("not-saves")).toBe("local");
    expect(storageOf("claimed-but-lost")).toBe("unconfirmed");
    expect(storageOf(null)).toBe("unconfirmed");
    expect(storageOf(undefined)).toBe("unconfirmed");
  });
});

describe("выбор меток (кадр 10)", () => {
  const row = (account: string, folder: string, keywords: string[] = []) => ({ account_id: account, folder, keywords });

  it("ящик строк — один, иначе выбор невозможен; меток для этого не нужно", () => {
    // The item shows whenever the rows are of one mailbox, even with no labels yet.
    expect(pickAccount([row("a", "INBOX")])).toBe("a");
    expect(pickAccount([row("a", "INBOX"), row("a", "Sent")])).toBe("a");
    expect(pickAccount([row("a", "INBOX"), row("b", "INBOX")])).toBeNull();
    expect(pickAccount([])).toBeNull();
  });

  it("метка на всех, на части или ни на одной", () => {
    expect(labelState([row("a", "INBOX", ["k"])], "k")).toBe("all");
    expect(labelState([row("a", "INBOX", ["k"]), row("a", "INBOX")], "k")).toBe("some");
    expect(labelState([row("a", "INBOX")], "k")).toBe("none");
    expect(labelState([], "k")).toBe("none");
  });

  it("где хранятся: по проверке папки, иначе по PERMANENTFLAGS, иначе не подтверждено", () => {
    expect(labelStorage([{ label_check: "saves" }])).toBe("server");
    expect(labelStorage([{ label_check: "not-saves" }])).toBe("local");
    expect(labelStorage([{ labels_on_server: true }])).toBe("server");
    expect(labelStorage([{ labels_on_server: false }])).toBe("local");
    expect(labelStorage([{}])).toBe("unconfirmed");
    // «На сервере» — только когда так говорят все папки выбора.
    expect(labelStorage([{ label_check: "saves" }, { label_check: "not-saves" }])).toBe("unconfirmed");
    expect(labelStorage([])).toBe("unconfirmed");
  });
});
