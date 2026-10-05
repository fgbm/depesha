import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "./i18n.svelte";
import { features, grouped, needsAttention, protocol, report, summary, unknown } from "./serverFeatures";

const MODERN =
  "IMAP4rev1 SASL-IR LOGIN-REFERRALS ID ENABLE IDLE SORT SORT=DISPLAY THREAD=REFERENCES THREAD=REFS MULTIAPPEND UNSELECT CHILDREN NAMESPACE UIDPLUS LIST-EXTENDED CONDSTORE QRESYNC ESEARCH MOVE STATUS=SIZE LITERAL+ SPECIAL-USE QUOTA APPENDLIMIT=52428800".split(
    " ",
  );
const OLD = "IMAP4rev1 LITERAL+ CONDSTORE QRESYNC ENABLE NAMESPACE CHILDREN AUTH=PLAIN".split(" ");
const time = () => "12:04";

beforeEach(() => {
  i18n.lang = "ru";
});

function row(rows: ReturnType<typeof features>, id: string) {
  return rows.find((r) => r.id === id)!;
}

describe("the server's features", () => {
  it("a modern server: what Depesha uses is used, the rest is told apart", () => {
    const rows = features(MODERN, { ok: true, answer: "ENABLED QRESYNC", at: 1 }, 120, time);
    for (const id of ["idle", "condstore", "qresync", "move", "uidplus", "specialUse", "quota", "statusSize", "literalPlus"]) {
      expect(row(rows, id).depesha, id).toBe("used");
      expect(row(rows, id).group, id).toBe("used");
    }
    expect(row(rows, "qresync").server).toBe("enabled");
    expect(row(rows, "id").depesha).toBe("notUsed");
    // Sorting and threads Depesha does itself: not needed, not "not used".
    expect(row(rows, "sortThread").depesha).toBe("notNeeded");
    expect(row(rows, "sortThread").names).toBe("SORT, SORT=DISPLAY, THREAD=REFERENCES, THREAD=REFS");
    expect(row(rows, "appendLimit").gives).toBe("Сервер примет письмо до 50 МБ.");
    // Compression is missing and nothing is lost: shown, not a warning.
    expect(row(rows, "compress").group).toBe("missing");
    expect(row(rows, "compress").important).toBe(false);
    expect(needsAttention(MODERN)).toBe(false);
    expect(summary(rows, 120)).toBe("Сервер умеет всё, что Депеше нужно для быстрой работы.");
    expect(grouped(rows).map((g) => g.group)).toEqual(["used", "unused", "missing"]);
  });

  it("an old server: what is missing says what it costs, with the real polling interval", () => {
    const rows = features(OLD, null, 120, time);
    const idle = row(rows, "idle");
    expect(idle.group).toBe("missing");
    expect(idle.depesha).toBe("polling");
    expect(idle.important).toBe(true);
    expect(idle.without).toContain("каждые 2 минуты");
    expect(row(rows, "move").depesha).toBe("workaround");
    expect(row(rows, "specialUse").depesha).toBe("byName");
    expect(row(rows, "quota").depesha).toBe("estimate");
    // QRESYNC offered, ENABLE not tried yet: offered and used.
    expect(row(rows, "qresync").group).toBe("used");
    expect(needsAttention(OLD)).toBe(true);
    expect(summary(rows, 300)).toBe("Сервер старый: новая почта приходит опросом раз в 5 минут, перенос писем — обходным путём. Подробности — в таблице.");
    expect(grouped(rows)[0].group).toBe("missing");
  });

  it("a refused ENABLE is not missing support", () => {
    const rows = features(OLD, { ok: false, answer: "ENABLE not permitted for this user", at: 1 }, 120, time);
    const q = row(rows, "qresync");
    expect(q.group).toBe("refused");
    expect(q.server).toBe("refused");
    expect(q.serverNote).toBe("ENABLE → NO, 12:04");
    expect(q.depesha).toBe("without");
    // CONDSTORE still works: QRESYNC implies it.
    expect(row(rows, "condstore").depesha).toBe("used");
  });

  it("IMAP4rev2 has some features without naming them; Depesha reads the names alone", () => {
    const rows = features(["IMAP4rev2", "IDLE"], null, 120, time);
    expect(protocol(["IMAP4rev2"])).toBe("IMAP4rev2");
    const move = row(rows, "move");
    expect(move.server).toBe("base");
    expect(move.group).toBe("unused");
    expect(move.depesha).toBe("workaround");
  });

  it("a rev2 server needs no explicit IDLE or MOVE: no yellow dot", () => {
    // Both are part of the base protocol, as the table shows them.
    expect(needsAttention(["IMAP4rev2"])).toBe(false);
    expect(needsAttention(["IMAP4rev2", "IDLE"])).toBe(false);
    // rev1 without MOVE still warns.
    expect(needsAttention(["IMAP4rev1", "IDLE"])).toBe(true);
  });

  it("unknown names are kept apart and the report has no secrets in it", () => {
    expect(unknown(MODERN)).toEqual(["SASL-IR", "LOGIN-REFERRALS", "MULTIAPPEND"]);
    const text = report("imap.example.com:993", "* OK [CAPABILITY IMAP4rev1] ready", OLD, { ok: false, answer: "no", at: 1 });
    expect(text).toContain("* CAPABILITY IMAP4rev1 LITERAL+");
    expect(text).toContain("S: NO no");
    expect(text).not.toMatch(/password|пароль/i);
  });

  it("no capabilities known yet: no dot", () => {
    expect(needsAttention(null)).toBe(false);
    expect(needsAttention([])).toBe(false);
  });
});
