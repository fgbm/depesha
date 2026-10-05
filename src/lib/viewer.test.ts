import { describe, expect, it } from "vitest";
import { decodeText, parseCsv, pickViewer, type FileViewer } from "./viewer";
import { CORE_VIEWERS } from "./viewers";

const pick = (name: string, mime: string, viewers: FileViewer[] = CORE_VIEWERS) => pickViewer(viewers, name, mime)?.id ?? null;

describe("pickViewer", () => {
  it("goes by the extension first", () => {
    expect(pick("Счёт.PDF", "application/octet-stream")).toBe("pdf");
    expect(pick("readme.md", "text/plain")).toBe("markdown");
    expect(pick("отчёт.xlsx", "")).toBe("sheet");
    expect(pick("договор.docx", "")).toBe("docx");
    expect(pick("data.tsv", "")).toBe("csv");
    expect(pick("Обработка.bsl", "application/octet-stream")).toBe("text");
  });

  it("falls back to the type when the name says nothing", () => {
    expect(pick("scan", "image/jpeg")).toBe("image");
    expect(pick("Пересланное письмо", "message/rfc822")).toBe("letter");
    expect(pick("notes", "text/x-whatever")).toBe("text");
    expect(pick("noname", "application/octet-stream")).toBe(null);
  });

  it("never shows programs, whatever their type claims", () => {
    expect(pick("invoice.pdf.exe", "application/pdf")).toBe(null);
    expect(pick("run.js", "text/plain")).toBe(null);
  });

  it("lets a plugin take a format over or add one", () => {
    const plugin: FileViewer[] = [
      ...CORE_VIEWERS,
      { id: "better-pdf", extensions: ["pdf"], priority: 10, component: CORE_VIEWERS[0].component },
      { id: "dwg", extensions: ["dwg"], component: CORE_VIEWERS[0].component },
    ];
    expect(pick("a.pdf", "", plugin)).toBe("better-pdf");
    expect(pick("план.dwg", "", plugin)).toBe("dwg");
  });

  it("survives a plugin whose match throws", () => {
    const broken: FileViewer = { id: "broken", match: () => { throw new Error("x"); }, component: CORE_VIEWERS[0].component };
    expect(pick("a.png", "", [broken, ...CORE_VIEWERS])).toBe("image");
  });
});

describe("decodeText", () => {
  it("reads UTF-8 and falls back to Windows-1251", () => {
    expect(decodeText(new TextEncoder().encode("Привет")).text).toBe("Привет");
    expect(decodeText(new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])).text).toBe("Привет");
  });

  it("cuts long files at a character boundary", () => {
    const big = new TextEncoder().encode("я".repeat(3 * 1024 * 1024));
    const { text, cut } = decodeText(big);
    expect(cut).toBe(true);
    expect(text.endsWith("я")).toBe(true);
  });
});

describe("parseCsv", () => {
  it("guesses the delimiter and keeps quoted cells whole", () => {
    expect(parseCsv('Имя;Сумма\r\n"Иванов; И.";"1 000"\n"он сказал ""да""";2\n')).toEqual([
      ["Имя", "Сумма"],
      ["Иванов; И.", "1 000"],
      ['он сказал "да"', "2"],
    ]);
  });

  it("reads tab-separated files", () => {
    expect(parseCsv("a\tb\n1\t2", true)).toEqual([["a", "b"], ["1", "2"]]);
  });
});
