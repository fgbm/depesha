import { describe, expect, it } from "vitest";
import { compareRows, presetOf, reversed, sameSort, senderKey, sortText, subjectKey, PRESETS } from "./sort";
import type { MessageRow } from "./types";

function row(id: number, over: Partial<MessageRow> & { name?: string; seen?: boolean; flagged?: boolean }): MessageRow {
  return {
    id,
    account_id: "a",
    folder: "INBOX",
    uid: id,
    message_id: null,
    in_reply_to: null,
    references: [],
    subject: "",
    from: { name: over.name ?? null, email: `${id}@x` },
    to: [],
    cc: [],
    reply_to: [],
    date: 0,
    size: 0,
    flags: { seen: over.seen ?? true, answered: false, flagged: over.flagged ?? false, draft: false, deleted: false },
    has_attachments: false,
    thread: "",
    bulk: false,
    thread_count: 1,
    thread_date: 0,
    thread_senders: [],
    thread_draft: false,
    snoozed_until: null,
    followup_due: null,
    ...over,
  } as MessageRow;
}

describe("sort keys", () => {
  it("fold case and ё, drop quotes and reply prefixes like the cache", () => {
    expect(sortText(" «Ёлкин» ")).toBe("елкин");
    expect(subjectKey("RE: Fwd:  Отчёт  за май")).toBe("отчет за май");
    expect(subjectKey("Re[2]: Счёт")).toBe("счет");
    expect(subjectKey("Перенос: среда")).toBe("перенос: среда");
    expect(senderKey(row(1, { name: "  " }))).toBe("1@x");
  });
});

describe("compareRows", () => {
  const rows = [
    row(1, { name: "Борис", date: 300, seen: false }),
    row(2, { name: "анна", date: 100 }),
    row(3, { name: "Анна", date: 200, flagged: true }),
  ];
  const order = (sort: Parameters<typeof compareRows>[0]) => [...rows].sort(compareRows(sort)).map((r) => r.id);

  it("orders newest first by default and breaks ties by the newer letter", () => {
    expect(order([])).toEqual([1, 3, 2]);
    expect(order([{ by: "sender", desc: false }])).toEqual([3, 2, 1]);
  });

  it("puts important mail on top", () => {
    expect(order(presetOf([{ by: "unread", desc: true }, { by: "people", desc: true }, { by: "flagged", desc: true }, { by: "date", desc: true }])!.sort)).toEqual([1, 3, 2]);
    expect(order([{ by: "flagged", desc: true }])).toEqual([3, 1, 2]);
  });

  it("ignores relevance: only the cache knows it", () => {
    expect(order([{ by: "relevance", desc: false }])).toEqual([1, 3, 2]);
  });
});

describe("presets", () => {
  it("newest first is the empty order", () => {
    expect(sameSort([], [{ by: "date", desc: true }])).toBe(true);
    expect(presetOf([{ by: "date", desc: true }])?.id).toBe("date");
    expect(presetOf([{ by: "sender", desc: true }])).toBeUndefined();
    expect(PRESETS.map((p) => p.id)).toEqual(["date", "important", "sender", "subject", "size"]);
  });

  it("reverses every key", () => {
    expect(reversed([])).toEqual([{ by: "date", desc: false }]);
    expect(reversed([{ by: "sender", desc: false }, { by: "date", desc: true }])).toEqual([
      { by: "sender", desc: true },
      { by: "date", desc: false },
    ]);
  });
});
