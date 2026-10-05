// Word and spreadsheet attachments as HTML for the viewer. The libraries are heavy,
// so each loads the first time its kind of file is opened.
import DOMPurify from "dompurify";

/** At most this many rows of a sheet are drawn; the rest is said to be there. */
export const SHEET_ROWS = 5000;

/** Output of the libraries is shown in the sandboxed frame; it still goes through the sanitizer. */
function clean(html: string): string {
  return DOMPurify.sanitize(html, { FORCE_BODY: true, ADD_TAGS: ["style"], FORBID_TAGS: ["meta", "link", "base", "form"] });
}

export async function docxHtml(data: ArrayBuffer): Promise<string> {
  const { renderAsync } = await import("docx-preview");
  const body = document.createElement("div");
  const styles = document.createElement("div");
  await renderAsync(data, body, styles, {
    inWrapper: true,
    // Images inline as data: URLs, the only kind the frame loads.
    useBase64URL: true,
    ignoreLastRenderedPageBreak: true,
    renderComments: false,
    experimental: true,
  });
  return clean(styles.innerHTML + body.innerHTML);
}

export interface Sheet {
  name: string;
  html: string;
  /** Rows not drawn past `SHEET_ROWS`. */
  hidden: number;
}

export async function sheetsHtml(data: ArrayBuffer): Promise<Sheet[]> {
  const XLSX = await import("xlsx");
  const book = XLSX.read(data, { type: "array", cellDates: true, dense: true });
  return book.SheetNames.map((name) => {
    const ws = book.Sheets[name];
    let hidden = 0;
    if (ws["!ref"]) {
      const range = XLSX.utils.decode_range(ws["!ref"]);
      const rows = range.e.r - range.s.r + 1;
      if (rows > SHEET_ROWS) {
        hidden = rows - SHEET_ROWS;
        range.e.r = range.s.r + SHEET_ROWS - 1;
        ws["!ref"] = XLSX.utils.encode_range(range);
      }
    }
    const table = ws["!ref"] ? XLSX.utils.sheet_to_html(ws, { header: "", footer: "" }) : "";
    return { name, html: clean(SHEET_STYLE + table), hidden };
  });
}

const SHEET_STYLE = `<style>
body{margin:0}
table{border-collapse:collapse;font:13px/1.4 system-ui,"Segoe UI",Roboto,"Noto Sans",Arial,sans-serif;font-variant-numeric:tabular-nums}
td{border:1px solid #d9dde3;padding:3px 8px;white-space:pre-wrap;vertical-align:top;max-width:420px}
tr:first-child td{background:#f3f4f6;font-weight:600;position:sticky;top:0}
</style>`;
