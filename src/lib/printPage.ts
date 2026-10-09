// The page a letter is printed on: a sheet of its own, not the interface. A header (subject,
// From, To, Cc, date, the names of the files) over the body in the form the screen shows.
// Pure text in, text out; print.ts puts it into a hidden frame and asks the system to print.
// Covered by printPage.test.ts.

import { addrFull } from "./format";
import { MARKDOWN_CSS } from "./prose";
import type { Addr, BodyView, OpenedMessage } from "./types";

export interface PrintLabels {
  from: string;
  to: string;
  cc: string;
  date: string;
  attachments: string;
  noSubject: string;
}

export interface PrintLetter {
  subject: string;
  from: Addr | null;
  to: Addr[];
  cc: Addr[];
  /** The date as the reader shows it. */
  date: string;
  /** The names of the files, not of the pictures drawn in the text. */
  files: string[];
  /** The body as HTML, ready to put on the page. */
  body: string;
  /** Depesha drew this from Markdown: its bare tables get a grid. */
  markdown: boolean;
  /** Remote pictures print only when the screen shows them. */
  allowRemote: boolean;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The letter in the form the reader shows now, as the sheet needs it. `marked`: the Markdown with its code coloured. */
export function letterOf(msg: OpenedMessage, form: BodyView, allowRemote: boolean, date: string, marked?: string): PrintLetter {
  const { summary, html, markdown, text } = msg.view;
  const shown = form === "html" && html ? "html" : form === "markdown" && markdown ? "markdown" : "text";
  const body =
    shown === "html" ? (html ?? "") : shown === "markdown" ? MARKDOWN_CSS + (marked || (markdown ?? "")) : `<div class="plain">${esc(text ?? "")}</div>`;
  return {
    subject: summary.subject,
    from: summary.from,
    to: summary.to,
    cc: summary.cc,
    date,
    files: msg.view.attachments.filter((a) => !(a.inline && a.content_id)).map((a) => a.name),
    body,
    markdown: shown === "markdown",
    allowRemote,
  };
}

const list = (people: Addr[]) => people.map((a) => esc(addrFull(a))).join(", ");

// Always light, on white: a dark theme is for the screen. The Content-Security-Policy is the
// reading frame's (MailFrame.svelte): no scripts, pictures from the network only when allowed.
const CSS = `@page{margin:16mm}
:root{color-scheme:light}
html{background:#fff;color:#000}
body{margin:0;font:11pt/1.5 system-ui,"Segoe UI",Roboto,"Noto Sans",Arial,sans-serif;overflow-wrap:anywhere}
.head{border-bottom:1px solid #888;margin:0 0 14pt;padding:0 0 10pt;break-inside:avoid}
h1{font-size:17pt;line-height:1.25;margin:0 0 8pt}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2pt 12pt;margin:0;font-size:10pt}
dt{color:#555}
dd{margin:0}
.plain{white-space:pre-wrap}
img{max-width:100%;height:auto}
table{max-width:100%}
pre{white-space:pre-wrap}
blockquote{margin:0 0 0 4px;padding-left:12px;border-left:3px solid #bbb;color:#444}
a{color:inherit;text-decoration:underline}`;

const MARKDOWN_TABLES = `:root{--md-line:#bbb;--md-head:#eee}
table{border-collapse:collapse}
th,td{border:1px solid var(--md-line);padding:4px 10px}
th{background:var(--md-head);font-weight:600}`;

export function printPage(l: PrintLetter, labels: PrintLabels): string {
  const row = (name: string, value: string) => `<dt>${esc(name)}</dt><dd>${value}</dd>`;
  const subject = esc(l.subject.trim() || labels.noSubject);
  const rows = [
    l.from ? row(labels.from, esc(addrFull(l.from))) : "",
    l.to.length ? row(labels.to, list(l.to)) : "",
    l.cc.length ? row(labels.cc, list(l.cc)) : "",
    l.date ? row(labels.date, esc(l.date)) : "",
    l.files.length ? row(labels.attachments, l.files.map(esc).join(", ")) : "",
  ].join("\n");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${l.allowRemote ? "https: http:" : ""}; style-src 'unsafe-inline'; font-src data:">
<title>${subject}</title>
<style>
${CSS}
${l.markdown ? MARKDOWN_TABLES : ""}
</style></head><body>
<header class="head"><h1>${subject}</h1><dl>
${rows}
</dl></header>
<main>${l.body}</main>
</body></html>`;
}
